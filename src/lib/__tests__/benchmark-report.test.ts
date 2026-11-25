import { describe, expect, it } from 'bun:test'
import {
  type BenchmarkCaseSpec,
  type BenchmarkRunMetrics,
  compareBenchmarkRuns,
  formatBenchmarkMarkdown,
  validateQualifiedStops,
} from '@lib/benchmark-report.js'
import type {
  QualifiedStop,
  SearchConstraints,
  Stop,
  StopInventory,
  Workplace,
} from '@lib/commute-types.js'
import { parseSingaporeDateTimeMs } from '@lib/singapore-calendar.js'

const SEARCH_DATE = '2026-11-26'
const CONSTRAINTS: SearchConstraints = {
  searchDate: SEARCH_DATE,
  officeStart: '09:00',
  rideCapMinutes: 30,
}

const STOP_A: Stop = {
  id: '65729',
  kind: 'bus',
  name: 'Punggol Coast Stn',
  point: { latitude: 1.4149, longitude: 103.9102 },
}

const STOP_B: Stop = {
  id: 'NE17',
  kind: 'rail',
  name: 'Punggol',
  point: { latitude: 1.405_255, longitude: 103.902_354 },
}

const INVENTORY: StopInventory = {
  inventoryDate: '2026-11-24',
  stops: [STOP_A, STOP_B],
}

const WORKPLACE: Workplace = {
  kind: 'postal',
  postalCode: '828616',
  label: 'SIT Punggol',
  point: { latitude: 1.414_19, longitude: 103.910_623 },
}

const CASE_SPEC: BenchmarkCaseSpec = {
  caseId: 'postal-828616-30m',
  label: 'Postal 828616 (30m cap)',
  workplace: WORKPLACE,
  constraints: CONSTRAINTS,
}

const makeMatch = (stop: Stop, rideMin: number): QualifiedStop => ({
  stop,
  journey: {
    stopId: stop.id,
    searchDate: SEARCH_DATE,
    boardingAtMs: parseSingaporeDateTimeMs(SEARCH_DATE, '08:30'),
    arrivalAtMs: parseSingaporeDateTimeMs(SEARCH_DATE, '08:55'),
    rideMs: rideMin * 60_000,
    services: [{ id: '381', name: '381', mode: 'BUS' }],
    isAtDestination: false,
  },
})

