import type {
  OneMapAccount,
  QualifiedStop,
  Stop,
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
  readonly accountPanel: HTMLElement
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
  readonly searchHeading: HTMLElement
  readonly searchForm: HTMLFormElement
  readonly postalGroup: HTMLElement
  readonly postalInput: HTMLInputElement
  readonly stationGroup: HTMLElement
  readonly stationFilterInput: HTMLInputElement
  readonly stationSelect: HTMLSelectElement
  readonly officeStartInput: HTMLInputElement
  readonly rideCapInput: HTMLInputElement
  readonly commuteHint: HTMLElement
  readonly editCommuteButton: HTMLButtonElement
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
  readonly selectedStopAction: HTMLElement
  readonly selectedStopId: HTMLElement
  readonly selectedStopName: HTMLElement
  readonly selectedStopKind: HTMLElement
  readonly selectedBoardingTime: HTMLElement
  readonly selectedArrivalTime: HTMLElement
  readonly selectedRideDuration: HTMLElement
  readonly selectedServices: HTMLElement
  readonly selectedJourneyDate: HTMLTimeElement
  readonly selectedJourneyDisclaimer: HTMLElement
  readonly closeJourneyCardButton: HTMLButtonElement
  readonly mobileStopsCount: HTMLElement
  readonly previewPanel: HTMLElement
  readonly previewHeading: HTMLElement
  readonly previewSummary: HTMLElement
  readonly areaPicker: HTMLDetailsElement
  readonly areaStopFilter: HTMLInputElement
  readonly areaStopSelect: HTMLSelectElement
  readonly areaSummary: HTMLElement
  readonly checkAreaButton: HTMLButtonElement
  readonly checkMoreButton: HTMLButtonElement
  readonly stopAreaButton: HTMLButtonElement
  readonly areaResult: HTMLElement
}

