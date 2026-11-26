import { describe, expect, it } from 'bun:test'
import { planBackwardLeads } from '@lib/backward-planner.js'
import {
  type RunBackwardSearchOptions,
  runBackwardCommuteSearch,
} from '@lib/backward-search.js'
import type { Stop } from '@lib/commute-types.js'
import { OneMapAuthError } from '@lib/onemap-client.js'
import { parseSingaporeDateTimeMs } from '@lib/singapore-calendar.js'
import { buildTransitNetworkIndex } from '@lib/transit-network.js'

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
  it('limits direct requests by ride cap but keeps proven stops beyond the radius', async () => {
    const far = (id: string) => ({
      ...stop(id),
      point: { ...point, latitude: 1.529 },
    })
    // 13.9 km from work: outside the 30-minute radius, inside the 31-minute radius.
    const planned = far('planned')
    const fallback = far('fallback')
    const hinted = far('hinted')
    const proven = far('proven')
    for (const rideCapMinutes of [30, 31]) {
      const calls = new Set<string>()
      const result = await verify({
        constraints: { searchDate, officeStart: '09:00', rideCapMinutes },
        inventory: {
          ...inventory,
          stops: [origin, planned, fallback, hinted, proven],
        },
        plan: {
          leads: [lead(origin), lead(planned)],
          uncoveredStopIds: [fallback.id],
        },
        routeStop: (from) => {
          calls.add(from.id)
          if (from !== origin) return Promise.resolve([])
          const leg = bus(origin, '08:30', '08:52')
          return Promise.resolve([
            {
              startTime: leg.startTime,
              endTime: leg.endTime,
              legs: [
                {
                  ...leg,
                  intermediateStops: [
                    { stopCode: hinted.id, departure: time('08:35') },
                    {
                      stopCode: proven.id,
                      departure: time('08:40'),
                      pickupType: 0,
                    },
                  ],
                },
              ],
            },
          ])
        },
      })
      expect(calls).toEqual(
        new Set(
          rideCapMinutes === 30
            ? [origin.id]
            : [origin.id, planned.id, fallback.id, hinted.id],
        ),
      )
      expect(result.matches.map(({ stop }) => stop.id)).toContain(proven.id)
    }
  })

  it('verifies a one-minute LRT ride even when the travel estimate exceeds the cap', async () => {
    const rumbia = {
      ...stop('SE2', 'rail'),
      point: { latitude: 1.391_509, longitude: 103.905_937 },
    }
    const workplace = {
      kind: 'station' as const,
      stationId: 'SE1',
      label: 'Compassvale',
      point: { latitude: 1.394_518, longitude: 103.900_435 },
    }
    const inventory = {
      inventoryDate: searchDate,
      stops: [
        rumbia,
        { ...stop('SE1', 'rail'), point: workplace.point },
        {
          ...stop('SE3', 'rail'),
          point: { latitude: 1.388_029, longitude: 103.905_458 },
        },
      ],
    }
    const constraints = { searchDate, officeStart: '09:00', rideCapMinutes: 1 }
    const networkIndex = buildTransitNetworkIndex({
      inventory,
      busRoutes: {},
    })
    const result = await verify({
      inventory,
      workplace,
      constraints,
      plan: planBackwardLeads({
        inventory,
        networkIndex,
        workplace,
        constraints,
      }),
      routeStop: (from, departure) => {
        // An early probe returns the next train, not a train held until office start.
        const startTime = Date.parse(`${searchDate}T${departure}+08:00`)
        const leg = {
          from: { stopCode: from.id },
          startTime,
          endTime: startTime + 60_000,
          mode: 'TRAM',
          routeShortName: 'Sengkang LRT',
        }
        return Promise.resolve([
          { startTime: leg.startTime, endTime: leg.endTime, legs: [leg] },
        ])
      },
    })
    expect(
      result.matches.find((entry) => entry.stop.id === 'SE2')?.journey.rideMs,
    ).toBe(60_000)
  })

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

  it('confirms timed pickups and supersedes pending probes using the remaining journey', async () => {
    const connection = {
      ...bus(transfer, '08:35', '08:55'),
      routeShortName: '87',
    }
    const pickup = { stopCode: last.id, departure: time('08:20') }
    const itinerary = (from: Stop, visits: readonly unknown[]) => ({
      startTime: time('08:05'),
      endTime: time('08:59'),
      legs: [
        { ...bus(from, '08:05', '08:30'), intermediateStops: visits },
        connection,
        { mode: 'WALK', startTime: connection.endTime, endTime: time('08:59') },
      ],
    })
    const calls: string[] = []
    const result = await verify({
      plan: {
        leads: [interchange, origin, last, transfer].map(lead),
        uncoveredStopIds: [],
      },
      routeStop: (from) => {
        calls.push(from.id)
        if (from === interchange)
          return Promise.resolve([itinerary(from, [pickup])])
        return Promise.resolve(
          from === origin
            ? [
                itinerary(from, [
                  { ...pickup, pickupType: 0 },
                  {
                    stopCode: outside.id,
                    departure: time('08:22'),
                    pickupType: 'SCHEDULED',
                  },
                  {
                    stopCode: interchange.id,
                    departure: time('08:19'),
                    pickupType: 0,
                  },
                  {
                    stopCode: destination.id,
                    departure: time('08:23'),
                    pickupType: 'NONE',
                  },
                  { stopCode: interchange.id, pickupType: 0 },
                  {
                    stopCode: 'unknown-stop',
                    departure: time('08:25'),
                    pickupType: 0,
                  },
                ]),
              ]
            : [],
        )
      },
    })
    expect(calls).toEqual([interchange.id, origin.id])
    expect(
      result.matches
        .map(({ stop }) => stop.id)
        .sort((a, b) => a.localeCompare(b)),
    ).toEqual([last.id, outside.id, transfer.id])
    expect(
      result.matches.find(({ stop }) => stop === last)?.journey,
    ).toMatchObject({
      stopId: last.id,
      boardingAtMs: pickup.departure,
      rideMs: 30 * 60_000,
      arrivalAtMs: time('08:59'),
      services: [{ id: '381' }, { id: '87' }],
    })
  })

  it.each([
    ['2026-11-26', '09:01'],
    ['2026-11-25', '08:59'],
  ] as const)(
    'does not reuse a pickup for an ineligible arrival on %s at %s',
    async (date, arrival) => {
      const departure = parseSingaporeDateTimeMs(date, '08:40')
      const endTime = parseSingaporeDateTimeMs(date, arrival)
      const result = await verify({
        plan: { leads: [lead(origin)], uncoveredStopIds: [] },
        routeStop: () =>
          Promise.resolve([
            {
              startTime: departure,
              endTime,
              legs: [
                {
                  ...bus(origin, '08:40', arrival),
                  startTime: departure,
                  endTime,
                  intermediateStops: [
                    {
                      stopCode: last.id,
                      departure: departure + 60_000,
                      pickupType: 0,
                    },
                  ],
                },
              ],
            },
          ]),
      })
      expect(result).toMatchObject({
        status: 'completed',
        failedQueries: 0,
        matches: [],
      })
    },
  )

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

  it.each([1, 2])(
    'honors cancellation with %i pending probe(s)',
    async (count) => {
      const controller = new AbortController()
      const calls: string[] = []
      const result = await verify({
        plan: {
          leads: [lead(origin), lead(transfer)].slice(0, count),
          uncoveredStopIds: [],
        },
        signal: controller.signal,
        routeStop: (stop) => {
          calls.push(stop.id)
          controller.abort()
          return Promise.resolve([])
        },
      })
      expect(calls).toEqual([origin.id])
      expect(result.status).toBe('partial')
    },
  )

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
