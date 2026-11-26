import { createDestinationStationJourney } from '@lib/commute-rules.js'
import type {
  Coordinates,
  OneMapAccount,
  QualifiedStop,
  StopInventory,
  Workplace,
} from '@lib/commute-types.js'
import { findRailStationById, validatePostalCode } from '@lib/inventory.js'
import type { StopListKindFilter } from '@lib/journey-format.js'
import {
  OneMapAuthError,
  resolvePostalWorkplace,
  signInToOneMap,
} from '@lib/onemap-client.js'
import { getDefaultSearchDate } from '@lib/singapore-calendar.js'
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
  renderStationOptions,
  renderStatusBadge,
} from './dom-render.js'
import type { CommuteMapView } from './map-view.js'
import {
  candidatesWithinArea,
  createNeighbourhoodPreview,
  type NeighbourhoodPreview,
} from './neighbourhood-preview.js'
import { planInWorker } from './plan-in-worker.js'

export interface AreaCheckState {
  readonly checkedDepartures: Set<string>
  checksPerformed: number
  hasRun: boolean
}
export interface AppState {
  inventory: StopInventory | null
  networkText: string | null
  account: OneMapAccount | null
  workplace: Workplace | null
  matches: readonly QualifiedStop[]
  selectedStopId: string | null
  kindFilter: StopListKindFilter
  textFilter: string
  isSearching: boolean
  abortController: AbortController | null
  preview: NeighbourhoodPreview | null
  selectedArea: Coordinates | null
  areaCheck: AreaCheckState | null
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
    state.networkText !== null &&
    !state.isSearching
  renderConnectivityState(els, online, canStart)
  els.checkAreaButton.disabled =
    !canStart || !state.selectedArea || state.areaCheck?.hasRun !== false
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
  invalidatePreview(ctx)
  ctx.state.account = null
  syncAccountUi(ctx)
}

const stopAreaCheck = (ctx: AppContext): void => {
  if (!ctx.state.preview || !ctx.state.isSearching) return
  ctx.state.abortController?.abort()
  ctx.state.abortController = null
  ctx.state.isSearching = false
  ctx.els.stopAreaButton.hidden = true
  ctx.els.areaResult.hidden = false
  ctx.els.areaResult.textContent = `Stopped. This area is not confirmed by these checks. ${String(ctx.state.areaCheck?.checksPerformed ?? 0)} checks performed.`
  ctx.els.liveStatusRegion.textContent = ctx.els.areaResult.textContent
  syncConnectivity(ctx)
}

const resetAreaSelection = (ctx: AppContext): void => {
  stopAreaCheck(ctx)
  if (ctx.state.areaCheck) {
    ctx.state.areaCheck.checksPerformed = 0
    ctx.state.areaCheck.hasRun = false
  }
  ctx.els.areaResult.hidden = true
  ctx.els.areaResult.textContent = ''
  ctx.els.areaJourney.hidden = true
  ctx.els.resultStatusTag.textContent = 'Estimated preview'
  ctx.els.checkAreaButton.disabled = !navigator.onLine || !ctx.state.account
  selectStop(ctx, null)
}

export const stopActiveSearch = (ctx: AppContext): void => {
  if (ctx.state.preview && ctx.state.isSearching) {
    stopAreaCheck(ctx)
  } else {
    invalidatePreview(ctx)
  }
}

export const refreshAreaStopPicker = (ctx: AppContext): void => {
  const { els, state } = ctx
  const query = els.areaStopFilter.value.trim().toLowerCase()
  const stops = (state.inventory?.stops ?? []).filter((stop) =>
    `${stop.id} ${stop.name}`.toLowerCase().includes(query),
  )
  renderStationOptions(els.areaStopSelect, stops, '')
  els.areaStopSelect.selectedIndex = -1
}

export const selectArea = (
  ctx: AppContext,
  centre: Coordinates,
  label: string,
  focus = false,
): void => {
  const { els, mapView, state } = ctx
  if (!state.preview) {
    return
  }
  resetAreaSelection(ctx)
  state.selectedArea = centre
  const count = candidatesWithinArea(state.preview, centre).length
  mapView.setAreaSelection(centre, focus)
  els.areaSummary.textContent = `${label}: ${String(count)} estimated candidates within 500 m straight-line distance. Not a walking route; estimates are not verified journeys.`
}

