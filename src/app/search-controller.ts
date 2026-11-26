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
  setMobileView,
} from './dom-render.js'
import type { CommuteMapView } from './map-view.js'
import {
  candidatesWithinArea,
  createNeighbourhoodPreview,
  hasTenMinuteMargin,
  type NeighbourhoodPreview,
} from './neighbourhood-preview.js'
import { planInWorker } from './plan-in-worker.js'

export interface AreaCheckState {
  readonly checkedDepartures: Set<string>
  readonly completedDepartures: Set<string>
  checksPerformed: number
  hasRun: boolean
  hasMore: boolean
}
export interface AppState {
  inventory: StopInventory | null
  networkText: string | null
  account: OneMapAccount | null
  signingIn: boolean
  matches: readonly QualifiedStop[]
  selectedStopId: string | null
  kindFilter: StopListKindFilter
  textFilter: string
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
    state.inventory !== null &&
    state.networkText !== null &&
    state.abortController === null
  renderConnectivityState(els, online, canStart, state.signingIn)
  const canCheck = canStart && state.account !== null
  els.checkAreaButton.disabled =
    !canCheck || !state.selectedArea || state.areaCheck?.hasRun !== false
  els.checkAreaButton.hidden = state.areaCheck?.hasRun === true
  els.checkMoreButton.hidden =
    !state.areaCheck?.hasMore || state.abortController !== null
  els.checkMoreButton.disabled = !canCheck
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
  if (state.signingIn) return
  state.signingIn = true
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
    els.startSearchButton.focus()
  } catch (error) {
    renderInlineError(
      els.authError,
      normalizeError(error, 'Couldn’t sign in to OneMap.').message,
    )
  } finally {
    state.signingIn = false
    syncConnectivity(ctx)
  }
}

export const handleSignOut = (ctx: AppContext): void => {
  invalidatePreview(ctx)
  ctx.state.account = null
  syncAccountUi(ctx)
}

export const showOutcome = (ctx: AppContext, message: string): void => {
  const { els, state } = ctx
  const count = state.areaCheck?.checksPerformed ?? 0
  const checks = count === 1 ? 'check' : 'checks'
  const outcome = `${message} ${String(count)} ${checks} performed.`
  els.areaResult.hidden = false
  els.areaResult.textContent = outcome
  els.liveStatusRegion.textContent = outcome
}

const stopAreaCheck = (ctx: AppContext): void => {
  if (!ctx.state.preview || !ctx.state.abortController) return
  ctx.state.abortController.abort()
  ctx.state.abortController = null
  ctx.els.stopAreaButton.hidden = true
  showOutcome(ctx, 'Stopped. No further departures will be checked.')
  syncConnectivity(ctx)
}

const resetAreaSelection = (ctx: AppContext): void => {
  stopAreaCheck(ctx)
  if (ctx.state.areaCheck) {
    ctx.state.areaCheck.checksPerformed = 0
    ctx.state.areaCheck.hasRun = false
    ctx.state.areaCheck.hasMore = false
  }
  ctx.els.areaResult.hidden = true
  ctx.els.areaResult.textContent = ''
  ctx.els.checkMoreButton.hidden = true
  renderStatusBadge(ctx.els.resultStatusTag, 'preview')
  selectStop(ctx, null)
}

export const stopActiveSearch = (ctx: AppContext): void => {
  if (ctx.state.preview && ctx.state.abortController) {
    stopAreaCheck(ctx)
  } else {
    invalidatePreview(ctx)
  }
}

export const refreshAreaStopPicker = (ctx: AppContext): void => {
  const { els, state } = ctx
  const query = els.areaStopFilter.value.trim().toLowerCase()
  const stops = query
    ? (state.inventory?.stops ?? []).filter((stop) =>
        `${stop.id} ${stop.name}`.toLowerCase().includes(query),
      )
    : (state.preview?.leads.map((lead) => lead.stop) ?? [])
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
  if (!focus) {
    els.areaPicker.open = false
    refreshAreaStopPicker(ctx)
  }
  state.selectedArea = centre
  const count = candidatesWithinArea(state.preview, centre).length
  els.previewHeading.textContent = 'Check this area'
  els.checkMoreButton.textContent = 'Check more departures'
  mapView.setAreaSelection(centre, focus)
  els.previewSummary.hidden = true
  els.areaSummary.textContent = `${label}: ${String(count)} estimated candidates within 500 m. Straight-line distance, not a walking route.`
  syncConnectivity(ctx)
}

