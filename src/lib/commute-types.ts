export type StopKind = 'bus' | 'rail'

export interface Coordinates {
  readonly latitude: number
  readonly longitude: number
}

export interface Stop {
  readonly id: string
  readonly kind: StopKind
  readonly name: string
  readonly point: Coordinates
}

export interface StopInventory {
  readonly inventoryDate: string
  readonly stops: readonly Stop[]
}

interface PostalWorkplace {
  readonly kind: 'postal'
  readonly postalCode: string
  readonly label: string
  readonly point: Coordinates
}

interface StationWorkplace {
  readonly kind: 'station'
  readonly stationId: string
  readonly label: string
  readonly point: Coordinates
}

export type Workplace = PostalWorkplace | StationWorkplace

export type TransitMode = 'BUS' | 'SUBWAY' | 'TRAM' | 'RAIL'

export interface JourneyService {
  readonly id: string
  readonly name: string
  readonly mode: TransitMode
}

export interface QualifyingJourney {
  readonly stopId: string
  readonly searchDate: string
  readonly boardingAtMs: number
  readonly arrivalAtMs: number
  readonly rideMs: number
  readonly services: readonly JourneyService[]
  readonly isAtDestination: boolean
}

export interface QualifiedStop {
  readonly stop: Stop
  readonly journey: QualifyingJourney
}

export interface SearchConstraints {
  readonly searchDate: string
  readonly officeStart: string
  readonly rideCapMinutes: number
}

export type SearchResultStatus = 'running' | 'completed' | 'partial'

export interface CompletedSearchSnapshot {
  readonly version: 1
  readonly completedAtIso: string
  readonly inventoryDate: string
  readonly workplace: Workplace
  readonly constraints: SearchConstraints
  readonly triedCount: number
  readonly totalCount: number
  readonly matches: readonly QualifiedStop[]
}

export interface OneMapAccount {
  readonly email: string
  readonly accessToken: string
  readonly expiryTimestamp: number
}

export interface SearchProgress {
  readonly status: SearchResultStatus
  readonly triedCount: number
  readonly totalCount: number
  readonly matchedCount: number
  readonly passNumber: number
  readonly totalPasses: number
  readonly failedQueries: number
  readonly matches: readonly QualifiedStop[]
}

export interface SearchRunResult {
  readonly status: 'completed' | 'partial'
  readonly authExpired: boolean
  readonly triedCount: number
  readonly totalCount: number
  readonly failedQueries: number
  readonly matches: readonly QualifiedStop[]
}
