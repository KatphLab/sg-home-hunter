import { describe, expect, it } from 'bun:test'
import type {
  SearchConstraints,
  StopInventory,
  Workplace,
} from '@lib/commute-types.js'
import { OneMapAuthError } from '@lib/onemap-client.js'
import {
  buildDepartureSchedule,
  runCommuteSearch,
} from '@lib/search-scheduler.js'
import { parseSingaporeDateTimeMs } from '@lib/singapore-calendar.js'

const CONSTRAINTS: SearchConstraints = {
  searchDate: '2026-06-02',
  officeStart: '09:00',
  rideCapMinutes: 30,
}

const INVENTORY: StopInventory = {
  inventoryDate: '2026-11-24',
  stops: [
    {
      id: '44009',
      kind: 'bus',
      name: 'Distant West',
      point: { latitude: 1.38, longitude: 103.76 },
    },
    {
      id: '65009',
      kind: 'bus',
      name: 'Nearby East',
      point: { latitude: 1.3, longitude: 103.86 },
    },
    {
      id: 'NS17',
      kind: 'rail',
      name: 'Bishan',
      point: { latitude: 1.351, longitude: 103.848 },
    },
    {
      id: 'CC15',
      kind: 'rail',
      name: 'Bishan',
      point: { latitude: 1.351, longitude: 103.848 },
    },
  ],
}

const makeRawItinerary = (
  stopId: string,
  boardClock: string,
  arriveClock: string,
) => {
  const boardMs = parseSingaporeDateTimeMs('2026-06-02', boardClock)
  const arriveMs = parseSingaporeDateTimeMs('2026-06-02', arriveClock)
  return {
    startTime: boardMs,
    endTime: arriveMs,
    legs: [
      {
        mode: 'BUS',
        startTime: boardMs,
        endTime: arriveMs,
        from: { stopCode: stopId },
        routeShortName: '116',
      },
    ],
  }
}

describe('search-scheduler', () => {
  it('orders departure schedule around deadline minus (rideCap + 15m)', () => {
    const schedule = buildDepartureSchedule('09:00', 30, 15)
    expect(schedule[0]).toBe('08:15:00')
    expect(schedule[1]).toBe('08:00:00')
    expect(schedule[2]).toBe('08:30:00')

    const earlySchedule = buildDepartureSchedule('06:30', 20, 30)
    expect(earlySchedule).toContain('06:00:00')
    expect(() => buildDepartureSchedule('09:00', 30, 0)).toThrow()
  })

  it('checks all stops on pass 1 before revisiting unmatched stops, keeps first match, and allows stop', async () => {
    const workplace: Workplace = {
      kind: 'postal',
      postalCode: '018989',
      label: 'Marina',
      point: { latitude: 1.28, longitude: 103.85 },
    }
    const calls: string[] = []
    const controller = new AbortController()
    let pass1Complete = false

    const result = await runCommuteSearch({
      inventory: {
        inventoryDate: INVENTORY.inventoryDate,
        stops: INVENTORY.stops.slice(0, 2),
      },
      workplace,
      constraints: CONSTRAINTS,
      minRequestIntervalMs: 0,
      signal: controller.signal,
      routeStop: (stop, departureTime) => {
        calls.push(`${stop.id}@${departureTime}`)
        if (stop.id === '44009' && departureTime === '08:10:00') {
          return Promise.resolve([makeRawItinerary('44009', '08:20', '08:50')])
        }
        if (stop.id === '65009' && departureTime === '08:20:00') {
          return Promise.resolve([makeRawItinerary('65009', '08:25', '08:52')])
        }
        return Promise.resolve([])
      },
      onProgress: (progress) => {
        if (progress.triedCount === 2 && progress.matchedCount === 1) {
          pass1Complete = true
        }
      },
    })

    expect(pass1Complete).toBe(true)
    expect(result.status).toBe('completed')
    expect(result.matches.map((m) => m.stop.id)).toEqual(['44009', '65009'])
    expect(calls.filter((c) => c.startsWith('44009@'))).toEqual([
      '44009@08:10:00',
    ])
  })

  it('qualifies exact destination station with zero routing calls and yields partial on abort', async () => {
    const stationWorkplace: Workplace = {
      kind: 'station',
      stationId: 'NS17',
      label: 'NS17 Bishan',
      point: { latitude: 1.351, longitude: 103.848 },
    }
    const calls: string[] = []
    const controller = new AbortController()

    const result = await runCommuteSearch({
      inventory: INVENTORY,
      workplace: stationWorkplace,
      constraints: CONSTRAINTS,
      minRequestIntervalMs: 0,
      signal: controller.signal,
      routeStop: (stop) => {
        calls.push(stop.id)
        if (calls.length === 3) {
          controller.abort()
        }
        return Promise.resolve([])
      },
      onProgress: () => {},
    })

    expect(calls).not.toContain('NS17')
    expect(calls).toContain('CC15')
    expect(result.status).toBe('partial')
    expect(result.matches.map((m) => m.stop.id)).toEqual(['NS17'])
    expect(result.matches[0]?.journey.isAtDestination).toBe(true)
  })

  it('handles per-stop query failures without halting and stops cleanly on auth error', async () => {
    const workplace: Workplace = {
      kind: 'postal',
      postalCode: '018989',
      label: 'Marina',
      point: { latitude: 1.28, longitude: 103.85 },
    }
    const controller = new AbortController()

    const authResult = await runCommuteSearch({
      inventory: {
        inventoryDate: INVENTORY.inventoryDate,
        stops: INVENTORY.stops.slice(0, 2),
      },
      workplace,
      constraints: CONSTRAINTS,
      minRequestIntervalMs: 5,
      delayFn: () => Promise.resolve(),
      signal: controller.signal,
      routeStop: (stop) => {
        if (stop.id === '44009') {
          return Promise.reject(new Error('Temporary failure'))
        }
        return Promise.reject(new OneMapAuthError())
      },
      onProgress: () => {},
    })

    expect(authResult.status).toBe('partial')
    expect(authResult.authExpired).toBe(true)
    expect(authResult.failedQueries).toBe(1)
    expect(authResult.triedCount).toBe(1)
  })
})
