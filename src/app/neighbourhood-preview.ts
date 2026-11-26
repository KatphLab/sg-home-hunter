import type { BackwardLead, BackwardPlanResult } from '@lib/backward-planner.js'
import type {
  Coordinates,
  SearchConstraints,
  Workplace,
} from '@lib/commute-types.js'
import { haversineDistanceMeters } from '@lib/transit-network.js'

export interface NeighbourhoodPreview {
  readonly workplace: Workplace
  readonly constraints: SearchConstraints
  readonly leads: readonly BackwardLead[]
}

export const hasTenMinuteMargin = (
  estimatedRideMs: number,
  rideCapMinutes: number,
): boolean => rideCapMinutes * 60_000 - estimatedRideMs >= 600_000

export const createNeighbourhoodPreview = (
  plan: BackwardPlanResult,
  workplace: Workplace,
  constraints: SearchConstraints,
): NeighbourhoodPreview => {
  const radiusMeters = 1200 + (25_000 * constraints.rideCapMinutes) / 60
  return {
    workplace,
    constraints,
    leads: plan.leads.filter(
      (lead) =>
        lead.estRideMs <= constraints.rideCapMinutes * 60_000 &&
        haversineDistanceMeters(lead.stop.point, workplace.point) <=
          radiusMeters,
    ),
  }
}

export const candidatesWithinArea = (
  preview: NeighbourhoodPreview,
  centre: Coordinates,
): readonly BackwardLead[] =>
  preview.leads.filter(
    (lead) => haversineDistanceMeters(lead.stop.point, centre) <= 500,
  )
