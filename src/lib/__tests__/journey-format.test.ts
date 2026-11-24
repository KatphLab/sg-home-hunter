import { describe, expect, it } from 'bun:test'
import type { QualifiedStop } from '@lib/commute-types.js'
import {
  formatJourneyTimes,
  formatRideMinutes,
  formatServiceChain,
  sortAndFilterMatches,
} from '@lib/journey-format.js'

const MATCHES: readonly QualifiedStop[] = [
  {
    stop: {
      id: '65009',
      kind: 'bus',
      name: 'Punggol Temp Int',
      point: { latitude: 1.4, longitude: 103.9 },
    },
    journey: {
      stopId: '65009',
      searchDate: '2026-06-02',
      boardingAtMs: Date.parse('2026-06-02T08:20:00+08:00'),
      arrivalAtMs: Date.parse('2026-06-02T08:45:00+08:00'),
      rideMs: 1_500_000,
      services: [
        { id: '116', name: '116', mode: 'BUS' },
        { id: 'NE', name: 'NE', mode: 'SUBWAY' },
      ],
      isAtDestination: false,
    },
  },
  {
    stop: {
      id: 'NS17',
      kind: 'rail',
      name: 'Bishan',
      point: { latitude: 1.351, longitude: 103.848 },
    },
    journey: {
      stopId: 'NS17',
      searchDate: '2026-06-02',
      boardingAtMs: Date.parse('2026-06-02T09:00:00+08:00'),
      arrivalAtMs: Date.parse('2026-06-02T09:00:00+08:00'),
      rideMs: 0,
      services: [],
      isAtDestination: true,
    },
  },
  {
    stop: {
      id: 'NE17',
      kind: 'rail',
      name: 'Punggol',
      point: { latitude: 1.405, longitude: 103.902 },
    },
    journey: {
      stopId: 'NE17',
      searchDate: '2026-06-02',
      boardingAtMs: Date.parse('2026-06-02T08:30:00+08:00'),
      arrivalAtMs: Date.parse('2026-06-02T08:52:00+08:00'),
      rideMs: 1_320_000,
      services: [{ id: 'NE', name: 'NE', mode: 'SUBWAY' }],
      isAtDestination: false,
    },
  },
]

describe('journey-format', () => {
  it('formats service chains, clock times, and ride duration cleanly', () => {
    const first = MATCHES[0]
    const second = MATCHES[1]
    expect(first).toBeDefined()
    expect(second).toBeDefined()
    if (first && second) {
      expect(formatServiceChain(first.journey)).toBe('Bus 116 → MRT NE')
      expect(formatServiceChain(second.journey)).toBe(
        'Destination station (direct arrival)',
      )
      expect(formatRideMinutes(first.journey.rideMs)).toBe('25 min')
      expect(formatRideMinutes(second.journey.rideMs)).toBe('0 min')
      expect(formatJourneyTimes(first.journey)).toEqual({
        boarding: '08:20',
        arrival: '08:45',
      })
    }
  })

  it('sorts rail and shortest ride time first and filters by kind and query', () => {
    expect(
      sortAndFilterMatches(MATCHES, 'all', '').map((m) => m.stop.id),
    ).toEqual(['NS17', 'NE17', '65009'])
    expect(
      sortAndFilterMatches(MATCHES, 'bus', '').map((m) => m.stop.id),
    ).toEqual(['65009'])
    expect(
      sortAndFilterMatches(MATCHES, 'all', '116').map((m) => m.stop.id),
    ).toEqual(['65009'])
  })
})
