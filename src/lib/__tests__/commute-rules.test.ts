import { describe, expect, it } from 'bun:test'
import {
  createDestinationStationJourney,
  evaluateBoardings,
  isDestinationStationMatch,
} from '@lib/commute-rules.js'
import type { SearchConstraints, Stop, Workplace } from '@lib/commute-types.js'
import { parseSingaporeDateTimeMs } from '@lib/singapore-calendar.js'

const SEARCH_DATE = '2026-06-02'
const CONSTRAINTS: SearchConstraints = {
  searchDate: SEARCH_DATE,
  officeStart: '09:00',
  rideCapMinutes: 30,
}

const STOP_NS17: Stop = {
  id: 'NS17',
  kind: 'rail',
  name: 'Bishan',
  point: { latitude: 1.351_455, longitude: 103.848_263 },
}

const STOP_CC15: Stop = {
  id: 'CC15',
  kind: 'rail',
  name: 'Bishan',
  point: { latitude: 1.351_455, longitude: 103.848_263 },
}

const sgtMs = (clock: string, offsetMs = 0): number =>
  parseSingaporeDateTimeMs(SEARCH_DATE, clock.slice(0, 5)) +
  Number(clock.slice(6) || 0) * 1000 +
  offsetMs

describe('station identity rules', () => {
  it('qualifies only exact destination station ID and not another line ID at same point', () => {
    const stationWorkplace: Workplace = {
      kind: 'station',
      stationId: 'NS17',
      label: 'NS17 Bishan',
      point: STOP_NS17.point,
    }
    const postalWorkplace: Workplace = {
      kind: 'postal',
      postalCode: '579837',
      label: 'Bishan Place',
      point: STOP_NS17.point,
    }

    expect(isDestinationStationMatch(STOP_NS17, stationWorkplace)).toBe(true)
    expect(isDestinationStationMatch(STOP_CC15, stationWorkplace)).toBe(false)
    expect(isDestinationStationMatch(STOP_NS17, postalWorkplace)).toBe(false)

    const journey = createDestinationStationJourney(
      STOP_NS17,
      SEARCH_DATE,
      '09:00',
    )
    expect(journey.isAtDestination).toBe(true)
    expect(journey.rideMs).toBe(0)
    expect(journey.boardingAtMs).toBe(sgtMs('09:00:00'))
    expect(journey.arrivalAtMs).toBe(sgtMs('09:00:00'))
    expect(journey.services).toEqual([])
  })
})

const busLeg = (startTime: number, endTime: number, stopCode = '66421') => ({
  mode: 'BUS',
  startTime,
  endTime,
  from: { stopCode },
  routeShortName: '116',
})

const singleRide = (startMs: number, rideMs: number, finalWalkMs = 0) => ({
  startTime: startMs,
  endTime: startMs + rideMs + finalWalkMs,
  legs: [
    busLeg(startMs, startMs + rideMs),
    ...(finalWalkMs > 0
      ? [
          {
            mode: 'WALK',
            startTime: startMs + rideMs,
            endTime: startMs + rideMs + finalWalkMs,
          },
        ]
      : []),
  ],
})

