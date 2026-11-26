import { filterRailStations, parseStopInventory } from '@lib/inventory.js'
import { loadCompletedResult } from '@lib/saved-result-store.js'
import { getDefaultSearchDate } from '@lib/singapore-calendar.js'
import { normalizeError } from '@utils/guards.js'
import {
  collectAppElements,
  getSelectedWorkplaceKind,
  renderInlineError,
  renderInventorySummary,
  renderStationOptions,
  setMobileView,
} from './dom-render.js'
import { CommuteMapView } from './map-view.js'
import {
  type AppContext,
  type AppState,
  applySnapshot,
  handleSearchSubmit,
  handleSignIn,
  handleSignOut,
  refreshStopList,
  selectStop,
  stopActiveSearch,
  syncAccountUi,
  syncConnectivity,
} from './search-controller.js'

const wireUiEvents = (ctx: AppContext): void => {
  const { els, mapView, state } = ctx

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
  els.stopSearchButton.addEventListener('click', () => stopActiveSearch(ctx))
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
    networkText: null,
    account: null,
    workplace: null,
    matches: [],
    selectedStopId: null,
    kindFilter: 'all',
    textFilter: '',
    isSearching: false,
    abortController: null,
  }

  let ctx: AppContext | null = null
  const mapView = new CommuteMapView(els.mapContainer, (stopId) => {
    if (ctx) {
      selectStop(ctx, stopId)
    }
  })
  ctx = { els, mapView, state }

  wireUiEvents(ctx)
  syncAccountUi(ctx)

  const saved = loadCompletedResult(window.localStorage)
  if (saved) {
    applySnapshot(ctx, saved)
    setMobileView('map')
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
    renderInventorySummary(els, inventory, getDefaultSearchDate(Date.now()))
    renderStationOptions(
      els.stationSelect,
      filterRailStations(inventory, ''),
      '',
    )
    els.stationFilterInput.addEventListener('input', () => {
      renderStationOptions(
        els.stationSelect,
        filterRailStations(inventory, els.stationFilterInput.value),
        els.stationSelect.value,
      )
    })
    syncConnectivity(ctx)
  } catch (error) {
    els.inventoryBadge.textContent = 'Inventory unavailable'
    renderInlineError(
      els.searchError,
      `Could not load stop inventory: ${normalizeError(error, 'fetch failed').message}`,
    )
  }
}

void bootstrap()
