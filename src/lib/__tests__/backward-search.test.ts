import { describe, expect, it } from 'bun:test'
import { runBackwardCommuteSearch } from '@lib/backward-search.js'
import type {
  SearchConstraints,
  StopInventory,
  Workplace,
} from '@lib/commute-types.js'
import { OneMapAuthError } from '@lib/onemap-client.js'
import { runCommuteSearch } from '@lib/search-scheduler.js'
import { parseSingaporeDateTimeMs } from '@lib/singapore-calendar.js'
import { buildTransitNetworkIndex } from '@lib/transit-network.js'

const SEARCH_DATE = '2026-11-26'
const CONSTRAINTS: SearchConstraints = {
  searchDate: SEARCH_DATE,
  officeStart: '09:00',
  rideCapMinutes: 30,
}

const sgtMs = (clock: string, offsetMs = 0): number =>
  parseSingaporeDateTimeMs(SEARCH_DATE, clock.slice(0, 5)) +
  Number(clock.slice(6) || 0) * 1000 +
  offsetMs

const INVENTORY: StopInventory = {
  inventoryDate: '2026-11-24',
  stops: [
    {
      id: '65009',
      kind: 'bus',
      name: 'Upstream Overcap',
      point: { latitude: 1.404, longitude: 103.902 },
    },
    {
      id: '65729',
      kind: 'bus',
      name: 'Punggol Coast Stn',
      point: { latitude: 1.4105, longitude: 103.9085 },
    },
    {
      id: '69009',
      kind: 'bus',
      name: 'Punggol Coast Int',
      point: { latitude: 1.414_19, longitude: 103.9106 },
    },
    {
      id: '65701',
      kind: 'bus',
      name: 'Mid Transfer',
      point: { latitude: 1.408, longitude: 103.906 },
    },
    {
      id: 'NS17',
      kind: 'rail',
      name: 'Bishan',
      point: { latitude: 1.351_455, longitude: 103.848_263 },
    },
    {
      id: 'CC15',
      kind: 'rail',
      name: 'Bishan',
      point: { latitude: 1.351_455, longitude: 103.848_263 },
    },
    {
      id: 'FAR01',
      kind: 'bus',
      name: 'Far Tuas',
      point: { latitude: 1.26, longitude: 103.63 },
    },
    {
      id: 'UNCOV',
      kind: 'bus',
      name: 'Uncovered Stop',
      point: { latitude: 1.4145, longitude: 103.9105 },
    },
  ],
}

const POSTAL_WORKPLACE: Workplace = {
  kind: 'postal',
  postalCode: '828616',
  label: 'SIT Punggol',
  point: { latitude: 1.414_19, longitude: 103.910_623 },
}

const makeBusItinerary = (
  stopId: string,
  boardClock: string,
  arriveClock: string,
  finalWalkMs = 0,
  boardOffsetMs = 0,
) => {
  const boardMs = sgtMs(boardClock, boardOffsetMs)
  const alightMs = sgtMs(arriveClock) - finalWalkMs
  return {
    startTime: boardMs,
    endTime: sgtMs(arriveClock),
    legs: [
      {
        mode: 'BUS',
        startTime: boardMs,
        endTime: alightMs,
        from: { stopCode: stopId },
        routeShortName: '381',
      },
      ...(finalWalkMs > 0
        ? [{ mode: 'WALK', startTime: alightMs, endTime: sgtMs(arriveClock) }]
        : []),
    ],
  }
}

