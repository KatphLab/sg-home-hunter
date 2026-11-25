import { describe, expect, it } from 'bun:test'
import type { StopInventory } from '@lib/commute-types.js'
import {
  buildTransitNetworkIndex,
  getServiceDayType,
  haversineDistanceMeters,
  parseBusNetworkTsv,
  parseBusRouterFirstLastLine,
  parseGtfsTrainSchedule,
  serializeBusNetworkTsv,
} from '@lib/transit-network.js'

const MINI_INVENTORY: StopInventory = {
  inventoryDate: '2026-11-24',
  stops: [
    {
      id: '65009',
      kind: 'bus',
      name: 'Punggol Int',
      point: { latitude: 1.4038, longitude: 103.9024 },
    },
    {
      id: '65729',
      kind: 'bus',
      name: 'Punggol Coast Stn',
      point: { latitude: 1.4149, longitude: 103.9102 },
    },
    {
      id: '69009',
      kind: 'bus',
      name: 'Punggol Coast Int',
      point: { latitude: 1.4159, longitude: 103.9114 },
    },
    {
      id: 'NE17',
      kind: 'rail',
      name: 'Punggol',
      point: { latitude: 1.405_255, longitude: 103.902_354 },
    },
    {
      id: 'NE18',
      kind: 'rail',
      name: 'Punggol Coast',
      point: { latitude: 1.415_018, longitude: 103.910_329 },
    },
    {
      id: 'PTC',
      kind: 'rail',
      name: 'Punggol',
      point: { latitude: 1.405_255, longitude: 103.902_354 },
    },
    {
      id: 'PE1',
      kind: 'rail',
      name: 'Cove',
      point: { latitude: 1.399_464, longitude: 103.905_852 },
    },
    {
      id: 'CC4',
      kind: 'rail',
      name: 'Promenade',
      point: { latitude: 1.293_854, longitude: 103.860_151 },
    },
    {
      id: 'CC34',
      kind: 'rail',
      name: 'Bayfront',
      point: { latitude: 1.282_535, longitude: 103.859_73 },
    },
    {
      id: 'BP1',
      kind: 'rail',
      name: 'Choa Chu Kang',
      point: { latitude: 1.384_749, longitude: 103.744_534 },
    },
    {
      id: 'BP6',
      kind: 'rail',
      name: 'Bukit Panjang',
      point: { latitude: 1.378_296, longitude: 103.762_138 },
    },
    {
      id: 'BP7',
      kind: 'rail',
      name: 'Petir',
      point: { latitude: 1.377_756, longitude: 103.766_634 },
    },
  ],
}

