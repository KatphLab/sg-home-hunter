import type {
  OneMapAccount,
  QualifiedStop,
  SearchResultStatus,
  Stop,
  StopInventory,
  Workplace,
} from '@lib/commute-types.js'
import {
  formatJourneyTimes,
  formatRideMinutes,
  formatServiceChain,
  type StopListKindFilter,
  sortAndFilterMatches,
} from '@lib/journey-format.js'

const requireElement = (id: string): HTMLElement => {
  const el = document.getElementById(id)
  if (!el) {
    throw new Error(`Missing required element #${id}`)
  }
  return el
}

const requireElementOfType = <T extends HTMLElement>(
  id: string,
  ctor: { new (): T },
): T => {
  const el = requireElement(id)
  if (!(el instanceof ctor)) {
    throw new Error(`Unexpected element type for #${id}`)
  }
  return el
}

export interface AppElements {
  readonly connectivityBadge: HTMLElement
  readonly inventoryBadge: HTMLElement
  readonly offlineBanner: HTMLElement
  readonly accountStatusPill: HTMLElement
  readonly signinForm: HTMLFormElement
  readonly emailInput: HTMLInputElement
  readonly passwordInput: HTMLInputElement
  readonly signinButton: HTMLButtonElement
  readonly signedInBar: HTMLElement
  readonly signedInEmail: HTMLElement
  readonly signoutButton: HTMLButtonElement
  readonly authError: HTMLElement
  readonly searchForm: HTMLFormElement
  readonly postalGroup: HTMLElement
  readonly postalInput: HTMLInputElement
  readonly stationGroup: HTMLElement
  readonly stationFilterInput: HTMLInputElement
  readonly stationSelect: HTMLSelectElement
  readonly officeStartInput: HTMLInputElement
  readonly rideCapInput: HTMLInputElement
  readonly plannedSearchDate: HTMLElement
  readonly plannedInventoryDate: HTMLElement
  readonly startSearchButton: HTMLButtonElement
  readonly stopSearchButton: HTMLButtonElement
  readonly searchError: HTMLElement
  readonly resultStatusTag: HTMLElement
  readonly liveStatusRegion: HTMLElement
  readonly stopsTriedValue: HTMLElement
  readonly stopsMatchedValue: HTMLElement
  readonly activeConstraintsSummary: HTMLElement
  readonly visibleStopsCount: HTMLElement
  readonly stopListFilterInput: HTMLInputElement
  readonly qualifyingStopsList: HTMLElement
  readonly mapContainer: HTMLElement
  readonly selectedStopCard: HTMLElement
  readonly selectedStopId: HTMLElement
  readonly selectedStopName: HTMLElement
  readonly selectedStopKind: HTMLElement
  readonly selectedBoardingTime: HTMLElement
  readonly selectedArrivalTime: HTMLElement
  readonly selectedRideDuration: HTMLElement
  readonly selectedServices: HTMLElement
  readonly selectedJourneyDisclaimer: HTMLElement
  readonly closeJourneyCardButton: HTMLButtonElement
  readonly mobileStopsCount: HTMLElement
  readonly previewPanel: HTMLElement
  readonly previewSummary: HTMLElement
  readonly areaStopFilter: HTMLInputElement
  readonly areaStopSelect: HTMLSelectElement
  readonly areaSummary: HTMLElement
  readonly checkAreaButton: HTMLButtonElement
  readonly stopAreaButton: HTMLButtonElement
  readonly areaResult: HTMLElement
  readonly areaJourney: HTMLElement
}