export const invalidatePreview = (ctx: AppContext): void => {
  const { els, mapView, state } = ctx
  const wasActive = state.preview !== null || state.abortController !== null
  state.abortController?.abort()
  state.abortController = null
  state.preview = null
  state.selectedArea = null
  els.previewPanel.hidden = true
  state.areaCheck = null
  els.stopAreaButton.hidden = true
  els.checkMoreButton.hidden = true
  els.checkAreaButton.disabled = true
  els.areaResult.textContent = ''
  els.stopSearchButton.hidden = true
  if (wasActive) {
    mapView.clearPreview()
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
    completedDepartures: new Set(),
    checksPerformed: 0,
    hasRun: false,
    hasMore: false,
  }
  state.matches = []
  mapView.clearStops()
  mapView.setWorkplace(preview.workplace)
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
    preview.constraints.officeStart,
    preview.constraints.rideCapMinutes,
  )
  renderCounters(els, 0, preview.leads.length, state.matches.length)
  selectStop(ctx, null)
  renderStatusBadge(els.resultStatusTag, 'preview')
  const marginCount = preview.leads.filter((lead) =>
    hasTenMinuteMargin(lead.estRideMs, preview.constraints.rideCapMinutes),
  ).length
  els.previewSummary.hidden = false
  els.previewHeading.textContent = 'Choose an area'
  const empty = preview.leads.length === 0
  els.editCommuteButton.hidden = !empty
  els.previewSummary.textContent = empty
    ? 'No estimated stops for this commute. Qualifying journeys may still exist.'
    : `${String(preview.leads.length)} estimated stops: ${String(marginCount)} at least 10 min below cap; ${String(preview.leads.length - marginCount)} less than 10 min below. Time bands are not confidence scores. No routing requests made.`
  els.liveStatusRegion.textContent = els.previewSummary.textContent
  els.areaSummary.textContent =
    'Tap the map or choose a stop below to place a 500 m circle. This selects the area without checking any journeys.'
  els.areaStopFilter.value = ''
  els.areaPicker.open = false
  refreshAreaStopPicker(ctx)
  els.previewPanel.hidden = false
  setMobileView('map')
  mapView.invalidateSize()
  mapView.setPreview(preview.leads, preview.constraints.rideCapMinutes)
  els.previewHeading.focus()
}

const showPreviewError = (
  ctx: AppContext,
  error: unknown,
  planning: boolean,
): void => {
  if (planning) renderStatusBadge(ctx.els.resultStatusTag, 'idle')
  ctx.els.liveStatusRegion.textContent = 'Unable to prepare preview.'
  if (error instanceof OneMapAuthError) {
    ctx.state.account = null
    renderInlineError(ctx.els.authError, error.message)
    syncAccountUi(ctx)
    openSignIn(ctx.els)
  } else {
    renderInlineError(
      ctx.els.searchError,
      normalizeError(error, 'Unable to prepare preview.').message,
    )
  }
}

const openSignIn = (els: AppElements): void => {
  els.accountPanel.hidden = false
  els.startSearchButton.setAttribute('aria-expanded', 'true')
  els.emailInput.focus()
}

export const handleSearchSubmit = async (ctx: AppContext): Promise<void> => {
  const { els, state } = ctx
  const { inventory, networkText, account } = state
  if (
    !inventory ||
    networkText === null ||
    state.abortController ||
    !navigator.onLine
  ) {
    return
  }
  if (!account) {
    openSignIn(els)
    return
  }
  invalidatePreview(ctx)
  renderInlineError(els.searchError, null)
  const rideCapMinutes = els.rideCapInput.valueAsNumber
  const officeStart = els.officeStartInput.value
  if (!els.rideCapInput.validity.valid) {
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
  const controller = new AbortController()
  state.abortController = controller
  syncConnectivity(ctx)
  els.stopSearchButton.hidden = false
  let planning = false
  try {
    const workplace = await resolveWorkplaceFromForm(els, inventory, account)
    if (controller !== state.abortController) {
      return
    }
    planning = true
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
    showPreviewError(ctx, error, planning)
  } finally {
    if (controller === state.abortController) {
      state.abortController = null
      els.stopSearchButton.hidden = true
      syncConnectivity(ctx)
    }
  }
}

const mapViewForPlanning = (ctx: AppContext, workplace: Workplace): void => {
  ctx.mapView.clearPreview()
  ctx.mapView.clearStops()
  ctx.mapView.setWorkplace(workplace)
  selectStop(ctx, null)
  renderCounters(ctx.els, 0, 0, 0)
  renderStatusBadge(ctx.els.resultStatusTag, 'planning')
  ctx.els.liveStatusRegion.textContent =
    'Planning local estimates. No routing requests.'
}
