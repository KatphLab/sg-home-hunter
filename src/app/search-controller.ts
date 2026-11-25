import { runBackwardCommuteSearch } from '@lib/backward-search.js'
import type {
  CompletedSearchSnapshot,
  OneMapAccount,
  QualifiedStop,
  SearchConstraints,
  StopInventory,
  Workplace,
} from '@lib/commute-types.js'
import { findRailStationById, validatePostalCode } from '@lib/inventory.js'
import type { StopListKindFilter } from '@lib/journey-format.js'
import {
  fetchTransitPlan,
  OneMapAuthError,
  resolvePostalWorkplace,
  signInToOneMap,
} from '@lib/onemap-client.js'
import { saveCompletedResult } from '@lib/saved-result-store.js'
import type { SearchProgress, SearchRunResult } from '@lib/search-scheduler.js'
import { getDefaultSearchDate } from '@lib/singapore-calendar.js'
import type { TransitNetworkIndex } from '@lib/transit-network.js'
import { normalizeError } from '@utils/guards.js'
import {
  type AppElements,
  getSelectedWorkplaceKind,
  renderAccountState,
  renderConnectivityState,
  renderConstraintsSummary,
  renderCounters,
  renderInlineError,
  renderQualifyingStopsList,
  renderSelectedStopCard,
  renderStatusBadge,
} from './dom-render.js'
import type { CommuteMapView } from './map-view.js'

export interface AppState {
  inventory: StopInventory | null
  networkIndex: TransitNetworkIndex | null
  account: OneMapAccount | null
  workplace: Workplace | null
  matches: readonly QualifiedStop[]
  selectedStopId: string | null
  kindFilter: StopListKindFilter
  textFilter: string
  isSearching: boolean
  abortController: AbortController | null
}

export interface AppContext {
  readonly els: AppElements
  readonly mapView: CommuteMapView
  readonly state: AppState
}

export const syncConnectivity = (ctx: AppContext): void => {
  const { els, state } = ctx
  const online = navigator.onLine
  const canStart =
    online &&
    state.account !== null &&
    state.inventory !== null &&
    state.networkIndex !== null &&
    !state.isSearching
  renderConnectivityState(els, online, canStart)
}

export const syncAccountUi = (ctx: AppContext): void => {
  renderAccountState(ctx.els, ctx.state.account)
  syncConnectivity(ctx)
}

export const refreshStopList = (ctx: AppContext): void => {
  const { els, state } = ctx
  renderQualifyingStopsList(
    els,
    state.matches,
    state.kindFilter,
    state.textFilter,
    state.selectedStopId,
    (id) => selectStop(ctx, id),
  )
}

export const selectStop = (ctx: AppContext, stopId: string | null): void => {
  const { els, mapView, state } = ctx
  state.selectedStopId = stopId
  mapView.setSelectedStop(stopId)
  const selected =
    stopId !== null
      ? (state.matches.find((entry) => entry.stop.id === stopId) ?? null)
      : null
  renderSelectedStopCard(els, selected)
  refreshStopList(ctx)
}

export const applySnapshot = (
  ctx: AppContext,
  snapshot: CompletedSearchSnapshot,
): void => {
  const { els, mapView, state } = ctx
  state.workplace = snapshot.workplace
  state.matches = snapshot.matches
  mapView.clearStops()
  mapView.setWorkplace(snapshot.workplace)
  for (const entry of snapshot.matches) {
    mapView.addQualifyingStop(entry)
  }
  mapView.fitToMatches(snapshot.workplace, snapshot.matches)
  renderStatusBadge(els.resultStatusTag, 'saved')
  renderCounters(
    els,
    snapshot.triedCount,
    snapshot.totalCount,
    snapshot.matches.length,
  )
  renderConstraintsSummary(
    els,
    snapshot.workplace,
    snapshot.constraints.searchDate,
    snapshot.constraints.officeStart,
    snapshot.constraints.rideCapMinutes,
  )
  selectStop(ctx, null)
}

const resolveWorkplaceFromForm = (
  els: AppElements,
  inventory: StopInventory,
  account: OneMapAccount,
): Promise<Workplace> => {
  if (getSelectedWorkplaceKind() === 'station') {
    const station = findRailStationById(inventory, els.stationSelect.value)
    if (!station) {
      return Promise.reject(
        new Error('Select a valid MRT or LRT station from the list.'),
      )
    }
    return Promise.resolve({
      kind: 'station',
      stationId: station.id,
      label: `${station.id} ${station.name}`,
      point: station.point,
    })
  }
  const postalCode = validatePostalCode(els.postalInput.value)
  if (!postalCode) {
    return Promise.reject(
      new Error('Enter a valid 6-digit Singapore postal code.'),
    )
  }
  return resolvePostalWorkplace(postalCode, account.accessToken)
}

