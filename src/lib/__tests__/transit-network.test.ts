import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { Stop, StopInventory } from '@lib/commute-types.js'
import { parseStopInventory } from '@lib/inventory.js'
import {
  buildTransitNetworkIndex,
  getServiceDayType,
  haversineDistanceMeters,
  parseBusNetworkDate,
  parseBusNetworkTsv,
  parseBusRouterFirstLastLine,
  serializeBusNetworkTsv,
} from '@lib/transit-network.js'

const stop = (
  id: string,
  kind: Stop['kind'],
  latitude: number,
  longitude: number,
): Stop => ({ id, kind, name: id, point: { latitude, longitude } })

const inventory = (...stops: Stop[]): StopInventory => ({
  inventoryDate: '2026-11-24',
  stops,
})

const MINI_INVENTORY = inventory(
  stop('65009', 'bus', 1.4038, 103.9024),
  stop('65729', 'bus', 1.4149, 103.9102),
  stop('69009', 'bus', 1.4159, 103.9114),
  stop('NE17', 'rail', 1.405_255, 103.902_354),
  stop('NE18', 'rail', 1.415_018, 103.910_329),
  stop('PTC', 'rail', 1.405_255, 103.902_354),
  stop('PE1', 'rail', 1.399_464, 103.905_852),
  stop('CC4', 'rail', 1.293_854, 103.860_151),
  stop('CC34', 'rail', 1.282_535, 103.859_73),
  stop('BP1', 'rail', 1.384_749, 103.744_534),
  stop('BP6', 'rail', 1.378_296, 103.762_138),
  stop('BP7', 'rail', 1.377_756, 103.766_634),
)

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
        '381': [['65009', '65729', '69009']],
        '44': [['65009', '69009']],
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

    // Nearby rail/rail and bus/rail links retain their distinct transfer costs.
    expect(index.transfers).toEqual(
      expect.arrayContaining([
        {
          fromStopId: 'NE17',
          toStopId: 'PTC',
          walkMs: 60_000,
          minTransferWaitMs: 30_000,
          estTransferWaitMs: 180_000,
        },
        expect.objectContaining({
          fromStopId: '65729',
          toStopId: 'NE18',
          minTransferWaitMs: 30_000,
          estTransferWaitMs: 240_000,
        }),
      ]),
    )
    expect(
      index.patterns
        .filter((p) => p.serviceId === 'BP')
        .map((p) => p.segments.map((s) => `${s.fromStopId}->${s.toStopId}`)),
    ).toEqual([
      ['BP1->BP6', 'BP6->BP7', 'BP7->BP6', 'BP6->BP1'],
      ['BP1->BP6', 'BP6->BP7', 'BP7->BP6', 'BP6->BP1'],
    ])
  })

  it('round-trips dated routes and timings, omitting incomplete routes', () => {
    const rawTsv = serializeBusNetworkTsv({
      networkDate: '2026-11-25',
      busServices: {
        '381': [
          ['65009', '65729', '69009'],
          ['69009', '65009'],
        ],
        SHORT: [['65009']],
      },
      busFirstLast: {
        '65009': ['381 0545 0035 = = = =', '381 0700 0116 = = = ='],
        '65729': ['381 0548 0038 = = = ='],
      },
    })

    const parsed = parseBusNetworkTsv(rawTsv)
    expect(parsed.networkDate).toBe('2026-11-25')
    expect(parsed.busServices['381']).toEqual([
      ['65009', '65729', '69009'],
      ['69009', '65009'],
    ])
    expect(parsed.busServices['SHORT']).toBeUndefined()
    expect(parsed.busFirstLast['65009']).toEqual([
      '381 0545 0035 = = = =',
      '381 0700 0116 = = = =',
    ])
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
    const inventory249A = inventory(
      stop('21359', 'bus', 1.338_67, 103.709_96),
      stop('21349', 'bus', 1.335_73, 103.709_39),
    )
    const index = buildTransitNetworkIndex({
      inventory: inventory249A,
      networkDate: '2026-11-26',
      busServices: {
        '249A': [['21359', '21349']],
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
    const gapInventory = inventory(
      ...MINI_INVENTORY.stops.slice(0, 3),
      stop('69099', 'bus', 1.417, 103.913),
    )
    const index = buildTransitNetworkIndex({
      inventory: gapInventory,
      networkDate: '2026-11-26',
      busServices: {
        '99': [['65009', '65729', 'MISSING', '69009', '69099']],
      },
      busFirstLast: {},
    })
    const bus99 = index.patterns.filter((p) => p.serviceId === '99')
    expect(bus99).toHaveLength(2)
    expect(
      bus99.map((p) => p.segments.map((s) => `${s.fromStopId}->${s.toStopId}`)),
    ).toEqual([['65009->65729'], ['69009->69099']])
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
    const expressInventory = inventory(
      stop('95159', 'bus', 1.356_793, 103.984_689),
      stop('65191', 'bus', 1.390_718, 103.897_381),
    )
    const index = buildTransitNetworkIndex({
      inventory: expressInventory,
      networkDate: '2026-11-26',
      busServices: {
        '858': [['95159', '65191']],
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
    const ccInventory = inventory(
      stop('CC1', 'rail', 1.298_786, 103.845_02),
      stop('CC2', 'rail', 1.296_896, 103.850_55),
      stop('CC3', 'rail', 1.293_258, 103.855_974),
      stop('CC4', 'rail', 1.293_854, 103.860_151),
      stop('CC5', 'rail', 1.299_671, 103.8635),
      stop('CC34', 'rail', 1.282_535, 103.859_73),
    )
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

  it('models Circle Line off-peak shuttle (CC1-CC6), weekday peak spur (CC1-CC32), and closed CC_LOOP (CC4-CC34-CC4)', () => {
    const inventory = parseStopInventory(
      readFileSync('public/data/stops.tsv', 'utf8'),
    )
    const index = buildTransitNetworkIndex({
      inventory,
      networkDate: '2026-11-26',
      busServices: {},
      busFirstLast: {},
    })

    const shuttle = index.patterns.filter((p) =>
      p.patternId.startsWith('rail:CC:shuttle:'),
    )
    const peakSpur = index.patterns.filter((p) =>
      p.patternId.startsWith('rail:CC:peak:'),
    )
    const loop = index.patterns.filter((p) => p.serviceId === 'CC_LOOP')

    expect(shuttle).toHaveLength(2)
    expect(peakSpur).toHaveLength(2)
    expect(loop).toHaveLength(2)

    const shuttleStops = new Set(
      shuttle.flatMap((p) =>
        p.segments.flatMap((s) => [s.fromStopId, s.toStopId]),
      ),
    )
    expect(shuttleStops).toEqual(
      new Set(['CC1', 'CC2', 'CC3', 'CC4', 'CC5', 'CC6']),
    )

    const peakStops = new Set(
      peakSpur.flatMap((p) =>
        p.segments.flatMap((s) => [s.fromStopId, s.toStopId]),
      ),
    )
    expect(peakStops.has('CC1')).toBe(true)
    expect(peakStops.has('CC32')).toBe(true)
    expect(peakStops.has('CC33')).toBe(false)
    expect(peakStops.has('CC34')).toBe(false)
    const outbound = peakSpur.find((p) => p.patternId.endsWith(':fwd'))
    const inbound = peakSpur.find((p) => p.patternId.endsWith(':rev'))
    expect(
      outbound?.segments.find((s) => s.fromStopId === 'CC3')?.operatingWindows,
    ).toEqual({
      weekday: [
        { firstMin: 340, lastMin: 569 },
        { firstMin: 964, lastMin: 1244 },
      ],
    })
    // A train that passed CC3 at the cutoff still serves downstream stations.
    const outboundCc8 = outbound?.segments.find((s) => s.fromStopId === 'CC8')
    const outboundWindows = outboundCc8?.operatingWindows?.weekday
    expect(Array.isArray(outboundWindows)).toBe(true)
    if (Array.isArray(outboundWindows)) {
      expect(outboundWindows[0]?.lastMin).toBeGreaterThan(569)
    }
    // Reverse service has its own estimated origin envelope and advances
    // clockwise, not the CC3 outbound cutoff applied to every segment.
    const inboundOrigin = inbound?.segments[0]?.operatingWindows?.weekday
    const inboundCc8 = inbound?.segments.find((s) => s.fromStopId === 'CC8')
    const inboundWindows = inboundCc8?.operatingWindows?.weekday
    expect(Array.isArray(inboundOrigin)).toBe(true)
    expect(Array.isArray(inboundWindows)).toBe(true)
    if (Array.isArray(inboundOrigin) && Array.isArray(inboundWindows)) {
      const elapsedMs = inbound?.segments
        .slice(
          0,
          inbound.segments.findIndex((s) => s.fromStopId === 'CC8'),
        )
        .reduce((sum, s) => sum + s.estRideMs, 0)
      expect(inboundWindows[0]?.lastMin).toBeCloseTo(
        (inboundOrigin[0]?.lastMin ?? 0) + (elapsedMs ?? 0) / 60_000,
      )
      expect(inboundWindows[0]?.lastMin).toBeGreaterThan(569)
    }

    for (const pattern of loop) {
      expect(pattern.isLoop).toBe(true)
      const loopStops = new Set(
        pattern.segments.flatMap((s) => [s.fromStopId, s.toStopId]),
      )
      expect(loopStops.has('CC4')).toBe(true)
      expect(loopStops.has('CC34')).toBe(true)
      expect(loopStops.has('CC1')).toBe(false)
      expect(loopStops.has('CC3')).toBe(false)
    }
  })
})
