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

  it('parses explicit visit clocks, non-operating days, and post-midnight rollover', () => {
    expect(
      parseBusRouterFirstLastLine('0536 0110 0533 0109 0536 0110'),
    ).toEqual({
      weekday: { firstMin: 336, lastMin: 1510 },
      saturday: { firstMin: 333, lastMin: 1509 },
      sunday_holiday: { firstMin: 336, lastMin: 1510 },
    })
    expect(parseBusRouterFirstLastLine('0630 0830 - - - -')).toEqual({
      weekday: { firstMin: 390, lastMin: 510 },
    })
    expect(
      parseBusRouterFirstLastLine('0545 2400 0015 0015 2400 2400'),
    ).toEqual({
      weekday: { firstMin: 345, lastMin: 1440 },
      saturday: { firstMin: 1455, lastMin: 1455 },
      sunday_holiday: { firstMin: 1440, lastMin: 1440 },
    })
    expect(parseBusRouterFirstLastLine('- - - - - -')).toEqual({})
    expect(parseBusRouterFirstLastLine('bad')).toBeNull()
    expect(parseBusRouterFirstLastLine('bad 0830 2800 0900 0600 1260')).toEqual(
      {},
    )
  })

  it('builds directed bus patterns, rail topology including CC loop/LRT, and spatial transfer links', () => {
    const index = buildTransitNetworkIndex({
      inventory: MINI_INVENTORY,
      busRoutes: {
        '381': [
          [
            { stopId: '65009', times: '0545 0035 0545 0035 0545 0035' },
            { stopId: '65729', times: '0548 0038 0548 0038 0548 0038' },
            { stopId: '69009', times: '0551 0041 0551 0041 0551 0041' },
          ],
        ],
        '44': [
          [
            { stopId: '65009', times: '0630 0830 - - - -' },
            { stopId: '69009', times: '0636 0836 - - - -' },
          ],
        ],
      },
    })

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

  it('round-trips visit-specific windows, unknown timings, and non-operating days', () => {
    const busRoutes = {
      '381': [
        [
          { stopId: '65009', times: '0545 0035 0545 0035 - -' },
          { stopId: '65729' },
          { stopId: '65009', times: '0700 0116 0700 0116 0700 0116' },
          { stopId: '69009', times: '0705 0120 0705 0120 0705 0120' },
        ],
        [
          { stopId: '69009', times: '0600 0005 0600 0005 0600 0005' },
          { stopId: '65009' },
        ],
      ],
    }
    const rawTsv = serializeBusNetworkTsv({
      networkDate: '2026-11-25',
      busRoutes: { ...busRoutes, SHORT: [[{ stopId: '65009' }]] },
    })
    expect(rawTsv).toContain('service\tdirection\tvisits')
    expect(rawTsv).toContain(
      '381\t1\t65009 0545 0035 0545 0035 - -|65729|65009 0700 0116 0700 0116 0700 0116|69009 0705 0120 0705 0120 0705 0120',
    )
    const parsed = parseBusNetworkTsv(rawTsv)
    expect(parsed.networkDate).toBe('2026-11-25')
    expect(parsed.busRoutes).toEqual(busRoutes)
    const index = buildTransitNetworkIndex({
      inventory: MINI_INVENTORY,
      busRoutes: parsed.busRoutes,
    })
    const windows = index.patterns
      .filter((pattern) => pattern.serviceId === '381')
      .flatMap((pattern) => pattern.segments)
      .filter((segment) => segment.fromStopId === '65009')
      .map((segment) => segment.operatingWindows)
    expect(windows[0]).toEqual({
      weekday: { firstMin: 345, lastMin: 1475 },
      saturday: { firstMin: 345, lastMin: 1475 },
    })
    expect(windows[1]).toEqual({
      weekday: { firstMin: 420, lastMin: 1516 },
      saturday: { firstMin: 420, lastMin: 1516 },
      sunday_holiday: { firstMin: 420, lastMin: 1516 },
    })
    const unknownTiming = index.patterns
      .flatMap((pattern) => pattern.segments)
      .find((segment) => segment.fromStopId === '65729')
    expect(unknownTiming).toBeDefined()
    expect(unknownTiming?.operatingWindows).toBeUndefined()
  })

  it('handles empty rail-only bus-network TSVs, ignores malformed rows, and rejects invalid headers', () => {
    const validWithBadRows = [
      'networkDate\t2026-11-25',
      'service\tdirection\tvisits',
      'badrow',
      '\t1\t65009|65729',
      '10\t1\t65009',
    ].join('\n')
    const parsed = parseBusNetworkTsv(validWithBadRows)
    expect(parsed.busRoutes).toEqual({})
    expect(
      parseBusNetworkTsv('networkDate\t2026-11-25\nservice\tdirection\tvisits')
        .busRoutes,
    ).toEqual({})

    expect(() =>
      serializeBusNetworkTsv({
        networkDate: 'bad',
        busRoutes: {},
      }),
    ).toThrow('Invalid bus network date')
    expect(() => parseBusNetworkTsv('only-one-line')).toThrow(
      'missing required',
    )
    expect(() =>
      parseBusNetworkTsv('networkDate\tinvalid\nservice\tdirection\tvisits'),
    ).toThrow('networkDate header')
    expect(() =>
      parseBusNetworkTsv('networkDate\t2026-11-25\nwrong\theader\tcols'),
    ).toThrow('column header mismatch')
  })

  it('retains the published 00:30 NE17 departure towards NE18', () => {
    const index = buildTransitNetworkIndex({
      inventory: MINI_INVENTORY,
      busRoutes: {},
    })
    const segment = index.patterns
      .flatMap((pattern) => pattern.segments)
      .find((s) => s.fromStopId === 'NE17' && s.toStopId === 'NE18')
    for (const day of ['weekday', 'saturday', 'sunday_holiday'] as const) {
      const window = segment?.operatingWindows?.[day]
      expect(window).toBeDefined()
      expect(window && 'lastMin' in window).toBe(true)
      if (window && 'lastMin' in window) {
        expect(window.firstMin).toBeLessThanOrEqual(1470)
        expect(window.lastMin).toBeGreaterThanOrEqual(1470)
      }
    }
  })

  it('retains the published one-minute NE7 to NE8 ride without treating the estimate as a lower bound', () => {
    const index = buildTransitNetworkIndex({
      inventory: inventory(
        stop('NE7', 'rail', 1.306_571, 103.849_299),
        stop('NE8', 'rail', 1.312_708, 103.854_377),
      ),
      busRoutes: {},
    })
    const segment = index.patterns
      .flatMap((pattern) => pattern.segments)
      .find((s) => s.fromStopId === 'NE7' && s.toStopId === 'NE8')
    expect(segment).toBeDefined()
    expect(segment?.minRideMs).toBeLessThanOrEqual(60_000)
    expect(segment?.estRideMs).toBeGreaterThan(60_000)
  })

  it('uses the separate published last departures for both service 98 visits to 21069', () => {
    const bundled = parseBusNetworkTsv(
      readFileSync('public/data/bus-network.tsv', 'utf8'),
    )
    const index = buildTransitNetworkIndex({
      inventory: parseStopInventory(
        readFileSync('public/data/stops.tsv', 'utf8'),
      ),
      busRoutes: { '98': bundled.busRoutes['98'] ?? [] },
    })
    const visits = index.patterns
      .filter((pattern) => pattern.serviceId === '98')
      .flatMap((pattern) => pattern.segments)
      .filter((segment) => segment.fromStopId === '21069')
    expect(visits.map((segment) => segment.operatingWindows)).toEqual([
      {
        weekday: { firstMin: 364, lastMin: 1479 },
        saturday: { firstMin: 376, lastMin: 1481 },
        sunday_holiday: { firstMin: 374, lastMin: 1481 },
      },
      {
        weekday: { firstMin: 365, lastMin: 1491 },
        saturday: { firstMin: 365, lastMin: 1494 },
        sunday_holiday: { firstMin: 365, lastMin: 1493 },
      },
    ])
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
      busRoutes: {},
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

  it('ships bus-network.tsv with a valid networkDate and usable routes', () => {
    const parsed = parseBusNetworkTsv(
      readFileSync('public/data/bus-network.tsv', 'utf8'),
    )
    expect(parsed.networkDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(Number.isNaN(Date.parse(parsed.networkDate))).toBe(false)
    expect(Object.keys(parsed.busRoutes).length).toBeGreaterThan(0)
  })

  it('models Circle Line off-peak shuttle (CC1-CC6), weekday peak spur (CC1-CC32), and closed CC_LOOP (CC4-CC34-CC4)', () => {
    const inventory = parseStopInventory(
      readFileSync('public/data/stops.tsv', 'utf8'),
    )
    const index = buildTransitNetworkIndex({
      inventory,
      busRoutes: {},
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