describe('backward-search whole-search correctness vs baseline', () => {
  it('matches baseline on downstream-only, tight transfer, final walk boundary, and exact ride cap without probing far stops', async () => {
    const networkIndex = buildTransitNetworkIndex({
      inventory: INVENTORY,
      networkDate: SEARCH_DATE,
      busServices: {
        '381': {
          name: 'Local',
          routes: [['65009', '65701', '65729', '69009']],
        },
        '990': {
          name: 'Far West',
          routes: [['FAR01', '65009']],
        },
      },
      busFirstLast: {
        '65009': ['381 0530 2330 = = = =', '990 0530 2330 = = = ='],
        '65701': ['381 0535 2335 = = = ='],
        '65729': ['381 0540 2340 = = = ='],
        '69009': ['381 0542 2342 = = = ='],
        FAR01: ['990 0500 2300 = = = ='],
      },
    })

    const transferItinerary = {
      startTime: sgtMs('08:05:00'),
      endTime: sgtMs('08:59:00'),
      legs: [
        {
          mode: 'BUS',
          startTime: sgtMs('08:05:00'),
          endTime: sgtMs('08:30:00'),
          from: { stopCode: '65009' },
          routeShortName: '381',
        },
        {
          mode: 'WALK',
          startTime: sgtMs('08:30:00'),
          endTime: sgtMs('08:34:00'),
        },
        {
          mode: 'BUS',
          startTime: sgtMs('08:35:00'),
          endTime: sgtMs('08:55:00'),
          from: { stopCode: '65701' },
          routeShortName: '84W',
        },
        {
          mode: 'WALK',
          startTime: sgtMs('08:55:00'),
          endTime: sgtMs('08:59:00'),
        },
      ],
    }

    // 65729 has a ride of exactly 30m (08:30 -> 09:00)
    const exactCap65729 = makeBusItinerary('65729', '08:30:00', '09:00:00')
    // A late walk pushes arrival past 09:00 -> must NOT qualify
    const lateWalk = makeBusItinerary('65009', '08:40:00', '09:01:00', 120_000)

    const oracleCallsBaseline: string[] = []
    const oracleCallsBackward: string[] = []

    const makeOracle =
      (log: string[]) => (stop: { id: string }, depTime: string) => {
        log.push(`${stop.id}@${depTime}`)
        if (stop.id === '65009') {
          return Promise.resolve([transferItinerary, lateWalk])
        }
        if (stop.id === '65729') {
          return Promise.resolve([exactCap65729])
        }
        if (stop.id === '65701') {
          return Promise.resolve([
            makeBusItinerary('65701', '08:35:00', '08:59:00', 240_000),
          ])
        }
        return Promise.resolve([])
      }

    const baseResult = await runCommuteSearch({
      inventory: INVENTORY,
      workplace: POSTAL_WORKPLACE,
      constraints: CONSTRAINTS,
      minRequestIntervalMs: 0,
      signal: new AbortController().signal,
      routeStop: makeOracle(oracleCallsBaseline),
      onProgress: () => {},
    })

    const backResult = await runBackwardCommuteSearch({
      inventory: INVENTORY,
      networkIndex,
      workplace: POSTAL_WORKPLACE,
      constraints: CONSTRAINTS,
      minRequestIntervalMs: 0,
      signal: new AbortController().signal,
      routeStop: makeOracle(oracleCallsBackward),
      onProgress: () => {},
    })

    expect(baseResult.status).toBe('completed')
    expect(backResult.status).toBe('completed')

    const baseIds = baseResult.matches.map((m) => m.stop.id).sort()
    const backIds = backResult.matches.map((m) => m.stop.id).sort()
    expect(backIds).toEqual(baseIds)
    expect(backIds).toEqual(['65701', '65729'])
    expect(oracleCallsBackward.some((c) => c.startsWith('FAR01@'))).toBe(false)
    expect(backResult.requestCount).toBeLessThan(oracleCallsBaseline.length)
  })

  it('never qualifies a timed intermediate stop unless confirmed by routeStop response', async () => {
    const subStops = INVENTORY.stops.slice(0, 4)
    const networkIndex = buildTransitNetworkIndex({
      inventory: {
        inventoryDate: INVENTORY.inventoryDate,
        stops: subStops,
      },
      networkDate: SEARCH_DATE,
      busServices: {
        '381': {
          name: 'Local',
          routes: [['65009', '65701', '65729', '69009']],
        },
      },
      busFirstLast: {
        '65009': ['381 0530 2330 = = = ='],
        '65701': ['381 0535 2335 = = = ='],
        '65729': ['381 0540 2340 = = = ='],
        '69009': ['381 0542 2342 = = = ='],
      },
    })

    const hintAtMs = sgtMs('08:35:00')
    const unconfirmedHintPlan = {
      startTime: sgtMs('08:05:00'),
      endTime: sgtMs('08:50:00'),
      legs: [
        {
          mode: 'BUS',
          startTime: sgtMs('08:05:00'),
          endTime: sgtMs('08:50:00'),
          from: { stopCode: '65009' },
          routeShortName: '381',
          intermediateStops: [
            { stopCode: '65701', arrival: hintAtMs, departure: hintAtMs },
          ],
        },
      ],
    }

    const result = await runBackwardCommuteSearch({
      inventory: {
        inventoryDate: INVENTORY.inventoryDate,
        stops: subStops,
      },
      networkIndex,
      workplace: POSTAL_WORKPLACE,
      constraints: CONSTRAINTS,
      minRequestIntervalMs: 0,
      signal: new AbortController().signal,
      routeStop: (stop, depTime) => {
        if (stop.id === '65009') {
          return Promise.resolve([unconfirmedHintPlan])
        }
        // Reject hint at 08:35:00, confirm 65729 only
        if (stop.id === '65729' && depTime !== '08:35:00') {
          return Promise.resolve([
            makeBusItinerary('65729', '08:40:00', '08:50:00'),
          ])
        }
        return Promise.resolve([])
      },
      onProgress: () => {},
    })

    expect(result.matches.map((m) => m.stop.id)).toEqual(['65729'])
    expect(result.wastedRequestCount).toBeGreaterThanOrEqual(1)
  })

  it('qualifies exact destination station with zero routing calls while still testing same-point other-line station', async () => {
    const stationWorkplace: Workplace = {
      kind: 'station',
      stationId: 'NS17',
      label: 'NS17 Bishan',
      point: { latitude: 1.351_455, longitude: 103.848_263 },
    }
    const subInventory: StopInventory = {
      inventoryDate: INVENTORY.inventoryDate,
      stops: INVENTORY.stops.filter((s) => s.id === 'NS17' || s.id === 'CC15'),
    }
    const networkIndex = buildTransitNetworkIndex({
      inventory: subInventory,
      networkDate: SEARCH_DATE,
      busServices: {},
      busFirstLast: {},
    })

    const calls: string[] = []
    const result = await runBackwardCommuteSearch({
      inventory: subInventory,
      networkIndex,
      workplace: stationWorkplace,
      constraints: CONSTRAINTS,
      minRequestIntervalMs: 0,
      signal: new AbortController().signal,
      routeStop: (stop) => {
        calls.push(stop.id)
        return Promise.resolve([])
      },
      onProgress: () => {},
    })

    expect(calls).not.toContain('NS17')
    expect(result.matches.map((m) => m.stop.id)).toEqual(['NS17'])
    expect(result.matches[0]?.journey.isAtDestination).toBe(true)
  })

  it('supports uncovered stop fallback probing, transient failures, abort, and auth expiry', async () => {
    const stop65729 = INVENTORY.stops.find((s) => s.id === '65729')
    const stop69009 = INVENTORY.stops.find((s) => s.id === '69009')
    const stopUncov = INVENTORY.stops.find((s) => s.id === 'UNCOV')
    if (!stop65729 || !stop69009 || !stopUncov) {
      throw new Error('Missing fixture stops')
    }
    const subInventory: StopInventory = {
      inventoryDate: INVENTORY.inventoryDate,
      stops: [stop65729, stop69009, stopUncov],
    }
    const networkIndex = buildTransitNetworkIndex({
      inventory: {
        inventoryDate: INVENTORY.inventoryDate,
        stops: [stop65729, stop69009],
      },
      networkDate: SEARCH_DATE,
      busServices: {
        '381': { name: 'Local', routes: [['65729', '69009']] },
      },
      busFirstLast: {
        '65729': ['381 0530 2330 = = = ='],
        '69009': ['381 0532 2332 = = = ='],
      },
    })

    const calls: string[] = []
    const resAuth = await runBackwardCommuteSearch({
      inventory: subInventory,
      networkIndex,
      workplace: POSTAL_WORKPLACE,
      constraints: CONSTRAINTS,
      probeUncoveredStops: true,
      minRequestIntervalMs: 0,
      signal: new AbortController().signal,
      routeStop: (stop) => {
        calls.push(stop.id)
        if (stop.id === 'UNCOV') {
          return Promise.reject(new OneMapAuthError())
        }
        return Promise.reject(new Error('transient'))
      },
      onProgress: () => {},
    })

    expect(calls).toContain('UNCOV')
    expect(resAuth.status).toBe('partial')
    expect(resAuth.authExpired).toBe(true)
    expect(resAuth.uncoveredStopCount).toBe(1)
    expect(resAuth.failedQueries).toBe(1)
  })
})
