import type {
  JourneyService,
  QualifiedStop,
  QualifyingJourney,
  TransitMode,
} from '@lib/commute-types.js'
import { formatSingaporeTime } from '@lib/singapore-calendar.js'

export type StopListKindFilter = 'all' | 'rail' | 'bus'

const MODE_LABELS: Readonly<Record<TransitMode, string>> = {
  BUS: 'Bus',
  SUBWAY: 'MRT',
  TRAM: 'LRT',
  RAIL: 'Rail',
}

const formatServiceBadge = (service: JourneyService): string =>
  `${MODE_LABELS[service.mode]} ${service.name}`

export const formatServiceChain = (journey: QualifyingJourney): string => {
  if (journey.isAtDestination || journey.services.length === 0) {
    return 'Destination station (direct arrival)'
  }
  return journey.services.map(formatServiceBadge).join(' → ')
}

export const formatRideMinutes = (rideMs: number): string => {
  const minutes = Math.round(rideMs / 60_000)
  return `${String(minutes)} min`
}

export const formatJourneyTimes = (
  journey: QualifyingJourney,
): { readonly boarding: string; readonly arrival: string } => ({
  boarding: formatSingaporeTime(journey.boardingAtMs),
  arrival: formatSingaporeTime(journey.arrivalAtMs),
})

export const sortAndFilterMatches = (
  matches: readonly QualifiedStop[],
  kindFilter: StopListKindFilter,
  query: string,
): readonly QualifiedStop[] => {
  const normalizedQuery = query.trim().toLowerCase()
  const filtered = matches.filter((entry) => {
    if (kindFilter !== 'all' && entry.stop.kind !== kindFilter) {
      return false
    }
    if (normalizedQuery.length === 0) {
      return true
    }
    const serviceText = formatServiceChain(entry.journey).toLowerCase()
    return (
      entry.stop.id.toLowerCase().includes(normalizedQuery) ||
      entry.stop.name.toLowerCase().includes(normalizedQuery) ||
      serviceText.includes(normalizedQuery)
    )
  })

  return [...filtered].sort((a, b) => {
    if (a.stop.kind !== b.stop.kind) {
      return a.stop.kind === 'rail' ? -1 : 1
    }
    const rideDiff = a.journey.rideMs - b.journey.rideMs
    if (rideDiff !== 0) {
      return rideDiff
    }
    return a.stop.id.localeCompare(b.stop.id)
  })
}