export const collectAppElements = (): AppElements => ({
  connectivityBadge: requireElement('connectivity-badge'),
  inventoryBadge: requireElement('inventory-badge'),
  offlineBanner: requireElement('offline-banner'),
  accountStatusPill: requireElement('account-status-pill'),
  signinForm: requireElementOfType('signin-form', HTMLFormElement),
  emailInput: requireElementOfType('onemap-email', HTMLInputElement),
  passwordInput: requireElementOfType('onemap-password', HTMLInputElement),
  signinButton: requireElementOfType('signin-btn', HTMLButtonElement),
  signedInBar: requireElement('signed-in-bar'),
  signedInEmail: requireElement('signed-in-email'),
  signoutButton: requireElementOfType('signout-btn', HTMLButtonElement),
  authError: requireElement('auth-error'),
  searchForm: requireElementOfType('search-form', HTMLFormElement),
  postalGroup: requireElement('postal-field-group'),
  postalInput: requireElementOfType('postal-input', HTMLInputElement),
  stationGroup: requireElement('station-field-group'),
  stationFilterInput: requireElementOfType(
    'station-filter-input',
    HTMLInputElement,
  ),
  stationSelect: requireElementOfType('station-select', HTMLSelectElement),
  officeStartInput: requireElementOfType(
    'office-start-input',
    HTMLInputElement,
  ),
  rideCapInput: requireElementOfType('ride-cap-input', HTMLInputElement),
  plannedSearchDate: requireElement('planned-search-date'),
  plannedInventoryDate: requireElement('planned-inventory-date'),
  startSearchButton: requireElementOfType(
    'start-search-btn',
    HTMLButtonElement,
  ),
  stopSearchButton: requireElementOfType('stop-search-btn', HTMLButtonElement),
  searchError: requireElement('search-error'),
  resultStatusTag: requireElement('result-status-tag'),
  liveStatusRegion: requireElement('live-status-region'),
  stopsTriedValue: requireElement('stops-tried-value'),
  stopsMatchedValue: requireElement('stops-matched-value'),
  activeConstraintsSummary: requireElement('active-constraints-summary'),
  visibleStopsCount: requireElement('visible-stops-count'),
  stopListFilterInput: requireElementOfType(
    'stop-list-filter',
    HTMLInputElement,
  ),
  qualifyingStopsList: requireElement('qualifying-stops-list'),
  mapContainer: requireElement('map'),
  selectedStopCard: requireElement('selected-stop-card'),
  selectedStopId: requireElement('selected-stop-id'),
  selectedStopName: requireElement('selected-stop-name'),
  selectedStopKind: requireElement('selected-stop-kind'),
  selectedBoardingTime: requireElement('selected-boarding-time'),
  selectedArrivalTime: requireElement('selected-arrival-time'),
  selectedRideDuration: requireElement('selected-ride-duration'),
  selectedServices: requireElement('selected-services'),
  selectedJourneyDisclaimer: requireElement('selected-journey-disclaimer'),
  closeJourneyCardButton: requireElementOfType(
    'close-journey-card',
    HTMLButtonElement,
  ),
  mobileStopsCount: requireElement('mobile-stops-count'),
  previewPanel: requireElement('section-preview'),
  previewSummary: requireElement('preview-summary'),
  areaStopFilter: requireElementOfType('area-stop-filter', HTMLInputElement),
  areaStopSelect: requireElementOfType('area-stop-select', HTMLSelectElement),
  areaSummary: requireElement('area-summary'),
  checkAreaButton: requireElementOfType('check-area-btn', HTMLButtonElement),
  stopAreaButton: requireElementOfType('stop-area-btn', HTMLButtonElement),
  areaResult: requireElement('area-result'),
  areaJourney: requireElement('area-journey'),
})

export const renderStationOptions = (
  select: HTMLSelectElement,
  stations: readonly Stop[],
  previousId: string,
): void => {
  const options: HTMLOptionElement[] = []
  for (const station of stations) {
    const opt = document.createElement('option')
    opt.value = station.id
    opt.textContent = `${station.id} · ${station.name}`
    options.push(opt)
  }
  select.replaceChildren(...options)
  if (
    previousId.length > 0 &&
    stations.some((station) => station.id === previousId)
  ) {
    select.value = previousId
  }
}

export const renderInventorySummary = (
  els: AppElements,
  inventory: StopInventory,
  defaultSearchDate: string,
): void => {
  const countText = inventory.stops.length.toLocaleString('en-SG')
  els.inventoryBadge.textContent = `Inventory: ${inventory.inventoryDate} (${countText} stops)`
  els.plannedInventoryDate.textContent = `${inventory.inventoryDate} (${countText} stops)`
  els.plannedSearchDate.textContent = defaultSearchDate
}

export const renderStatusBadge = (
  tag: HTMLElement,
  mode: SearchResultStatus | 'saved' | 'idle' | 'planning',
  passNumber?: number,
  totalPasses?: number,
): void => {
  const labelMap: Readonly<Record<typeof mode, string>> = {
    idle: 'No search yet',
    planning: 'Planning departures',
    running: `Searching — Pass ${String(passNumber ?? 1)} of ${String(totalPasses ?? 1)}`,
    partial: 'Partial result',
    completed: 'Completed',
    saved: 'Saved offline result',
  }
  const classMap: Readonly<Record<typeof mode, string>> = {
    idle: 'status-tag status-tag--muted',
    planning: 'status-tag status-tag--running',
    running: 'status-tag status-tag--running',
    partial: 'status-tag status-tag--partial',
    completed: 'status-tag status-tag--ok',
    saved: 'status-tag status-tag--ok',
  }
  tag.textContent = labelMap[mode]
  tag.className = classMap[mode]
}

export const renderConstraintsSummary = (
  els: AppElements,
  workplace: Workplace | null,
  searchDate: string,
  officeStart: string,
  rideCapMinutes: number,
): void => {
  if (!workplace) {
    els.activeConstraintsSummary.textContent =
      'Run a search to map 500 m housing-search zones across Singapore.'
    return
  }
  const target =
    workplace.kind === 'postal'
      ? `Postal ${workplace.postalCode} (${workplace.label})`
      : `${workplace.stationId} (${workplace.label})`
  els.activeConstraintsSummary.textContent = `${target} · Date ${searchDate} · Start ${officeStart} · Ride cap ${String(rideCapMinutes)} min`
}

