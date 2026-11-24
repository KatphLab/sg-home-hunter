import type {
  CompletedSearchSnapshot,
  OneMapAccount,
  QualifiedStop,
  StopInventory,
  Workplace,
} from '@lib/commute-types.js'
import {
  filterRailStations,
  findRailStationById,
  parseStopInventory,
  validatePostalCode,
} from '@lib/inventory.js'
import type { StopListKindFilter } from '@lib/journey-format.js'
import {
  fetchTransitPlan,
  resolvePostalWorkplace,
  signInToOneMap,
} from '@lib/onemap-client.js'
import {
  loadCompletedResult,
  saveCompletedResult,
} from '@lib/saved-result-store.js'
import { runCommuteSearch, type SearchProgress } from '@lib/search-scheduler.js'
import { getDefaultSearchDate } from '@lib/singapore-calendar.js'
import { normalizeError } from '@utils/guards.js'
import {
  type AppElements,
  collectAppElements,
  renderConstraintsSummary,
  renderInventorySummary,
  renderQualifyingStopsList,
  renderSelectedStopCard,
  renderStationOptions,
  renderStatusBadge,
} from './dom-render.js'
import { CommuteMapView } from './map-view.js'

interface AppState {
  inventory: StopInventory | null
  account: OneMapAccount | null
  workplace: Workplace | null
  matches: readonly QualifiedStop[]
  selectedStopId: string | null
  kindFilter: StopListKindFilter
  textFilter: string
  isSearching: boolean
  abortController: AbortController | null
}

const setMobileView = (view: 'search' | 'map' | 'stops'): void => {
  document.body.dataset['mobileView'] = view
}

const updateConnectivityUi = (els: AppElements, state: AppState): void => {
  const online = navigator.onLine
  els.offlineBanner.hidden = online
  els.connectivityBadge.textContent = online ? 'Online' : 'Offline'
  els.connectivityBadge.className = online
    ? 'status-tag status-tag--online'
    : 'status-tag status-tag--offline'
  els.signinButton.disabled = !online
  els.startSearchButton.disabled =
    !online ||
    state.account === null ||
    state.inventory === null ||
    state.isSearching
}

const updateAccountUi = (els: AppElements, state: AppState): void => {
  const signedIn = state.account !== null
  els.signinForm.hidden = signedIn
  els.signedInBar.hidden = !signedIn
  if (state.account) {
    els.signedInEmail.textContent = state.account.email
    els.accountStatusPill.textContent = 'Connected'
    els.accountStatusPill.className = 'status-tag status-tag--ok'
  } else {
    els.accountStatusPill.textContent = 'Not connected'
    els.accountStatusPill.className = 'status-tag status-tag--muted'
  }
  updateConnectivityUi(els, state)
}

const selectStop = (
  els: AppElements,
  mapView: CommuteMapView,
  state: AppState,
  stopId: string | null,
): void => {
  state.selectedStopId = stopId
  mapView.setSelectedStop(stopId)
  const selected =
    stopId !== null
      ? (state.matches.find((entry) => entry.stop.id === stopId) ?? null)
      : null
  renderSelectedStopCard(els, selected)
  renderQualifyingStopsList(
    els,
    state.matches,
    state.kindFilter,
    state.textFilter,
    state.selectedStopId,
    (id) => selectStop(els, mapView, state, id),
  )
}

const applySnapshot = (
  els: AppElements,
  mapView: CommuteMapView,
  state: AppState,
  snapshot: CompletedSearchSnapshot,
): void => {
  state.workplace = snapshot.workplace
  state.matches = snapshot.matches
  mapView.clearStops()
  mapView.setWorkplace(snapshot.workplace)
  for (const entry of snapshot.matches) {
    mapView.addQualifyingStop(entry)
  }
  mapView.fitToMatches(snapshot.workplace, snapshot.matches)
  renderStatusBadge(els.resultStatusTag, 'saved')
  els.stopsTriedValue.textContent = `${snapshot.triedCount.toLocaleString('en-SG')} / ${snapshot.totalCount.toLocaleString('en-SG')}`
  els.stopsMatchedValue.textContent =
    snapshot.matches.length.toLocaleString('en-SG')
  renderConstraintsSummary(
    els,
    snapshot.workplace,
    snapshot.constraints.searchDate,
    snapshot.constraints.officeStart,
    snapshot.constraints.rideCapMinutes,
  )
  selectStop(els, mapView, state, null)
}

const getSelectedWorkplaceKind = (): 'postal' | 'station' => {
  const checked = document.querySelector<HTMLInputElement>(
    'input[name="workplace-kind"]:checked',
  )
  return checked?.value === 'station' ? 'station' : 'postal'
}

