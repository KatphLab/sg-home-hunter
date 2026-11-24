import type {
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

const requireInput = (id: string): HTMLInputElement => {
  const el = requireElement(id)
  if (!(el instanceof HTMLInputElement)) {
    throw new Error(`Expected HTMLInputElement for #${id}`)
  }
  return el
}

const requireSelect = (id: string): HTMLSelectElement => {
  const el = requireElement(id)
  if (!(el instanceof HTMLSelectElement)) {
    throw new Error(`Expected HTMLSelectElement for #${id}`)
  }
  return el
}

const requireButton = (id: string): HTMLButtonElement => {
  const el = requireElement(id)
  if (!(el instanceof HTMLButtonElement)) {
    throw new Error(`Expected HTMLButtonElement for #${id}`)
  }
  return el
}

const requireForm = (id: string): HTMLFormElement => {
  const el = requireElement(id)
  if (!(el instanceof HTMLFormElement)) {
    throw new Error(`Expected HTMLFormElement for #${id}`)
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
}

export const collectAppElements = (): AppElements => ({
  connectivityBadge: requireElement('connectivity-badge'),
  inventoryBadge: requireElement('inventory-badge'),
  offlineBanner: requireElement('offline-banner'),
  accountStatusPill: requireElement('account-status-pill'),
  signinForm: requireForm('signin-form'),
  emailInput: requireInput('onemap-email'),
  passwordInput: requireInput('onemap-password'),
  signinButton: requireButton('signin-btn'),
  signedInBar: requireElement('signed-in-bar'),
  signedInEmail: requireElement('signed-in-email'),
  signoutButton: requireButton('signout-btn'),
  authError: requireElement('auth-error'),
  searchForm: requireForm('search-form'),
  postalGroup: requireElement('postal-field-group'),
  postalInput: requireInput('postal-input'),
  stationGroup: requireElement('station-field-group'),
  stationFilterInput: requireInput('station-filter-input'),
  stationSelect: requireSelect('station-select'),
  officeStartInput: requireInput('office-start-input'),
  rideCapInput: requireInput('ride-cap-input'),
  plannedSearchDate: requireElement('planned-search-date'),
  plannedInventoryDate: requireElement('planned-inventory-date'),
  startSearchButton: requireButton('start-search-btn'),
  stopSearchButton: requireButton('stop-search-btn'),
  searchError: requireElement('search-error'),
  resultStatusTag: requireElement('result-status-tag'),
  liveStatusRegion: requireElement('live-status-region'),
  stopsTriedValue: requireElement('stops-tried-value'),
  stopsMatchedValue: requireElement('stops-matched-value'),
  activeConstraintsSummary: requireElement('active-constraints-summary'),
  visibleStopsCount: requireElement('visible-stops-count'),
  stopListFilterInput: requireInput('stop-list-filter'),
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
  closeJourneyCardButton: requireButton('close-journey-card'),
  mobileStopsCount: requireElement('mobile-stops-count'),
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
  mode: SearchResultStatus | 'saved' | 'idle',
  passNumber?: number,
  totalPasses?: number,
): void => {
  const labelMap: Readonly<Record<typeof mode, string>> = {
    idle: 'No search yet',
    running: `Searching — Pass ${String(passNumber ?? 1)} of ${String(totalPasses ?? 1)}`,
    partial: 'Partial result',
    completed: 'Completed',
    saved: 'Saved offline result',
  }
  const classMap: Readonly<Record<typeof mode, string>> = {
    idle: 'status-tag status-tag--muted',
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