describe('transit-network', () => {
  it('computes Haversine distances accurately', () => {
    const dist = haversineDistanceMeters(
      { latitude: 1.405_255, longitude: 103.902_354 },
      { latitude: 1.415_018, longitude: 103.910_329 },
    )
    expect(dist).toBeGreaterThan(1350)
    expect(dist).toBeLessThan(1450)
    expect(
      haversineDistanceMeters(
        { latitude: 1.35, longitude: 103.85 },
        { latitude: 1.35, longitude: 103.85 },
      ),
    ).toBe(0)
  })

  it('classifies Singapore dates into weekday, saturday, and sunday_holiday including PH', () => {
    expect(getServiceDayType('2026-11-26')).toBe('weekday') // Thursday
    expect(getServiceDayType('2026-11-28')).toBe('saturday') // Saturday
    expect(getServiceDayType('2026-11-29')).toBe('sunday_holiday') // Sunday
    expect(getServiceDayType('2026-12-25')).toBe('sunday_holiday') // Christmas Day Friday
    expect(getServiceDayType('2026-11-09')).toBe('sunday_holiday') // Deepavali observed Monday
  })

  it('parses busrouter first/last strings with carry-overs, non-operating days, and post-midnight wrap', () => {
    const loop = parseBusRouterFirstLastLine('381 0536 0110 0533 0109 = =')
    expect(loop).toEqual({
      serviceId: '381',
      windows: {
        weekday: { firstMin: 336, lastMin: 1510 },
        saturday: { firstMin: 333, lastMin: 1509 },
        sunday_holiday: { firstMin: 333, lastMin: 1509 },
      },
    })

    const weekdayOnly = parseBusRouterFirstLastLine('44 0630 0830 - - - -')
    expect(weekdayOnly).toEqual({
      serviceId: '44',
      windows: {
        weekday: { firstMin: 390, lastMin: 510 },
      },
    })

    const carryEqual = parseBusRouterFirstLastLine('123 0545 2400 = = 0600 =')
    expect(carryEqual).toEqual({
      serviceId: '123',
      windows: {
        weekday: { firstMin: 345, lastMin: 1440 },
        saturday: { firstMin: 345, lastMin: 1440 },
        sunday_holiday: { firstMin: 360, lastMin: 1440 },
      },
    })

    expect(parseBusRouterFirstLastLine('bad')).toBeNull()
  })

  it('parses GTFS rail schedule CSVs including quoted fields, all route types, and calendar day types', () => {
    const patterns = parseGtfsTrainSchedule(
      {
        routesTxt:
          'route_id,route_short_name,route_long_name,route_type\n"NE","NE","North East Line",1\n"BP","BP","Bukit ""Panjang"" LRT",0\n"B1","B1","Bus",3\n"R1","R1","Rail",2\n',
        calendarTxt:
          'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nALL,1,1,1,1,1,1,1,20260101,20261231\n',
        tripsTxt:
          'route_id,service_id,trip_id,direction_id\nNE,ALL,NE_T1,0\nBP,ALL,BP_T1,0\nB1,ALL,B1_T1,0\nR1,ALL,R1_T1,0\n',
        stopTimesTxt:
          'trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type\nNE_T1,08:34:00,08:34:00,NE18,2,1,0\nNE_T1,08:30:00,08:30:30,NE17,1,0,1\nBP_T1,08:00:00,08:00:00,BP1,1,0,0\nBP_T1,08:05:00,08:05:00,BP6,2,0,0\nB1_T1,08:00:00,08:00:00,65009,1,0,0\nB1_T1,08:05:00,08:05:00,65729,2,0,0\nR1_T1,08:00:00,08:00:00,CC4,1,0,0\nR1_T1,08:05:00,08:05:00,CC34,2,0,0\n',
      },
      new Set(['NE17', 'NE18', 'BP1', 'BP6', '65009', '65729', 'CC4', 'CC34']),
    )

    expect(patterns).toHaveLength(4)
    expect(patterns[0]).toMatchObject({
      serviceId: 'NE',
      mode: 'SUBWAY',
      timingKind: 'scheduled',
    })
    expect(patterns.find((p) => p.serviceId === 'BP')?.mode).toBe('TRAM')
    expect(patterns.find((p) => p.serviceId === 'B1')?.mode).toBe('BUS')
    expect(patterns.find((p) => p.serviceId === 'R1')?.mode).toBe('RAIL')
    const trip = patterns[0]?.scheduledTrips?.[0]
    expect(trip?.dayTypes).toEqual(['weekday', 'saturday', 'sunday_holiday'])
    expect(trip?.stops).toEqual([
      {
        stopId: 'NE17',
        arrivalMs: 30_600_000,
        departureMs: 30_630_000,
        pickupAllowed: true,
        dropOffAllowed: false,
      },
      {
        stopId: 'NE18',
        arrivalMs: 30_840_000,
        departureMs: 30_840_000,
        pickupAllowed: false,
        dropOffAllowed: true,
      },
    ])

    const withGtfs = buildTransitNetworkIndex({
      inventory: MINI_INVENTORY,
      networkDate: '2026-11-26',
      busServices: {},
      busFirstLast: {},
      gtfsTrain: {
        routesTxt:
          'route_id,route_short_name,route_long_name,route_type\nNE,NE,North East Line,1\n',
        calendarTxt:
          'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nWD,1,1,1,1,1,0,0,20260101,20261231\n',
        calendarDatesTxt:
          'service_id,date,exception_type\nWD,20261126,2\nWD,20261128,1\n',
        tripsTxt: 'route_id,service_id,trip_id,direction_id\nNE,WD,NE_T1,0\n',
        stopTimesTxt:
          'trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type\nNE_T1,08:30:00,08:30:00,NE17,1,0,0\nNE_T1,08:34:00,08:34:00,NE18,2,0,0\n',
      },
    })
    expect(withGtfs.provenance.some((p) => p.timingKind === 'scheduled')).toBe(
      true,
    )
    const gtfsTrip = withGtfs.patterns.find((p) => p.timingKind === 'scheduled')
      ?.scheduledTrips?.[0]
    expect(gtfsTrip?.removedDates).toEqual(['20261126'])
    expect(gtfsTrip?.addedDates).toEqual(['20261128'])
  })

  it('builds directed bus patterns, rail topology including CC loop/LRT, and spatial transfer links', () => {
    const index = buildTransitNetworkIndex({
      inventory: MINI_INVENTORY,
      networkDate: '2026-11-26',
      busServices: {
        '381': {
          name: 'Punggol Int <-> Punggol Coast Int',
          routes: [['65009', '65729', '69009']],
        },
        '44': {
          name: 'Weekday Peak',
          routes: [['65009', '69009']],
        },
      },
      busFirstLast: {
        '65009': [
          '381 0545 0035 = = = =',
          '381 0700 0116 = = = =',
          '44 0630 0830 - - - -',
        ],
        '65729': ['381 0548 0038 = = = =', '381 0705 0120 = = = ='],
        '69009': ['381 0551 0041 = = = =', '44 0636 0836 - - - -'],
      },
    })

    expect(index.version).toBe(1)
    expect(index.inventoryDate).toBe('2026-11-24')
    expect(index.provenance.length).toBeGreaterThanOrEqual(2)

    const bus381 = index.patterns.find((p) => p.serviceId === '381')
    expect(bus381?.segments).toHaveLength(2)
    expect(bus381?.segments[0]?.fromStopId).toBe('65009')
    expect(bus381?.segments[0]?.toStopId).toBe('65729')
    expect(bus381?.segments[0]?.minRideMs).toBeGreaterThanOrEqual(10_000)
    expect(bus381?.segments[0]?.estRideMs).toBeGreaterThanOrEqual(
      bus381?.segments[0]?.minRideMs ?? 0,
    )
    expect(bus381?.segments[0]?.operatingWindows?.weekday).toEqual({
      firstMin: 345,
      lastMin: 1475,
    })

    // Rail topology connects NE17 <-> NE18, PTC <-> PE1, and CC4 <-> CC34
    const hasEdge = (from: string, to: string) =>
      index.patterns.some((p) =>
        p.segments.some((s) => s.fromStopId === from && s.toStopId === to),
      )
    expect(hasEdge('NE17', 'NE18')).toBe(true)
    expect(hasEdge('NE18', 'NE17')).toBe(true)
    expect(hasEdge('PTC', 'PE1')).toBe(true)
    expect(hasEdge('PE1', 'PTC')).toBe(true)
    expect(hasEdge('CC34', 'CC4')).toBe(true)
    expect(hasEdge('CC4', 'CC34')).toBe(true)

    // Transfer links connect nearby rail/bus stops (NE17 <-> PTC, NE18 <-> 65729)
    expect(
      index.transfers.some(
        (t) => t.fromStopId === 'NE17' && t.toStopId === 'PTC',
      ),
    ).toBe(true)
    expect(
      index.transfers.some(
        (t) => t.fromStopId === '65729' && t.toStopId === 'NE18',
      ),
    ).toBe(true)
    expect(index.coveredStopIds).toContain('NE18')
    expect(index.coveredStopIds).toContain('65729')
  })

  it('serializes and parses compact bus-network TSVs and integrates with transit network index', () => {
    const rawTsv = serializeBusNetworkTsv({
      networkDate: '2026-11-25',
      busServices: {
        '381': {
          name: '381',
          routes: [
            ['65009', '65729', '69009'],
            ['69009', '65009'],
          ],
        },
        SHORT: { name: 'SHORT', routes: [['65009']] },
      },
      busFirstLast: {
        '65009': ['381 0545 0035 = = = =', '381 0700 0116 = = = ='],
        '65729': ['381 0548 0038 = = = ='],
      },
    })

    const parsed = parseBusNetworkTsv(rawTsv)
    expect(parsed.networkDate).toBe('2026-11-25')
    expect(parsed.busServices['381']).toEqual({
      name: '381',
      routes: [
        ['65009', '65729', '69009'],
        ['69009', '65009'],
      ],
    })
    expect(parsed.busServices['SHORT']).toBeUndefined()
    expect(parsed.busFirstLast['65009']).toEqual([
      '381 0545 0035 = = = =',
      '381 0700 0116 = = = =',
    ])

    const rebuilt = buildTransitNetworkIndex({
      inventory: MINI_INVENTORY,
      networkDate: parsed.networkDate,
      busServices: parsed.busServices,
      busFirstLast: parsed.busFirstLast,
    })
    expect(rebuilt.networkDate).toBe('2026-11-25')
    expect(rebuilt.coveredStopIds).toContain('65729')
  })

  it('handles empty rail-only bus-network TSVs, ignores malformed rows, and rejects invalid headers', () => {
    const validWithBadRows = [
      'networkDate\t2026-11-25',
      'kind\tid\tpayload',
      'badrow',
      'R\t\t65009,65729',
      'R\t10\t65009',
      'F\t65009\t|',
      'F\t65009\t10 0530 2330 = = = =',
      'F\t65009\t10 0600 2330 = = = =',
    ].join('\n')
    const parsed = parseBusNetworkTsv(validWithBadRows)
    expect(parsed.busServices).toEqual({})
    expect(parsed.busFirstLast['65009']).toEqual([
      '10 0530 2330 = = = =',
      '10 0600 2330 = = = =',
    ])

    expect(() =>
      serializeBusNetworkTsv({
        networkDate: 'bad',
        busServices: {},
        busFirstLast: {},
      }),
    ).toThrow('Invalid bus network date')
    expect(() => parseBusNetworkTsv('only-one-line')).toThrow(
      'missing required',
    )
    expect(() =>
      parseBusNetworkTsv('networkDate\tinvalid\nkind\tid\tpayload'),
    ).toThrow('networkDate header')
    expect(() =>
      parseBusNetworkTsv('networkDate\t2026-11-25\nwrong\theader\tcols'),
    ).toThrow('column header mismatch')
  })
})