export const collectAppElements = (): AppElements => ({
  connectivityBadge: requireElement('connectivity-badge'),
  accountPanel: requireElement('section-account'),
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
  searchHeading: requireElement('heading-search'),
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
  commuteHint: requireElement('commute-hint'),
  editCommuteButton: requireElementOfType(
    'edit-commute-btn',
    HTMLButtonElement,
  ),
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
  selectedStopAction: requireElement('selected-stop-action'),
  selectedStopId: requireElement('selected-stop-id'),
  selectedStopName: requireElement('selected-stop-name'),
  selectedStopKind: requireElement('selected-stop-kind'),
  selectedBoardingTime: requireElement('selected-boarding-time'),
  selectedArrivalTime: requireElement('selected-arrival-time'),
  selectedRideDuration: requireElement('selected-ride-duration'),
  selectedServices: requireElement('selected-services'),
  selectedJourneyDate: requireElementOfType(
    'selected-journey-date',
    HTMLTimeElement,
  ),
  selectedJourneyDisclaimer: requireElement('selected-journey-disclaimer'),
  closeJourneyCardButton: requireElementOfType(
    'close-journey-card',
    HTMLButtonElement,
  ),
  mobileStopsCount: requireElement('mobile-stops-count'),
  previewPanel: requireElement('section-preview'),
  previewHeading: requireElement('heading-preview'),
  previewSummary: requireElement('preview-summary'),
  areaPicker: requireElementOfType('area-picker', HTMLDetailsElement),
  areaStopFilter: requireElementOfType('area-stop-filter', HTMLInputElement),
  areaStopSelect: requireElementOfType('area-stop-select', HTMLSelectElement),
  areaSummary: requireElement('area-summary'),
  checkAreaButton: requireElementOfType('check-area-btn', HTMLButtonElement),
  checkMoreButton: requireElementOfType('check-more-btn', HTMLButtonElement),
  stopAreaButton: requireElementOfType('stop-area-btn', HTMLButtonElement),
  areaResult: requireElement('area-result'),
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

export const renderCommuteHint = (els: AppElements): void => {
  const startMs = els.officeStartInput.valueAsNumber
  const arrival = Number.isFinite(startMs)
    ? `Arrive ${new Date(Math.max(0, startMs - 900_000)).toISOString().slice(11, 16)}–${els.officeStartInput.value}. `
    : ''
  const cap = els.rideCapInput.validity.valid
    ? `Your ${els.rideCapInput.value}-minute ride cap`
    : 'Ride cap'
  els.commuteHint.textContent = `${arrival}${cap} excludes walking and waiting.`
}

const resultBadges = {
  idle: ['No search yet', 'muted'],
  planning: ['Planning departures', 'running'],
  preview: ['Estimated preview', 'muted'],
  confirmed: ['Area confirmed', 'muted'],
  saved: ['Saved offline result', 'ok'],
  savedArea: ['Saved offline area check', 'ok'],
} as const

export const renderStatusBadge = (
  tag: HTMLElement,
  mode: keyof typeof resultBadges,
): void => {
  const [label, tone] = resultBadges[mode]
  tag.textContent = label
  tag.className = `status-tag status-tag--${tone}`
}

export const renderConstraintsSummary = (
  els: AppElements,
  workplace: Workplace,
  officeStart: string,
  rideCapMinutes: number,
): void => {
  const target =
    workplace.kind === 'postal'
      ? `Postal ${workplace.postalCode} (${workplace.label})`
      : `${workplace.stationId} (${workplace.label})`
  els.activeConstraintsSummary.textContent = `${target} · Start ${officeStart} · Ride cap ${String(rideCapMinutes)} min`
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

const checkedDateFormat = new Intl.DateTimeFormat('en-SG', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  timeZone: 'UTC',
})

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
  els.selectedStopAction.textContent = entry.journey.isAtDestination
    ? 'At workplace:'
    : 'Board at'
  els.selectedStopName.textContent = entry.stop.name
  els.selectedStopKind.textContent =
    entry.stop.kind === 'rail' ? 'MRT / LRT station' : 'Bus stop'
  els.selectedBoardingTime.textContent = times.boarding
  els.selectedArrivalTime.textContent = times.arrival
  els.selectedRideDuration.textContent = formatRideMinutes(entry.journey.rideMs)
  els.selectedServices.textContent = formatServiceChain(entry.journey)
  els.selectedJourneyDate.dateTime = entry.journey.searchDate
  els.selectedJourneyDate.textContent = `Checked for ${checkedDateFormat.format(new Date(entry.journey.searchDate))}`
  els.selectedJourneyDisclaimer.textContent =
    'One qualifying journey, not necessarily the fastest, latest or most frequent. Arrival includes any final walk.'
}

export const setMobileView = (view: 'search' | 'map' | 'stops'): void => {
  document.body.dataset['mobileView'] = view
  for (const tab of document.querySelectorAll<HTMLElement>(
    '[data-mobile-tab]',
  )) {
    if (tab.dataset['mobileTab'] === view)
      tab.setAttribute('aria-current', 'true')
    else tab.removeAttribute('aria-current')
  }
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
  signingIn: boolean,
): void => {
  els.offlineBanner.hidden = online
  els.connectivityBadge.textContent = online ? 'Online' : 'Offline'
  els.connectivityBadge.className = online
    ? 'status-tag status-tag--online'
    : 'status-tag status-tag--offline'
  els.signinButton.disabled = !online || signingIn
  els.startSearchButton.disabled = !canStartSearch
}

export const renderAccountState = (
  els: AppElements,
  account: OneMapAccount | null,
): void => {
  const signedIn = account !== null
  els.accountPanel.hidden = !signedIn
  els.startSearchButton.textContent = signedIn
    ? 'Preview estimated stops'
    : 'Connect OneMap to preview'
  if (signedIn) {
    els.startSearchButton.removeAttribute('aria-expanded')
    els.startSearchButton.removeAttribute('aria-controls')
  } else {
    els.startSearchButton.setAttribute('aria-controls', els.accountPanel.id)
    els.startSearchButton.setAttribute('aria-expanded', 'false')
  }
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
