import { describe, expect, it } from 'bun:test'
import {
  createDestinationStationJourney,
  evaluateItinerary,
  findFirstQualifyingJourney,
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

const STOP_BUS_66421: Stop = {
  id: '66421',
  kind: 'bus',
  name: 'Blk 987C',
  point: { latitude: 1.388, longitude: 103.89 },
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

const sgtMs = (clock: string, offsetMs = 0): number => {
  const [hhMm = '00:00', secStr = '0'] = clock.split(':')
  const parts = clock.split(':')
  const base = parseSingaporeDateTimeMs(
    SEARCH_DATE,
    `${parts[0] ?? '00'}:${parts[1] ?? '00'}`,
  )
  const seconds = parts.length === 3 ? Number(parts[2] ?? secStr) : 0
  return base + seconds * 1000 + offsetMs - (hhMm ? 0 : 0)
}

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

describe('itinerary qualification rules', () => {
  it('qualifies a 28-min ride + 10-min transfer arriving at 08:58', () => {
    const raw = {
      startTime: sgtMs('08:20:00'),
      endTime: sgtMs('08:58:00'),
      walkLimitExceeded: false,
      legs: [
        {
          mode: 'BUS',
          startTime: sgtMs('08:20:00'),
          endTime: sgtMs('08:35:00'),
          from: { stopCode: '66421' },
          routeShortName: '116',
          routeId: '116',
        },
        {
          mode: 'WALK',
          startTime: sgtMs('08:35:00'),
          endTime: sgtMs('08:40:00'),
          from: { stopCode: '65009' },
        },
        {
          mode: 'SUBWAY',
          startTime: sgtMs('08:45:00'),
          endTime: sgtMs('08:58:00'),
          from: { stopCode: 'NE17' },
          routeShortName: 'NE',
          routeId: 'NE',
        },
      ],
    }

    const journey = evaluateItinerary(STOP_BUS_66421, CONSTRAINTS, raw)
    expect(journey).not.toBeNull()
    expect(journey?.rideMs).toBe(28 * 60_000)
    expect(journey?.boardingAtMs).toBe(sgtMs('08:20:00'))
    expect(journey?.arrivalAtMs).toBe(sgtMs('08:58:00'))
    expect(journey?.services).toEqual([
      { id: '116', name: '116', mode: 'BUS' },
      { id: 'NE', name: 'NE', mode: 'SUBWAY' },
    ])
  })

  it('rejects a 12-min ride arriving at 08:44 (before arrival window)', () => {
    const raw = {
      startTime: sgtMs('08:32:00'),
      endTime: sgtMs('08:44:00'),
      legs: [
        {
          mode: 'BUS',
          startTime: sgtMs('08:32:00'),
          endTime: sgtMs('08:44:00'),
          from: { stopCode: '66421' },
          routeShortName: '116',
        },
      ],
    }

    expect(evaluateItinerary(STOP_BUS_66421, CONSTRAINTS, raw)).toBeNull()
  })

  it('enforces inclusive arrival window and ride cap down to 1 millisecond', () => {
    const makeSingleLeg = (
      startMs: number,
      rideDurationMs: number,
      finalWalkMs = 0,
    ) => ({
      startTime: startMs,
      endTime: startMs + rideDurationMs + finalWalkMs,
      legs: [
        {
          mode: 'BUS',
          startTime: startMs,
          endTime: startMs + rideDurationMs,
          from: { stopCode: '66421' },
          routeShortName: '116',
        },
        ...(finalWalkMs > 0
          ? [
              {
                mode: 'WALK',
                startTime: startMs + rideDurationMs,
                endTime: startMs + rideDurationMs + finalWalkMs,
              },
            ]
          : []),
      ],
    })

    // Exactly 08:45:00.000 and 30m00.000s qualifies
    expect(
      evaluateItinerary(
        STOP_BUS_66421,
        CONSTRAINTS,
        makeSingleLeg(sgtMs('08:15:00'), 1_800_000),
      ),
    ).not.toBeNull()

    // 08:44:59.999 fails
    expect(
      evaluateItinerary(
        STOP_BUS_66421,
        CONSTRAINTS,
        makeSingleLeg(sgtMs('08:15:00', -1), 1_800_000),
      ),
    ).toBeNull()

    // Exactly 09:00:00.000 and 30m00.000s qualifies
    expect(
      evaluateItinerary(
        STOP_BUS_66421,
        CONSTRAINTS,
        makeSingleLeg(sgtMs('08:30:00'), 1_800_000),
      ),
    ).not.toBeNull()

    // 09:00:00.001 fails
    expect(
      evaluateItinerary(
        STOP_BUS_66421,
        CONSTRAINTS,
        makeSingleLeg(sgtMs('08:30:00', 1), 1_800_000),
      ),
    ).toBeNull()

    // 30m00.001s ride fails even inside arrival window
    expect(
      evaluateItinerary(
        STOP_BUS_66421,
        CONSTRAINTS,
        makeSingleLeg(sgtMs('08:25:00'), 1_800_001),
      ),
    ).toBeNull()

    // Final walk pushes arrival past 09:00:00.000 -> fails
    expect(
      evaluateItinerary(
        STOP_BUS_66421,
        CONSTRAINTS,
        makeSingleLeg(sgtMs('08:40:00'), 1_000_000, 200_001),
      ),
    ).toBeNull()

    // Final walk brings an otherwise too-early transit leg into 08:45:00 -> qualifies
    expect(
      evaluateItinerary(
        STOP_BUS_66421,
        CONSTRAINTS,
        makeSingleLeg(sgtMs('08:25:00'), 1_000_000, 200_000),
      ),
    ).not.toBeNull()
  })

  it('rejects initial walk to a different boarding stop and supports stopId suffix fallback', () => {
    const walkedToOtherStop = {
      startTime: sgtMs('08:20:00'),
      endTime: sgtMs('08:50:00'),
      legs: [
        {
          mode: 'WALK',
          startTime: sgtMs('08:20:00'),
          endTime: sgtMs('08:25:00'),
        },
        {
          mode: 'BUS',
          startTime: sgtMs('08:25:00'),
          endTime: sgtMs('08:50:00'),
          from: { stopCode: '65009' },
          routeShortName: '43',
        },
      ],
    }
    expect(
      evaluateItinerary(STOP_BUS_66421, CONSTRAINTS, walkedToOtherStop),
    ).toBeNull()

    const viaStopIdSuffix = {
      startTime: sgtMs('08:30:00'),
      endTime: sgtMs('08:50:00'),
      legs: [
        {
          mode: 'SUBWAY',
          startTime: sgtMs('08:30:00'),
          endTime: sgtMs('08:50:00'),
          from: { stopCode: null, stopId: '1:NS17' },
          routeLongName: 'North South Line',
          routeId: 'NS',
        },
      ],
    }
    const matched = evaluateItinerary(STOP_NS17, CONSTRAINTS, viaStopIdSuffix)
    expect(matched?.stopId).toBe('NS17')
    expect(matched?.services).toEqual([
      { id: 'NS', name: 'North South Line', mode: 'SUBWAY' },
    ])

    const emptyStopCodeFallback = {
      ...viaStopIdSuffix,
      legs: [
        {
          mode: 'SUBWAY',
          startTime: sgtMs('08:30:00'),
          endTime: sgtMs('08:50:00'),
          from: { stopCode: '', stopId: '1:NS17' },
          routeLongName: 'North South Line',
          routeId: 'NS',
        },
      ],
    }
    expect(
      evaluateItinerary(STOP_NS17, CONSTRAINTS, emptyStopCodeFallback)?.stopId,
    ).toBe('NS17')
  })

  it('rejects non-transit modes, walkLimitExceeded, and cross-date boarding', () => {
    const withCar = {
      startTime: sgtMs('08:30:00'),
      endTime: sgtMs('08:50:00'),
      legs: [
        {
          mode: 'CAR',
          startTime: sgtMs('08:30:00'),
          endTime: sgtMs('08:40:00'),
        },
        {
          mode: 'BUS',
          startTime: sgtMs('08:40:00'),
          endTime: sgtMs('08:50:00'),
          from: { stopCode: '66421' },
          routeShortName: '116',
        },
      ],
    }
    expect(evaluateItinerary(STOP_BUS_66421, CONSTRAINTS, withCar)).toBeNull()

    const walkExceeded = {
      startTime: sgtMs('08:30:00'),
      endTime: sgtMs('08:50:00'),
      walkLimitExceeded: true,
      legs: [
        {
          mode: 'BUS',
          startTime: sgtMs('08:30:00'),
          endTime: sgtMs('08:50:00'),
          from: { stopCode: '66421' },
          routeShortName: '116',
        },
      ],
    }
    expect(
      evaluateItinerary(STOP_BUS_66421, CONSTRAINTS, walkExceeded),
    ).toBeNull()

    const previousDayBoard = {
      startTime: Date.parse('2026-06-01T23:55:00+08:00'),
      endTime: sgtMs('08:50:00'),
      legs: [
        {
          mode: 'BUS',
          startTime: Date.parse('2026-06-01T23:55:00+08:00'),
          endTime: sgtMs('08:50:00'),
          from: { stopCode: '66421' },
          routeShortName: '116',
        },
      ],
    }
    expect(
      evaluateItinerary(STOP_BUS_66421, CONSTRAINTS, previousDayBoard),
    ).toBeNull()
  })

  it('throws on malformed itinerary payloads and returns first qualifying match', () => {
    expect(() =>
      evaluateItinerary(STOP_BUS_66421, CONSTRAINTS, { legs: [] }),
    ).toThrow()

    const first = findFirstQualifyingJourney(STOP_BUS_66421, CONSTRAINTS, [
      {
        startTime: sgtMs('08:32:00'),
        endTime: sgtMs('08:44:00'),
        legs: [
          {
            mode: 'BUS',
            startTime: sgtMs('08:32:00'),
            endTime: sgtMs('08:44:00'),
            from: { stopCode: '66421' },
            routeShortName: '116',
          },
        ],
      },
      {
        startTime: sgtMs('08:35:00'),
        endTime: sgtMs('08:55:00'),
        legs: [
          {
            mode: 'BUS',
            startTime: sgtMs('08:35:00'),
            endTime: sgtMs('08:55:00'),
            from: { stopCode: '66421' },
            routeShortName: '88',
          },
        ],
      },
    ])
    expect(first?.services[0]?.name).toBe('88')
  })
})