describe('benchmark-report', () => {
  it('validates qualifying stop evidence and flags out-of-window, date, destination, or over-cap matches', () => {
    const valid = makeMatch(STOP_A, 25)
    expect(
      validateQualifiedStops([valid], INVENTORY, WORKPLACE, CONSTRAINTS),
    ).toEqual([])

    const stationWp: Workplace = {
      kind: 'station',
      stationId: 'NE17',
      label: 'NE17 Punggol',
      point: STOP_B.point,
    }
    const atDest: QualifiedStop = {
      stop: STOP_B,
      journey: {
        stopId: 'NE17',
        searchDate: SEARCH_DATE,
        boardingAtMs: parseSingaporeDateTimeMs(SEARCH_DATE, '09:00'),
        arrivalAtMs: parseSingaporeDateTimeMs(SEARCH_DATE, '09:00'),
        rideMs: 0,
        services: [],
        isAtDestination: true,
      },
    }
    expect(
      validateQualifiedStops([atDest], INVENTORY, WORKPLACE, CONSTRAINTS),
    ).toHaveLength(1)
    expect(
      validateQualifiedStops([atDest], INVENTORY, stationWp, CONSTRAINTS),
    ).toEqual([])

    const badStop: QualifiedStop = {
      stop: { ...STOP_A, id: 'UNKNOWN' },
      journey: valid.journey,
    }
    const badDate: QualifiedStop = {
      stop: STOP_A,
      journey: { ...valid.journey, searchDate: '2026-11-27' },
    }
    const badInstant: QualifiedStop = {
      stop: STOP_A,
      journey: {
        ...valid.journey,
        boardingAtMs: parseSingaporeDateTimeMs('2026-11-25', '23:55'),
      },
    }
    const lateArrival: QualifiedStop = {
      stop: STOP_A,
      journey: {
        ...valid.journey,
        arrivalAtMs: parseSingaporeDateTimeMs(SEARCH_DATE, '09:05'),
      },
    }
    const badRide = makeMatch(STOP_A, 31)
    const errors = validateQualifiedStops(
      [badStop, badDate, badInstant, lateArrival, badRide],
      INVENTORY,
      WORKPLACE,
      CONSTRAINTS,
    )
    expect(errors).toHaveLength(5)
  })

  it('computes speedup only when both runs are completed, formats destination/shared/validation errors in Markdown', () => {
    const baselinePartial: BenchmarkRunMetrics = {
      algorithm: 'baseline',
      status: 'partial',
      authExpired: false,
      inventoryDate: '2026-11-24',
      elapsedMs: 10_000,
      requestCount: 100,
      wastedRequestCount: 95,
      failedQueries: 0,
      triedCount: 100,
      totalCount: 2,
      matches: [makeMatch(STOP_A, 15)],
    }
    const protoComplete: BenchmarkRunMetrics = {
      algorithm: 'backward-prototype',
      status: 'completed',
      authExpired: false,
      inventoryDate: '2026-11-24',
      networkDate: SEARCH_DATE,
      coldIndexMs: 120,
      warmIndexMs: 25,
      planMs: 15,
      elapsedMs: 2000,
      requestCount: 10,
      wastedRequestCount: 5,
      failedQueries: 0,
      triedCount: 2,
      totalCount: 2,
      candidateStopCount: 2,
      prunedStopCount: 0,
      uncoveredStopCount: 0,
      matches: [makeMatch(STOP_B, 10)],
    }

    const partialCmp = compareBenchmarkRuns(
      CASE_SPEC,
      baselinePartial,
      protoComplete,
      INVENTORY,
    )
    expect(partialCmp.speedup).toBeNull()
    expect(partialCmp.lostMatches.map((m) => m.stop.id)).toEqual(['65729'])
    expect(partialCmp.newMatches.map((m) => m.stop.id)).toEqual(['NE17'])

    const sharedBase = {
      ...baselinePartial,
      status: 'completed' as const,
      matches: [makeMatch(STOP_A, 15), makeMatch(STOP_B, 10)],
    }
    const sharedProto = {
      ...protoComplete,
      requestCount: 0,
      matches: [makeMatch(STOP_A, 15), makeMatch(STOP_B, 10)],
    }
    const sharedCmp = compareBenchmarkRuns(
      CASE_SPEC,
      sharedBase,
      sharedProto,
      INVENTORY,
    )
    expect(sharedCmp.sharedStopIds).toEqual(['65729', 'NE17'])
    expect(sharedCmp.requestRatio).toBeNull()

    const atDest: QualifiedStop = {
      stop: STOP_B,
      journey: {
        stopId: 'NE17',
        searchDate: SEARCH_DATE,
        boardingAtMs: parseSingaporeDateTimeMs(SEARCH_DATE, '09:00'),
        arrivalAtMs: parseSingaporeDateTimeMs(SEARCH_DATE, '09:00'),
        rideMs: 0,
        services: [],
        isAtDestination: true,
      },
    }

    const fullCmp = compareBenchmarkRuns(
      CASE_SPEC,
      {
        ...baselinePartial,
        status: 'completed',
        matches: [makeMatch(STOP_A, 15), atDest],
      },
      { ...protoComplete, matches: [makeMatch(STOP_A, 35)] },
      INVENTORY,
    )
    expect(fullCmp.speedup).toBe(5)
    expect(fullCmp.validationErrors.length).toBeGreaterThan(0)

    const md = formatBenchmarkMarkdown([fullCmp, partialCmp], 'Test Benchmark')
    expect(md).toContain('destination zero-ride')
    expect(md).toContain('Shared verified matches:')
    expect(md).toContain('ratio ')
    expect(md).toContain('coldTotal=')
    expect(md).toContain('warmTotal=')
    expect(md).toContain('postal-828616-30m')
    expect(md).toContain('5.00x')
    expect(md).toContain('N/A (partial)')
    expect(md).toContain('Validation errors')
    expect(md).toContain('65729')
    expect(md).toContain('NE17')
  })
})