export const invalidatePreview = (ctx: AppContext): void => {
  const { els, mapView, state } = ctx
  const wasActive = state.preview !== null || state.isSearching
  state.abortController?.abort()
  state.abortController = null
  state.isSearching = false
  state.preview = null
  state.selectedArea = null
  els.previewPanel.hidden = true
  state.areaCheck = null
  els.stopAreaButton.hidden = true
  els.checkAreaButton.disabled = true
  els.areaResult.textContent = ''
  els.areaJourney.hidden = true
  els.stopSearchButton.hidden = true
  mapView.clearPreview()
  if (wasActive) {
    state.workplace = null
    state.matches = []
    mapView.clearStops()
    mapView.setWorkplace(null)
    selectStop(ctx, null)
    renderCounters(els, 0, 0, 0)
    renderStatusBadge(els.resultStatusTag, 'idle')
    els.activeConstraintsSummary.textContent =
      'Submit the current workplace and constraints to preview estimates.'
    els.liveStatusRegion.textContent = 'Preview cleared.'
  }
  syncConnectivity(ctx)
}

const displayPreview = (
  ctx: AppContext,
  preview: NeighbourhoodPreview,
): void => {
  const { els, mapView, state } = ctx
  state.preview = preview
  state.areaCheck = {
    checkedDepartures: new Set(),
    checksPerformed: 0,
    hasRun: false,
  }
  state.workplace = preview.workplace
  state.matches = []
  mapView.clearStops()
  mapView.setWorkplace(preview.workplace)
  mapView.setPreview(preview.leads, preview.constraints.rideCapMinutes)
  if (preview.workplace.kind === 'station' && state.inventory) {
    const station = findRailStationById(
      state.inventory,
      preview.workplace.stationId,
    )
    if (station) {
      const match = {
        stop: station,
        journey: createDestinationStationJourney(
          station,
          preview.constraints.searchDate,
          preview.constraints.officeStart,
        ),
      }
      state.matches = [match]
      mapView.addQualifyingStop(match)
    }
  }
  renderConstraintsSummary(
    els,
    preview.workplace,
    preview.constraints.searchDate,
    preview.constraints.officeStart,
    preview.constraints.rideCapMinutes,
  )
  renderCounters(els, 0, 0, state.matches.length)
  selectStop(ctx, null)
  els.resultStatusTag.textContent = 'Estimated preview'
  els.resultStatusTag.className = 'status-tag status-tag--muted'
  const marginCount = preview.leads.filter(
    (lead) =>
      preview.constraints.rideCapMinutes * 60_000 - lead.estRideMs >= 600_000,
  ).length
  els.previewSummary.textContent = `${String(preview.leads.length)} estimated stops: ${String(marginCount)} at least 10 min below cap; ${String(preview.leads.length - marginCount)} less than 10 min below. No routing requests made.`
  els.liveStatusRegion.textContent = els.previewSummary.textContent
  els.areaSummary.textContent =
    'Choose a stop below or click the map to select a 500 m area.'
  els.areaStopFilter.value = ''
  refreshAreaStopPicker(ctx)
  els.previewPanel.hidden = false
}

const showPreviewError = (ctx: AppContext, error: unknown): void => {
  if (error instanceof OneMapAuthError) {
    ctx.state.account = null
    renderInlineError(ctx.els.authError, error.message)
    syncAccountUi(ctx)
  } else {
    renderInlineError(
      ctx.els.searchError,
      normalizeError(error, 'Unable to prepare preview.').message,
    )
  }
}

export const handleSearchSubmit = async (ctx: AppContext): Promise<void> => {
  const { els, state } = ctx
  const { inventory, networkText, account } = state
  if (!inventory || networkText === null || !account || state.isSearching) {
    return
  }
  invalidatePreview(ctx)
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
  const constraints = {
    searchDate: getDefaultSearchDate(Date.now()),
    officeStart,
    rideCapMinutes,
  }
  els.plannedSearchDate.textContent = constraints.searchDate
  const controller = new AbortController()
  state.abortController = controller
  state.isSearching = true
  syncConnectivity(ctx)
  els.stopSearchButton.hidden = false
  try {
    const workplace = await resolveWorkplaceFromForm(els, inventory, account)
    if (controller !== state.abortController) {
      return
    }
    state.matches = []
    mapViewForPlanning(ctx, workplace)
    const plan = await planInWorker(
      { inventory, networkText, workplace, constraints },
      controller.signal,
    )
    if (controller === state.abortController && plan) {
      displayPreview(
        ctx,
        createNeighbourhoodPreview(plan, workplace, constraints),
      )
    }
  } catch (error) {
    if (controller !== state.abortController) {
      return
    }
    showPreviewError(ctx, error)
  } finally {
    if (controller === state.abortController) {
      state.isSearching = false
      state.abortController = null
      els.stopSearchButton.hidden = true
      syncConnectivity(ctx)
    }
  }
}

const mapViewForPlanning = (ctx: AppContext, workplace: Workplace): void => {
  ctx.mapView.clearStops()
  ctx.mapView.setWorkplace(workplace)
  selectStop(ctx, null)
  renderCounters(ctx.els, 0, 0, 0)
  renderStatusBadge(ctx.els.resultStatusTag, 'planning')
  ctx.els.liveStatusRegion.textContent =
    'Planning local estimates. No routing requests.'
}