describe('boarding qualification rules', () => {
  it('qualifies actual boarding origins with only their remaining ride and services', () => {
    const result = evaluateBoardings(CONSTRAINTS, {
      startTime: sgtMs('08:20'),
      endTime: sgtMs('08:58'),
      legs: [
        busLeg(sgtMs('08:20'), sgtMs('08:35')),
        { mode: 'WALK', startTime: sgtMs('08:35'), endTime: sgtMs('08:40') },
        {
          mode: 'SUBWAY',
          startTime: sgtMs('08:45'),
          endTime: sgtMs('08:58'),
          from: { stopCode: 'NE17' },
          routeShortName: 'NE',
          routeId: 'NE',
        },
      ],
    })
    expect(result.hints).toEqual([])
    expect(result.journeys).toEqual([
      {
        stopId: '66421',
        searchDate: SEARCH_DATE,
        boardingAtMs: sgtMs('08:20'),
        arrivalAtMs: sgtMs('08:58'),
        rideMs: 28 * 60_000,
        services: [
          { id: '116', name: '116', mode: 'BUS' },
          { id: 'NE', name: 'NE', mode: 'SUBWAY' },
        ],
        isAtDestination: false,
      },
      {
        stopId: 'NE17',
        searchDate: SEARCH_DATE,
        boardingAtMs: sgtMs('08:45'),
        arrivalAtMs: sgtMs('08:58'),
        rideMs: 13 * 60_000,
        services: [{ id: 'NE', name: 'NE', mode: 'SUBWAY' }],
        isAtDestination: false,
      },
    ])
  })

  it.each([
    ['08:15', 1_800_000, 0, 0, true],
    ['08:15', 1_800_000, 0, -1, false],
    ['08:30', 1_800_000, 0, 0, true],
    ['08:30', 1_800_000, 0, 1, false],
    ['08:25', 1_800_001, 0, 0, false],
    ['08:40', 1_000_000, 200_001, 0, false],
    ['08:25', 1_000_000, 200_000, 0, true],
    ['08:32', 720_000, 0, 0, false],
  ] as const)(
    'preserves millisecond arrival, final walk and ride limits (%s, %d, %d, %d)',
    (clock, rideMs, walkMs, offsetMs, qualifies) => {
      const result = evaluateBoardings(
        CONSTRAINTS,
        singleRide(sgtMs(clock, offsetMs), rideMs, walkMs),
      )
      expect(result.journeys.length).toBe(qualifies ? 1 : 0)
    },
  )

  it('uses the boarding origin after an initial walk, not the queried origin', () => {
    const result = evaluateBoardings(CONSTRAINTS, {
      startTime: sgtMs('08:20'),
      endTime: sgtMs('08:50'),
      legs: [
        { mode: 'WALK', startTime: sgtMs('08:20'), endTime: sgtMs('08:25') },
        busLeg(sgtMs('08:25'), sgtMs('08:50'), '65009'),
      ],
    })
    expect(result.journeys.map((journey) => journey.stopId)).toEqual(['65009'])
  })

  it.each([null, ''])(
    'supports stopId suffix fallback for stopCode %s',
    (stopCode) => {
      const result = evaluateBoardings(CONSTRAINTS, {
        startTime: sgtMs('08:30'),
        endTime: sgtMs('08:50'),
        legs: [
          {
            mode: 'SUBWAY',
            startTime: sgtMs('08:30'),
            endTime: sgtMs('08:50'),
            from: { stopCode, stopId: '1:NS17' },
            routeLongName: 'North South Line',
            routeId: 'NS',
          },
        ],
      })
      expect(result.journeys[0]?.stopId).toBe('NS17')
      expect(result.journeys[0]?.services).toEqual([
        { id: 'NS', name: 'North South Line', mode: 'SUBWAY' },
      ])
    },
  )

  it('qualifies downstream even when an earlier ride exceeds the cap or crosses dates', () => {
    const previousDay = Date.parse('2026-06-01T23:55:00+08:00')
    const result = evaluateBoardings(CONSTRAINTS, {
      startTime: previousDay,
      endTime: sgtMs('08:55'),
      legs: [
        busLeg(previousDay, sgtMs('08:40')),
        busLeg(sgtMs('08:45'), sgtMs('08:55'), '65009'),
      ],
    })
    expect(result.journeys.map((journey) => journey.stopId)).toEqual(['65009'])
    expect(result.journeys[0]?.rideMs).toBe(600_000)
  })

  it('rejects a previous-date boarding and a different-date arrival', () => {
    const previousDay = Date.parse('2026-06-01T23:55:00+08:00')
    expect(
      evaluateBoardings(CONSTRAINTS, {
        startTime: previousDay,
        endTime: sgtMs('08:50'),
        legs: [busLeg(previousDay, sgtMs('08:50'))],
      }),
    ).toEqual({ journeys: [], hints: [] })
    const nextDay = sgtMs('08:30') + 86_400_000
    expect(
      evaluateBoardings(CONSTRAINTS, singleRide(nextDay, 20 * 60_000)),
    ).toEqual({ journeys: [], hints: [] })
  })

  it('does not prove reboarding on interlined legs but retains their ride and services', () => {
    const result = evaluateBoardings(CONSTRAINTS, {
      startTime: sgtMs('08:25'),
      endTime: sgtMs('08:50'),
      legs: [
        busLeg(sgtMs('08:25'), sgtMs('08:35')),
        {
          ...busLeg(sgtMs('08:35'), sgtMs('08:50'), '65009'),
          routeShortName: '88',
          interlineWithPreviousLeg: true,
        },
      ],
    })
    expect(result.journeys.map((journey) => journey.stopId)).toEqual(['66421'])
    expect(result.journeys[0]?.rideMs).toBe(25 * 60_000)
    expect(result.journeys[0]?.services.map((service) => service.name)).toEqual(
      ['116', '88'],
    )
  })

  it('emits only timed, pickup-allowed intermediate hints with qualifying suffixes', () => {
    const result = evaluateBoardings(CONSTRAINTS, {
      startTime: sgtMs('08:00'),
      endTime: sgtMs('08:58'),
      legs: [
        {
          ...busLeg(sgtMs('08:00'), sgtMs('08:40')),
          intermediateStops: [
            { stopCode: 'too-long', departure: sgtMs('08:05') },
            { stopCode: 'timed', departure: sgtMs('08:20') },
            { stopId: '1:rail', departure: sgtMs('08:25') },
            { stopCode: 'untimed' },
            { stopCode: 'arrival-only', arrival: sgtMs('08:25') },
            { stopCode: 'forbidden', departure: sgtMs('08:25'), pickupType: 1 },
            { stopCode: 'none', departure: sgtMs('08:25'), pickupType: 'NONE' },
            { stopCode: 'outside-leg', departure: sgtMs('08:45') },
          ],
        },
        busLeg(sgtMs('08:45'), sgtMs('08:55'), 'transfer'),
        { mode: 'WALK', startTime: sgtMs('08:55'), endTime: sgtMs('08:58') },
      ],
    })
    expect(result.journeys.map((journey) => journey.stopId)).toEqual([
      'transfer',
    ])
    expect(result.hints).toEqual([
      { stopId: 'timed', departureMs: sgtMs('08:20') },
      { stopId: 'rail', departureMs: sgtMs('08:25') },
    ])
    expect(result.journeys[0]?.arrivalAtMs).toBe(sgtMs('08:58'))
  })

  it('rejects walk-limit violations and unsupported suffixes, but not unsupported prefixes', () => {
    const transit = busLeg(sgtMs('08:30'), sgtMs('08:50'))
    const car = {
      mode: 'CAR',
      startTime: sgtMs('08:50'),
      endTime: sgtMs('08:55'),
    }
    expect(
      evaluateBoardings(CONSTRAINTS, {
        startTime: transit.startTime,
        endTime: car.endTime,
        legs: [transit, car],
      }),
    ).toEqual({ journeys: [], hints: [] })
    expect(
      evaluateBoardings(CONSTRAINTS, {
        ...singleRide(sgtMs('08:30'), 20 * 60_000),
        walkLimitExceeded: true,
      }),
    ).toEqual({ journeys: [], hints: [] })
    expect(
      evaluateBoardings(CONSTRAINTS, {
        startTime: sgtMs('08:20'),
        endTime: transit.endTime,
        legs: [
          { ...car, startTime: sgtMs('08:20'), endTime: sgtMs('08:30') },
          transit,
        ],
      }).journeys,
    ).toHaveLength(1)
    expect(
      evaluateBoardings(CONSTRAINTS, {
        startTime: sgtMs('08:30'),
        endTime: sgtMs('08:50'),
        legs: [
          { mode: 'WALK', startTime: sgtMs('08:30'), endTime: sgtMs('08:50') },
        ],
      }),
    ).toEqual({ journeys: [], hints: [] })
  })

  it.each([
    null,
    { legs: [] },
    { startTime: 1, endTime: 2, legs: [] },
    { ...singleRide(sgtMs('08:30'), 600_000), walkLimitExceeded: 'false' },
    {
      startTime: 1,
      endTime: 2,
      legs: [{ mode: 'BUS', startTime: 2, endTime: 1 }],
    },
    {
      startTime: 1,
      endTime: 2,
      legs: [{ mode: 'BUS', startTime: 1, endTime: 2, route: '1' }],
    },
    {
      startTime: 1,
      endTime: 2,
      legs: [
        { mode: 'BUS', startTime: 1, endTime: 2, from: { stopCode: '1' } },
      ],
    },
  ])(
    'throws on malformed payloads even when they cannot qualify: %j',
    (raw) => {
      expect(() => evaluateBoardings(CONSTRAINTS, raw)).toThrow()
    },
  )
})
