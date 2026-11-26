import { parseStopInventory } from '@lib/inventory.js'
import { loadCompletedResult } from '@lib/saved-result-store.js'
import { normalizeError } from '@utils/guards.js'
import { checkSelectedArea } from './area-check.js'
import { applySnapshot } from './area-result.js'
import {
  collectAppElements,
  getSelectedWorkplaceKind,
  renderCommuteHint,
  renderInlineError,
  setMobileView,
} from './dom-render.js'
import { CommuteMapView } from './map-view.js'
import {
  type AppContext,
  type AppState,
  handleSearchSubmit,
  handleSignIn,
  handleSignOut,
  invalidatePreview,
  refreshAreaStopPicker,
  refreshStopList,
  selectArea,
  selectStop,
  stopActiveSearch,
  syncAccountUi,
  syncConnectivity,
} from './search-controller.js'
import { wireStationAutocomplete } from './station-autocomplete.js'

const wireUiEvents = (ctx: AppContext): void => {
  const { els, mapView, state } = ctx

  renderCommuteHint(els)
  els.officeStartInput.addEventListener('input', () => renderCommuteHint(els))
  els.rideCapInput.addEventListener('input', () => renderCommuteHint(els))
  els.editCommuteButton.addEventListener('click', () => {
    setMobileView('search')
    const input =
      getSelectedWorkplaceKind() === 'station'
        ? els.stationInput
        : els.postalInput
    input.focus()
  })
  const invalidateSearchInput = (event: Event): void => {
    if (event.target !== els.stationInput) invalidatePreview(ctx)
  }
  els.searchForm.addEventListener('input', invalidateSearchInput)
  els.searchForm.addEventListener('change', invalidateSearchInput)
  els.areaStopFilter.addEventListener('input', () => refreshAreaStopPicker(ctx))
  els.areaStopSelect.addEventListener('change', () => {
    const stop = state.inventory?.stops.find(
      (entry) => entry.id === els.areaStopSelect.value,
    )
    if (stop) {
      selectArea(ctx, stop.point, `${stop.id} ${stop.name}`, true)
    }
  })
  for (const radio of document.querySelectorAll<HTMLInputElement>(
    'input[name="workplace-kind"]',
  )) {
    radio.addEventListener('change', () => {
      const isStation = getSelectedWorkplaceKind() === 'station'
      els.postalGroup.hidden = isStation
      els.stationGroup.hidden = !isStation
    })
  }

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
      refreshStopList(ctx)
    })
  }

  els.stopListFilterInput.addEventListener('input', () => {
    state.textFilter = els.stopListFilterInput.value
    refreshStopList(ctx)
  })

  for (const tab of document.querySelectorAll<HTMLButtonElement>(
    '[data-mobile-tab]',
  )) {
    tab.addEventListener('click', () => {
      const target = tab.dataset['mobileTab']
      if (target === 'search' || target === 'map' || target === 'stops') {
        setMobileView(target)
        if (target === 'map') {
          mapView.invalidateSize()
        }
        if (target === 'search') els.searchHeading.focus()
      }
    })
  }

  els.closeJourneyCardButton.addEventListener('click', () =>
    selectStop(ctx, null),
  )
  els.signinForm.addEventListener('submit', (event) => {
    event.preventDefault()
    void handleSignIn(ctx)
  })
  els.signoutButton.addEventListener('click', () => handleSignOut(ctx))
  els.searchForm.addEventListener('submit', (event) => {
    event.preventDefault()
    void handleSearchSubmit(ctx)
  })
  for (const button of [els.stopSearchButton, els.stopAreaButton]) {
    button.addEventListener('click', () => stopActiveSearch(ctx))
  }
  for (const button of [els.checkAreaButton, els.checkMoreButton]) {
    button.addEventListener('click', () => void checkSelectedArea(ctx))
  }
  window.addEventListener('online', () => syncConnectivity(ctx))
  window.addEventListener('offline', () => syncConnectivity(ctx))
}

const fetchDataset = async (filename: string): Promise<string> => {
  const response = await fetch(`./data/${filename}`)
  if (!response.ok) {
    throw new Error(`${filename} HTTP ${String(response.status)}`)
  }
  return response.text()
}

const bootstrap = async (): Promise<void> => {
  const els = collectAppElements()
  const state: AppState = {
    inventory: null,
    workplaceStation: null,
    networkText: null,
    account: null,
    signingIn: false,
    matches: [],
    selectedStopId: null,
    kindFilter: 'all',
    textFilter: '',
    abortController: null,
    preview: null,
    selectedArea: null,
    areaCheck: null,
  }

  let ctx: AppContext | null = null
  const mapView = new CommuteMapView(
    els.mapContainer,
    (stopId) => {
      if (ctx) {
        selectStop(ctx, stopId)
      }
    },
    (point) => {
      if (ctx) {
        selectArea(
          ctx,
          point,
          `Map point ${point.latitude.toFixed(5)}, ${point.longitude.toFixed(5)}`,
        )
      }
    },
  )
  ctx = { els, mapView, state }

  wireUiEvents(ctx)
  syncAccountUi(ctx)

  const saved = loadCompletedResult(window.localStorage)
  if (saved) {
    setMobileView('map')
    applySnapshot(ctx, saved)
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {})
  }

  try {
    const [stopsText, networkText] = await Promise.all([
      fetchDataset('stops.tsv'),
      fetchDataset('bus-network.tsv'),
    ])
    const inventory = parseStopInventory(stopsText)
    state.inventory = inventory
    state.networkText = networkText
    wireStationAutocomplete(els, inventory, (station) => {
      if (state.workplaceStation?.id === station.id) return
      state.workplaceStation = station
      invalidatePreview(ctx)
    })
    syncConnectivity(ctx)
  } catch (error) {
    renderInlineError(
      els.searchError,
      `Could not load stop inventory: ${normalizeError(error, 'fetch failed').message}`,
    )
  }
}

void bootstrap()
