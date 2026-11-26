import { describe, expect, it } from 'bun:test'
import {
  type RunBackwardSearchOptions,
  runBackwardCommuteSearch,
} from '@lib/backward-search.js'
import type { Stop } from '@lib/commute-types.js'
import { OneMapAuthError } from '@lib/onemap-client.js'
import { parseSingaporeDateTimeMs } from '@lib/singapore-calendar.js'

const searchDate = '2026-11-26'
const point = { latitude: 1.404, longitude: 103.902 }
const stop = (id: string, kind: Stop['kind'] = 'bus'): Stop => ({
  id,
  name: id,
  kind,
  point,
})
const origin = stop('origin')
const transfer = stop('transfer')
const last = stop('last')
const outside = stop('outside')
const destination = stop('NS17', 'rail')
const interchange = stop('CC15', 'rail')
const inventory = {
  inventoryDate: searchDate,
  stops: [origin, transfer, last, outside, destination, interchange],
}
const time = (clock: string) => parseSingaporeDateTimeMs(searchDate, clock)
const lead = (stop: Stop) => ({
  stop,
  candidateDepartures: ['08:25:00'],
  minRideMs: 0,
  estRideMs: 0,
  transfers: 0,
})

const verify = (
  options: Pick<RunBackwardSearchOptions, 'routeStop'> &
    Partial<RunBackwardSearchOptions>,
) =>
  runBackwardCommuteSearch({
    inventory,
    plan: { leads: [lead(origin), lead(transfer)], uncoveredStopIds: [] },
    constraints: { searchDate, officeStart: '09:00', rideCapMinutes: 30 },
    workplace: { kind: 'postal', postalCode: '828616', label: 'Work', point },
    signal: new AbortController().signal,
    minRequestIntervalMs: 0,
    onProgress: () => {},
    ...options,
  })

const bus = (stop: Stop, board: string, alight: string) => ({
  mode: 'BUS',
  startTime: time(board),
  endTime: time(alight),
  from: { stopCode: stop.id },
  routeShortName: '381',
})

describe('backward-search verification', () => {
  it('reuses a confirmed transfer even when the whole ride exceeds the cap', async () => {
    const calls: string[] = []
    const result = await verify({
      routeStop: (stop) => {
        calls.push(stop.id)
        return Promise.resolve([
          {
            startTime: time('08:05'),
            endTime: time('08:59'),
            legs: [
              bus(origin, '08:05', '08:30'),
              bus(transfer, '08:35', '08:55'),
              {
                mode: 'WALK',
                startTime: time('08:55'),
                endTime: time('08:59'),
              },
            ],
          },
        ])
      },
    })
    expect(calls).toEqual([origin.id])
    expect(result).toMatchObject({
      status: 'completed',
      triedCount: 2,
      matches: [
        {
          stop: transfer,
          journey: { rideMs: 20 * 60_000, arrivalAtMs: time('08:59') },
        },
      ],
    })
  })

  it('checks transitive hints after the final planned probe; hints alone never qualify', async () => {
    const calls: string[] = []
    const result = await verify({
      plan: { leads: [lead(origin)], uncoveredStopIds: [] },
      routeStop: (stop, departure) => {
        calls.push(`${stop.id}@${departure}`)
        if (stop.id === last.id) return Promise.resolve([])
        const next = stop.id === origin.id ? transfer : last
        const leg = bus(stop, departure.slice(0, 5), '08:52')
        return Promise.resolve([
          {
            startTime: leg.startTime,
            endTime: leg.endTime,
            legs: [
              {
                ...leg,
                intermediateStops: [
                  {
                    stopCode: next.id,
                    departure: time(next === transfer ? '08:30' : '08:38'),
                  },
                ],
              },
            ],
          },
        ])
      },
    })
    expect(calls).toEqual([
      'origin@08:25:00',
      'transfer@08:30:00',
      'last@08:38:00',
    ])
    expect(result.matches.map((match) => match.stop.id)).toEqual([
      origin.id,
      transfer.id,
    ])
  })

  it('seeds only the exact destination station without a query', async () => {
    const calls: string[] = []
    const result = await verify({
      workplace: {
        kind: 'station',
        stationId: destination.id,
        label: 'Bishan',
        point,
      },
      plan: {
        leads: [lead(destination), lead(interchange)],
        uncoveredStopIds: [],
      },
      routeStop: (stop) => {
        calls.push(stop.id)
        return Promise.resolve([])
      },
    })
    expect(calls).toEqual([interchange.id])
    expect(result.matches).toMatchObject([
      { stop: destination, journey: { isAtDestination: true, rideMs: 0 } },
    ])
  })

  it('continues to uncovered stops after a failed probe, but stops on auth expiry', async () => {
    const calls: string[] = []
    const result = await verify({
      plan: { leads: [lead(origin)], uncoveredStopIds: [outside.id, last.id] },
      routeStop: (stop) => {
        calls.push(stop.id)
        return Promise.reject(
          stop.id === outside.id
            ? new OneMapAuthError()
            : new Error('HTTP 500'),
        )
      },
    })
    expect(calls).toEqual([origin.id, outside.id])
    expect(result).toMatchObject({
      status: 'partial',
      authExpired: true,
      failedQueries: 1,
      triedCount: 0,
    })
  })

  it('stops before the next probe on cancellation', async () => {
    const controller = new AbortController()
    const calls: string[] = []
    const result = await verify({
      signal: controller.signal,
      routeStop: (stop) => {
        calls.push(stop.id)
        controller.abort()
        return Promise.resolve([])
      },
    })
    expect(calls).toEqual([origin.id])
    expect(result.status).toBe('partial')
  })

  it.each([true, false])(
    'distinguishes a failed query from an empty plan (failed=%s)',
    async (failed) => {
      const result = await verify({
        routeStop: () =>
          failed ? Promise.reject(new Error('HTTP 500')) : Promise.resolve([]),
      })
      expect(result).toMatchObject({
        status: failed ? 'partial' : 'completed',
        authExpired: false,
        triedCount: failed ? 0 : 2,
        failedQueries: failed ? 2 : 0,
        matches: [],
      })
    },
  )
})