const createStopListRow = (
  entry: QualifiedStop,
  isSelected: boolean,
  onSelect: (stopId: string) => void,
): HTMLLIElement => {
  const li = document.createElement('li')
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = isSelected ? 'stop-row-btn is-selected' : 'stop-row-btn'
  btn.dataset['stopId'] = entry.stop.id
  btn.setAttribute('aria-pressed', String(isSelected))
  btn.addEventListener('click', () => onSelect(entry.stop.id))

  const plaque = document.createElement('span')
  plaque.className =
    entry.stop.kind === 'rail'
      ? 'stop-plaque stop-plaque--rail tabular'
      : 'stop-plaque tabular'
  plaque.textContent = entry.stop.id

  const main = document.createElement('span')
  main.className = 'stop-row-main'

  const title = document.createElement('span')
  title.className = 'stop-row-title'
  title.textContent = entry.stop.name

  const times = formatJourneyTimes(entry.journey)
  const meta = document.createElement('span')
  meta.className = 'stop-row-meta tabular'
  meta.textContent = `${times.boarding} → ${times.arrival} · ${formatRideMinutes(entry.journey.rideMs)} · ${formatServiceChain(entry.journey)}`

  main.append(title, meta)
  btn.append(plaque, main)
  li.append(btn)
  return li
}

export const renderQualifyingStopsList = (
  els: AppElements,
  matches: readonly QualifiedStop[],
  kindFilter: StopListKindFilter,
  query: string,
  selectedStopId: string | null,
  onSelect: (stopId: string) => void,
): void => {
  els.mobileStopsCount.textContent = String(matches.length)
  const sorted = sortAndFilterMatches(matches, kindFilter, query)
  els.visibleStopsCount.textContent = `${String(sorted.length)} shown`

  if (sorted.length === 0) {
    const empty = document.createElement('li')
    empty.className = 'stops-empty'
    empty.textContent =
      matches.length === 0
        ? 'No qualifying stops yet.'
        : 'No matching stops for the current filter.'
    els.qualifyingStopsList.replaceChildren(empty)
    return
  }

  const rows = sorted.map((entry) =>
    createStopListRow(entry, entry.stop.id === selectedStopId, onSelect),
  )
  els.qualifyingStopsList.replaceChildren(...rows)
}

export const renderSelectedStopCard = (
  els: AppElements,
  entry: QualifiedStop | null,
): void => {
  if (!entry) {
    els.selectedStopCard.hidden = true
    return
  }
  const times = formatJourneyTimes(entry.journey)
  els.selectedStopCard.hidden = false
  els.selectedStopId.textContent = entry.stop.id
  els.selectedStopId.className =
    entry.stop.kind === 'rail'
      ? 'stop-plaque stop-plaque--rail tabular'
      : 'stop-plaque tabular'
  els.selectedStopName.textContent = entry.stop.name
  els.selectedStopKind.textContent =
    entry.stop.kind === 'rail' ? 'MRT / LRT station' : 'Bus stop'
  els.selectedBoardingTime.textContent = times.boarding
  els.selectedArrivalTime.textContent = times.arrival
  els.selectedRideDuration.textContent = formatRideMinutes(entry.journey.rideMs)
  els.selectedServices.textContent = formatServiceChain(entry.journey)
  els.selectedJourneyDisclaimer.textContent = `One qualifying journey for ${entry.journey.searchDate} — not the fastest, latest or most frequent service.`
}

export const setMobileView = (view: 'search' | 'map' | 'stops'): void => {
  document.body.dataset['mobileView'] = view
}

export const getSelectedWorkplaceKind = (): 'postal' | 'station' => {
  const checked = document.querySelector<HTMLInputElement>(
    'input[name="workplace-kind"]:checked',
  )
  return checked?.value === 'station' ? 'station' : 'postal'
}

export const renderConnectivityState = (
  els: AppElements,
  online: boolean,
  canStartSearch: boolean,
): void => {
  els.offlineBanner.hidden = online
  els.connectivityBadge.textContent = online ? 'Online' : 'Offline'
  els.connectivityBadge.className = online
    ? 'status-tag status-tag--online'
    : 'status-tag status-tag--offline'
  els.signinButton.disabled = !online
  els.startSearchButton.disabled = !canStartSearch
}

export const renderAccountState = (
  els: AppElements,
  account: OneMapAccount | null,
): void => {
  const signedIn = account !== null
  els.signinForm.hidden = signedIn
  els.signedInBar.hidden = !signedIn
  if (account) {
    els.signedInEmail.textContent = account.email
    els.accountStatusPill.textContent = 'Connected'
    els.accountStatusPill.className = 'status-tag status-tag--ok'
  } else {
    els.accountStatusPill.textContent = 'Not connected'
    els.accountStatusPill.className = 'status-tag status-tag--muted'
  }
}

export const renderCounters = (
  els: AppElements,
  triedCount: number,
  totalCount: number,
  matchedCount: number,
): void => {
  els.stopsTriedValue.textContent = `${triedCount.toLocaleString('en-SG')} / ${totalCount.toLocaleString('en-SG')}`
  els.stopsMatchedValue.textContent = matchedCount.toLocaleString('en-SG')
}

export const renderInlineError = (
  element: HTMLElement,
  message: string | null,
): void => {
  if (message === null) {
    element.textContent = ''
    element.hidden = true
    return
  }
  element.textContent = message
  element.hidden = false
}
