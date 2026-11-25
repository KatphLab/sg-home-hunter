import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { StopInventory } from '@lib/commute-types.js'
import {
  buildTransitNetworkIndex,
  getServiceDayType,
  haversineDistanceMeters,
  parseBusNetworkDate,
  parseBusNetworkTsv,
  parseBusRouterFirstLastLine,
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
        sunday_holiday: { firstMin: 336, lastMin: 1510 },
      },
    })

    const svc124 = parseBusRouterFirstLastLine('124 0604 0036 0605 0040 0603 =')
    expect(svc124?.windows.sunday_holiday).toEqual({
      firstMin: 363,
      lastMin: 1476,
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

    // Inherit weekday raw clock for '=' instead of weekday's rolled-over +1440 minute,
    // and treat small (< 04:00) first+last pairs as after-midnight departures of that service day.
    const svc200AEnd = parseBusRouterFirstLastLine(
      '200A 0903 0014 0015 0015 0014 =',
    )
    expect(svc200AEnd).toEqual({
      serviceId: '200A',
      windows: {
        weekday: { firstMin: 543, lastMin: 1454 },
        saturday: { firstMin: 1455, lastMin: 1455 },
        sunday_holiday: { firstMin: 1454, lastMin: 1454 },
      },
    })

    const svc200AMid = parseBusRouterFirstLastLine(
      '200A 0850 0003 0003 = 0002 0002',
    )
    expect(svc200AMid).toEqual({
      serviceId: '200A',
      windows: {
        weekday: { firstMin: 530, lastMin: 1443 },
        saturday: { firstMin: 1443, lastMin: 1443 },
        sunday_holiday: { firstMin: 1442, lastMin: 1442 },
      },
    })

    const svc200AEarly = parseBusRouterFirstLastLine(
      '200A 0845 0001 0001 = 2400 2400',
    )
    expect(svc200AEarly).toEqual({
      serviceId: '200A',
      windows: {
        weekday: { firstMin: 525, lastMin: 1441 },
        saturday: { firstMin: 1441, lastMin: 1441 },
        sunday_holiday: { firstMin: 1440, lastMin: 1440 },
      },
    })

    expect(parseBusRouterFirstLastLine('bad')).toBeNull()
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

  it('keeps minRideMs at the physical lower bound instead of first-bus timetable delta', () => {
    const inventory249A: StopInventory = {
      inventoryDate: '2026-11-24',
      stops: [
        {
          id: '21359',
          kind: 'bus',
          name: 'Aft ST Kinetics',
          point: { latitude: 1.338_67, longitude: 103.709_96 },
        },
        {
          id: '21349',
          kind: 'bus',
          name: 'GSK',
          point: { latitude: 1.335_73, longitude: 103.709_39 },
        },
      ],
    }
    const index = buildTransitNetworkIndex({
      inventory: inventory249A,
      networkDate: '2026-11-26',
      busServices: {
        '249A': { name: '249A', routes: [['21359', '21349']] },
      },
      busFirstLast: {
        '21359': ['249A 0634 0830 - - - -'],
        '21349': ['249A 0637 0832 - - - -'],
      },
    })
    const seg = index.patterns.find((p) => p.serviceId === '249A')?.segments[0]
    expect(seg).toBeDefined()
    expect(seg?.minRideMs).toBeLessThan(120_000)
    expect(seg?.estRideMs).toBeGreaterThanOrEqual(180_000)
  })

  it('splits bus patterns at missing inventory stops instead of bridging across gaps', () => {
    const gapInventory: StopInventory = {
      inventoryDate: '2026-11-24',
      stops: [
        ...MINI_INVENTORY.stops.slice(0, 3),
        {
          id: '69099',
          kind: 'bus',
          name: 'After Gap',
          point: { latitude: 1.417, longitude: 103.913 },
        },
      ],
    }
    const index = buildTransitNetworkIndex({
      inventory: gapInventory,
      networkDate: '2026-11-26',
      busServices: {
        '99': {
          name: '99',
          routes: [['65009', '65729', 'MISSING', '69009', '69099']],
        },
      },
      busFirstLast: {},
    })
    const bus99 = index.patterns.filter((p) => p.serviceId === '99')
    expect(bus99).toHaveLength(2)
    expect(
      bus99.map((p) => p.segments.map((s) => `${s.fromStopId}->${s.toStopId}`)),
    ).toEqual([['65009->65729'], ['69009->69099']])
  })

  it('models Bukit Panjang LRT through-services without splitting at BP6', () => {
    const index = buildTransitNetworkIndex({
      inventory: MINI_INVENTORY,
      networkDate: '2026-11-26',
      busServices: {},
      busFirstLast: {},
    })
    const bpPatterns = index.patterns.filter((p) => p.serviceId === 'BP')
    const hasPath = (stops: readonly string[]) =>
      bpPatterns.some((p) => {
        const edges = p.segments.map((s) => `${s.fromStopId}->${s.toStopId}`)
        return stops
          .slice(0, -1)
          .every((from, idx) =>
            edges.includes(`${from}->${stops[idx + 1] ?? ''}`),
          )
      })
    expect(hasPath(['BP1', 'BP6', 'BP7'])).toBe(true)
    expect(hasPath(['BP7', 'BP6', 'BP1'])).toBe(true)
  })

  it('extracts ISO dates from timestamps while falling back cleanly on invalid input', () => {
    expect(
      parseBusNetworkDate('2026-11-20T01:23:45.678Z\n', '2026-11-26'),
    ).toBe('2026-11-20')
    expect(parseBusNetworkDate('Updated 2026-11-19', '2026-11-26')).toBe(
      '2026-11-19',
    )
    expect(parseBusNetworkDate('12026-11-199', '2026-11-26')).toBe('2026-11-26')
    expect(parseBusNetworkDate('', '2026-11-26')).toBe('2026-11-26')
  })

  it('preserves expressway bus 858 95159 -> 65191 within a 12-minute minRideMs bound', () => {
    const expressInventory: StopInventory = {
      inventoryDate: '2026-11-24',
      stops: [
        {
          id: '95159',
          kind: 'bus',
          name: 'Bef Changi Airport PTB3',
          point: { latitude: 1.356_793, longitude: 103.984_689 },
        },
        {
          id: '65191',
          kind: 'bus',
          name: 'Aft TPE',
          point: { latitude: 1.390_718, longitude: 103.897_381 },
        },
      ],
    }
    const index = buildTransitNetworkIndex({
      inventory: expressInventory,
      networkDate: '2026-11-26',
      busServices: {
        '858': { name: '858', routes: [['95159', '65191']] },
      },
      busFirstLast: {
        '95159': ['858 0633 0044 = 0043 0632 0039'],
        '65191': ['858 0647 0056 = = 0645 0052'],
      },
    })
    const seg = index.patterns.find((p) => p.serviceId === '858')?.segments[0]
    expect(seg).toBeDefined()
    expect(seg?.minRideMs).toBeLessThanOrEqual(12 * 60_000)
  })

  it('continues Circle Line Dhoby Ghaut branch through CC4 -> CC5 without inventing CC3 -> CC4 -> CC34', () => {
    const ccInventory: StopInventory = {
      inventoryDate: '2026-11-24',
      stops: [
        {
          id: 'CC1',
          kind: 'rail',
          name: 'Dhoby Ghaut',
          point: { latitude: 1.298_786, longitude: 103.845_02 },
        },
        {
          id: 'CC2',
          kind: 'rail',
          name: 'Bras Basah',
          point: { latitude: 1.296_896, longitude: 103.850_55 },
        },
        {
          id: 'CC3',
          kind: 'rail',
          name: 'Esplanade',
          point: { latitude: 1.293_258, longitude: 103.855_974 },
        },
        {
          id: 'CC4',
          kind: 'rail',
          name: 'Promenade',
          point: { latitude: 1.293_854, longitude: 103.860_151 },
        },
        {
          id: 'CC5',
          kind: 'rail',
          name: 'Nicoll Highway',
          point: { latitude: 1.299_671, longitude: 103.8635 },
        },
        {
          id: 'CC34',
          kind: 'rail',
          name: 'Bayfront',
          point: { latitude: 1.282_535, longitude: 103.859_73 },
        },
      ],
    }
    const index = buildTransitNetworkIndex({
      inventory: ccInventory,
      networkDate: '2026-11-26',
      busServices: {},
      busFirstLast: {},
    })
    const ccPatterns = index.patterns.filter((p) =>
      p.serviceId.startsWith('CC'),
    )
    const hasConsecutive = (from: string, via: string, to: string): boolean =>
      ccPatterns.some((p) =>
        p.segments.some(
          (seg, idx) =>
            seg.fromStopId === from &&
            seg.toStopId === via &&
            p.segments[idx + 1]?.fromStopId === via &&
            p.segments[idx + 1]?.toStopId === to,
        ),
      )

    const loopPatterns = ccPatterns.filter((p) => p.serviceId === 'CC_LOOP')
    const hasEdge = (
      patterns: readonly (typeof ccPatterns)[number][],
      from: string,
      to: string,
    ): boolean =>
      patterns.some((p) =>
        p.segments.some((s) => s.fromStopId === from && s.toStopId === to),
      )

    expect(hasConsecutive('CC3', 'CC4', 'CC5')).toBe(true)
    expect(hasConsecutive('CC5', 'CC4', 'CC3')).toBe(true)
    expect(hasConsecutive('CC3', 'CC4', 'CC34')).toBe(false)
    expect(hasConsecutive('CC34', 'CC4', 'CC3')).toBe(false)
    expect(hasEdge(loopPatterns, 'CC4', 'CC5')).toBe(true)
    expect(hasEdge(loopPatterns, 'CC34', 'CC4')).toBe(true)
    expect(hasEdge(loopPatterns, 'CC4', 'CC34')).toBe(true)
    expect(hasEdge(loopPatterns, 'CC5', 'CC4')).toBe(true)
  })

  it('ships bus-network.tsv with networkDate tied to the bundled data timestamp', () => {
    const rawTsv = readFileSync('public/data/bus-network.tsv', 'utf8')
    const parsed = parseBusNetworkTsv(rawTsv)
    expect(parsed.networkDate).toBe(
      parseBusNetworkDate('2026-11-06T02:05:26.522Z', '2026-11-25'),
    )
  })
})