const resolveWorkplaceFromForm = (
  els: AppElements,
  inventory: StopInventory,
  account: OneMapAccount,
): Promise<Workplace> => {
  if (getSelectedWorkplaceKind() === 'station') {
    const stationId = els.stationSelect.value
    const station = findRailStationById(inventory, stationId)
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

const applyProgress = (
  els: AppElements,
  mapView: CommuteMapView,
  state: AppState,
  progress: SearchProgress,
): void => {
  state.matches = progress.matches
  if (progress.latestMatch) {
    mapView.addQualifyingStop(progress.latestMatch)
  }
  renderStatusBadge(
    els.resultStatusTag,
    'running',
    progress.passNumber,
    progress.totalPasses,
  )
  els.stopsTriedValue.textContent = `${progress.triedCount.toLocaleString('en-SG')} / ${progress.totalCount.toLocaleString('en-SG')}`
  els.stopsMatchedValue.textContent =
    progress.matchedCount.toLocaleString('en-SG')
  els.liveStatusRegion.textContent = `Pass ${String(progress.passNumber)} of ${String(progress.totalPasses)}: ${String(progress.triedCount)} of ${String(progress.totalCount)} stops tried, ${String(progress.matchedCount)} matching.`

  renderQualifyingStopsList(
    els,
    state.matches,
    state.kindFilter,
    state.textFilter,
    state.selectedStopId,
    (id) => selectStop(els, mapView, state, id),
  )
}

const handleSignIn = async (
  els: AppElements,
  state: AppState,
): Promise<void> => {
  els.authError.hidden = true
  els.signinButton.disabled = true
  try {
    const account = await signInToOneMap(
      els.emailInput.value,
      els.passwordInput.value,
    )
    els.passwordInput.value = ''
    state.account = account
    updateAccountUi(els, state)
  } catch (error) {
    els.authError.textContent = normalizeError(
      error,
      'Couldn’t sign in to OneMap.',
    ).message
    els.authError.hidden = false
  } finally {
    updateConnectivityUi(els, state)
  }
}

const finalizeSearchRun = (
  els: AppElements,
  mapView: CommuteMapView,
  state: AppState,
  inventory: StopInventory,
  workplace: Workplace,
  constraints: {
    readonly searchDate: string
    readonly officeStart: string
    readonly rideCapMinutes: number
  },
  result: {
    readonly status: 'completed' | 'partial'
    readonly authExpired: boolean
    readonly triedCount: number
    readonly totalCount: number
    readonly matches: readonly QualifiedStop[]
  },
): void => {
  state.isSearching = false
  state.abortController = null
  state.matches = result.matches
  els.stopSearchButton.hidden = true
  updateConnectivityUi(els, state)

  els.stopsTriedValue.textContent = `${result.triedCount.toLocaleString('en-SG')} / ${result.totalCount.toLocaleString('en-SG')}`
  els.stopsMatchedValue.textContent =
    result.matches.length.toLocaleString('en-SG')
  renderStatusBadge(els.resultStatusTag, result.status)

  if (result.matches.length > 0) {
    mapView.fitToMatches(workplace, result.matches)
  }

  if (result.authExpired) {
    state.account = null
    updateAccountUi(els, state)
    els.authError.textContent =
      'Your OneMap session expired. Sign in again to continue.'
    els.authError.hidden = false
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

const handleSearchSubmit = async (
  els: AppElements,
  mapView: CommuteMapView,
  state: AppState,
): Promise<void> => {
  if (!state.inventory || !state.account || state.isSearching) {
    return
  }
  els.searchError.hidden = true
  const rideCapMinutes = Number(els.rideCapInput.value)
  const officeStart = els.officeStartInput.value
  if (
    !Number.isInteger(rideCapMinutes) ||
    rideCapMinutes < 1 ||
    rideCapMinutes > 180
  ) {
    els.searchError.textContent =
      'Ride cap must be a whole number between 1 and 180 minutes.'
    els.searchError.hidden = false
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
    els.searchError.textContent = normalizeError(
      error,
      'Unable to resolve workplace.',
    ).message
    els.searchError.hidden = false
    return
  }

  const controller = new AbortController()
  state.isSearching = true
  state.abortController = controller
  state.workplace = workplace
  state.matches = []
  els.stopSearchButton.hidden = false
  updateConnectivityUi(els, state)

  mapView.clearStops()
  mapView.setWorkplace(workplace)
  renderConstraintsSummary(
    els,
    workplace,
    searchDate,
    officeStart,
    rideCapMinutes,
  )
  selectStop(els, mapView, state, null)

  const constraints = { searchDate, officeStart, rideCapMinutes }
  const account = state.account
  const result = await runCommuteSearch({
    inventory: state.inventory,
    workplace,
    constraints,
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
    onProgress: (progress) => applyProgress(els, mapView, state, progress),
  })

  finalizeSearchRun(
    els,
    mapView,
    state,
    state.inventory,
    workplace,
    constraints,
    result,
  )
}

const wireWorkplaceToggle = (els: AppElements): void => {
  const radios = document.querySelectorAll<HTMLInputElement>(
    'input[name="workplace-kind"]',
  )
  for (const radio of radios) {
    radio.addEventListener('change', () => {
      const isStation = getSelectedWorkplaceKind() === 'station'
      els.postalGroup.hidden = isStation
      els.stationGroup.hidden = !isStation
    })
  }
}

const wireFiltersAndTabs = (
  els: AppElements,
  mapView: CommuteMapView,
  state: AppState,
): void => {
  const chipButtons =
    document.querySelectorAll<HTMLButtonElement>('[data-kind-filter]')
  for (const btn of chipButtons) {
    btn.addEventListener('click', () => {
      const filter = btn.dataset['kindFilter']
      if (filter !== 'all' && filter !== 'rail' && filter !== 'bus') {
        return
      }
      state.kindFilter = filter
      for (const peer of chipButtons) {
        peer.classList.toggle('is-active', peer === btn)
      }
      renderQualifyingStopsList(
        els,
        state.matches,
        state.kindFilter,
        state.textFilter,
        state.selectedStopId,
        (id) => selectStop(els, mapView, state, id),
      )
    })
  }

  els.stopListFilterInput.addEventListener('input', () => {
    state.textFilter = els.stopListFilterInput.value
    renderQualifyingStopsList(
      els,
      state.matches,
      state.kindFilter,
      state.textFilter,
      state.selectedStopId,
      (id) => selectStop(els, mapView, state, id),
    )
  })

  const mobileTabs =
    document.querySelectorAll<HTMLButtonElement>('[data-mobile-tab]')
  for (const tab of mobileTabs) {
    tab.addEventListener('click', () => {
      const target = tab.dataset['mobileTab']
      if (target === 'search' || target === 'map' || target === 'stops') {
        setMobileView(target)
        if (target === 'map') {
          mapView.invalidateSize()
        }
      }
    })
  }
}

const bootstrap = async (): Promise<void> => {
  const els = collectAppElements()
  const state: AppState = {
    inventory: null,
    account: null,
    workplace: null,
    matches: [],
    selectedStopId: null,
    kindFilter: 'all',
    textFilter: '',
    isSearching: false,
    abortController: null,
  }

  const mapView = new CommuteMapView(els.mapContainer, (stopId) => {
    selectStop(els, mapView, state, stopId)
  })

  wireWorkplaceToggle(els)
  wireFiltersAndTabs(els, mapView, state)
  updateAccountUi(els, state)

  els.closeJourneyCardButton.addEventListener('click', () => {
    selectStop(els, mapView, state, null)
  })

  els.signinForm.addEventListener('submit', (event) => {
    event.preventDefault()
    void handleSignIn(els, state)
  })

  els.signoutButton.addEventListener('click', () => {
    state.account = null
    updateAccountUi(els, state)
  })

  els.searchForm.addEventListener('submit', (event) => {
    event.preventDefault()
    void handleSearchSubmit(els, mapView, state)
  })

  els.stopSearchButton.addEventListener('click', () => {
    state.abortController?.abort()
  })

  window.addEventListener('online', () => updateConnectivityUi(els, state))
  window.addEventListener('offline', () => updateConnectivityUi(els, state))

  const saved = loadCompletedResult(window.localStorage)
  if (saved) {
    applySnapshot(els, mapView, state, saved)
    setMobileView('map')
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {})
  }

  try {
    const response = await fetch('./data/stops.tsv')
    if (!response.ok) {
      throw new Error(`HTTP ${String(response.status)}`)
    }
    const inventory = parseStopInventory(await response.text())
    state.inventory = inventory
    renderInventorySummary(els, inventory, getDefaultSearchDate(Date.now()))
    renderStationOptions(
      els.stationSelect,
      filterRailStations(inventory, ''),
      '',
    )
    els.stationFilterInput.addEventListener('input', () => {
      const current = els.stationSelect.value
      renderStationOptions(
        els.stationSelect,
        filterRailStations(inventory, els.stationFilterInput.value),
        current,
      )
    })
    updateConnectivityUi(els, state)
  } catch (error) {
    els.inventoryBadge.textContent = 'Inventory unavailable'
    els.searchError.textContent = `Could not load stop inventory: ${normalizeError(error, 'fetch failed').message}`
    els.searchError.hidden = false
  }
}

void bootstrap()