const applyProgress = (ctx: AppContext, progress: SearchProgress): void => {
  const { els, mapView, state } = ctx
  const previousCount = state.matches.length
  state.matches = progress.matches
  for (const match of progress.matches.slice(previousCount)) {
    mapView.addQualifyingStop(match)
  }
  renderStatusBadge(
    els.resultStatusTag,
    'running',
    progress.passNumber,
    progress.totalPasses,
  )
  renderCounters(
    els,
    progress.triedCount,
    progress.totalCount,
    progress.matchedCount,
  )
  els.liveStatusRegion.textContent = `Pass ${String(progress.passNumber)} of ${String(progress.totalPasses)}: ${String(progress.triedCount)} of ${String(progress.totalCount)} stops tried, ${String(progress.matchedCount)} matching.`
  if (progress.matchedCount !== previousCount) {
    refreshStopList(ctx)
  }
}

const finalizeSearchRun = (
  ctx: AppContext,
  inventory: StopInventory,
  workplace: Workplace,
  constraints: SearchConstraints,
  result: SearchRunResult,
): void => {
  const { els, mapView, state } = ctx
  state.isSearching = false
  state.abortController = null
  state.matches = result.matches
  els.stopSearchButton.hidden = true
  syncConnectivity(ctx)

  renderCounters(
    els,
    result.triedCount,
    result.totalCount,
    result.matches.length,
  )
  renderStatusBadge(els.resultStatusTag, result.status)

  if (result.matches.length > 0) {
    mapView.fitToMatches(workplace, result.matches)
  }

  if (result.authExpired) {
    state.account = null
    syncAccountUi(ctx)
    renderInlineError(
      els.authError,
      'Your OneMap session expired. Sign in again to continue.',
    )
  }

  if (result.status === 'completed') {
    saveCompletedResult(window.localStorage, {
      version: 1,
      completedAtIso: new Date().toISOString(),
      inventoryDate: inventory.inventoryDate,
      workplace,
      constraints,
      triedCount: result.triedCount,
      totalCount: result.totalCount,
      matches: result.matches,
    })
  }
}

export const handleSignIn = async (ctx: AppContext): Promise<void> => {
  const { els, state } = ctx
  renderInlineError(els.authError, null)
  els.signinButton.disabled = true
  try {
    const account = await signInToOneMap(
      els.emailInput.value,
      els.passwordInput.value,
    )
    els.passwordInput.value = ''
    state.account = account
    syncAccountUi(ctx)
  } catch (error) {
    renderInlineError(
      els.authError,
      normalizeError(error, 'Couldn’t sign in to OneMap.').message,
    )
  } finally {
    syncConnectivity(ctx)
  }
}

export const handleSignOut = (ctx: AppContext): void => {
  ctx.state.account = null
  syncAccountUi(ctx)
}

export const stopActiveSearch = (ctx: AppContext): void => {
  ctx.state.abortController?.abort()
}

export const handleSearchSubmit = async (ctx: AppContext): Promise<void> => {
  const { els, mapView, state } = ctx
  if (
    !state.inventory ||
    !state.networkIndex ||
    !state.account ||
    state.isSearching
  ) {
    return
  }
  renderInlineError(els.searchError, null)
  const rideCapMinutes = Number(els.rideCapInput.value)
  const officeStart = els.officeStartInput.value
  if (
    !Number.isInteger(rideCapMinutes) ||
    rideCapMinutes < 1 ||
    rideCapMinutes > 180
  ) {
    renderInlineError(
      els.searchError,
      'Ride cap must be a whole number between 1 and 180 minutes.',
    )
    return
  }

  const searchDate = getDefaultSearchDate(Date.now())
  els.plannedSearchDate.textContent = searchDate

  let workplace: Workplace
  try {
    workplace = await resolveWorkplaceFromForm(
      els,
      state.inventory,
      state.account,
    )
  } catch (error) {
    if (error instanceof OneMapAuthError) {
      state.account = null
      syncAccountUi(ctx)
      renderInlineError(els.authError, error.message)
      return
    }
    renderInlineError(
      els.searchError,
      normalizeError(error, 'Unable to resolve workplace.').message,
    )
    return
  }

  const controller = new AbortController()
  state.isSearching = true
  state.abortController = controller
  state.workplace = workplace
  state.matches = []
  els.stopSearchButton.hidden = false
  syncConnectivity(ctx)

  mapView.clearStops()
  mapView.setWorkplace(workplace)
  renderConstraintsSummary(
    els,
    workplace,
    searchDate,
    officeStart,
    rideCapMinutes,
  )
  selectStop(ctx, null)

  const constraints = { searchDate, officeStart, rideCapMinutes }
  const account = state.account
  const result = await runBackwardCommuteSearch({
    inventory: state.inventory,
    networkIndex: state.networkIndex,
    workplace,
    constraints,
    probeUncoveredStops: true,
    signal: controller.signal,
    routeStop: async (stop, departureTimeHHMMSS, signal) => {
      const plan = await fetchTransitPlan({
        start: stop.point,
        end: workplace.point,
        searchDate,
        departureTimeHHMMSS,
        accessToken: account.accessToken,
        signal,
      })
      return plan.itineraries
    },
    onProgress: (progress) => applyProgress(ctx, progress),
  })

  finalizeSearchRun(ctx, state.inventory, workplace, constraints, result)
}
