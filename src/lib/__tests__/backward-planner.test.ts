import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { planBackwardLeads } from '@lib/backward-planner.js'
import type {
  SearchConstraints,
  Stop,
  StopInventory,
  Workplace,
} from '@lib/commute-types.js'
import { parseStopInventory } from '@lib/inventory.js'
import {
  buildTransitNetworkIndex,
  parseBusNetworkTsv,
  type TransitNetworkIndex,
  type TransitPattern,
} from '@lib/transit-network.js'

const SEARCH_DATE = '2026-11-26'
const CONSTRAINTS: SearchConstraints = {
  searchDate: SEARCH_DATE,
  officeStart: '09:00',
  rideCapMinutes: 30,
}

const bundledInventory = parseStopInventory(
  readFileSync('public/data/stops.tsv', 'utf8'),
)
const bundledBus = parseBusNetworkTsv(
  readFileSync('public/data/bus-network.tsv', 'utf8'),
)

const planBundledService = (
  serviceId: string,
  destinationId: string,
  postalCode: string,
  constraints: SearchConstraints,
) => {
  const network = buildTransitNetworkIndex({
    inventory: bundledInventory,
    busRoutes: { [serviceId]: bundledBus.busRoutes[serviceId] ?? [] },
  })
  const destination = bundledInventory.stops.find(
    (stop) => stop.id === destinationId,
  )
  if (!destination) throw new Error(`Missing stop ${destinationId}`)
  const plan = planBackwardLeads({
    inventory: bundledInventory,
    networkIndex: {
      patterns: network.patterns.filter((p) => p.serviceId === serviceId),
      transfers: [],
    },
    workplace: {
      kind: 'postal',
      postalCode,
      label: destination.name,
      point: destination.point,
    },
    constraints,
    maxTransfers: 0,
    maxFinalWalkMeters: 0,
  })
  return { network, plan }
}

const WP_GATE_STOP: Stop = {
  id: 'WP_STOP',
  kind: 'bus',
  name: 'Workplace Gate',
  point: { latitude: 1.414_19, longitude: 103.9106 },
}

const WP_GATE_WORKPLACE: Workplace = {
  kind: 'postal',
  postalCode: '828616',
  label: 'WP',
  point: WP_GATE_STOP.point,
}

const INVENTORY: StopInventory = {
  inventoryDate: '2026-11-24',
  stops: [
    WP_GATE_STOP,
    {
      id: 'MID_BUS',
      kind: 'bus',
      name: 'Mid Bus Stop',
      point: { latitude: 1.409, longitude: 103.905 },
    },
    {
      id: 'FAR_WEST',
      kind: 'bus',
      name: 'Far West',
      point: { latitude: 1.34, longitude: 103.7 },
    },
    {
      id: 'NE18',
      kind: 'rail',
      name: 'Punggol Coast',
      point: { latitude: 1.415_018, longitude: 103.910_329 },
    },
    {
      id: 'NE17',
      kind: 'rail',
      name: 'Punggol',
      point: { latitude: 1.405_255, longitude: 103.902_354 },
    },
    {
      id: 'NE16',
      kind: 'rail',
      name: 'Sengkang',
      point: { latitude: 1.391_33, longitude: 103.895_294 },
    },
    {
      id: 'UNCOVERED',
      kind: 'bus',
      name: 'Uncovered Stop',
      point: { latitude: 1.4145, longitude: 103.9109 },
    },
  ],
}

const POSTAL_WORKPLACE: Workplace = {
  kind: 'postal',
  postalCode: '828616',
  label: 'SIT Punggol',
  point: { latitude: 1.414_19, longitude: 103.910_623 },
}

const busPattern = (
  id: string,
  segment: TransitPattern['segments'][number],
): TransitPattern => ({
  patternId: id,
  serviceId: id,
  mode: 'BUS',
  segments: [segment],
})

const uxdInventory: StopInventory = {
  inventoryDate: INVENTORY.inventoryDate,
  stops: [
    {
      id: 'U',
      kind: 'bus',
      name: 'Stop U',
      point: { latitude: 1.3, longitude: 103.7 },
    },
    {
      id: 'X',
      kind: 'bus',
      name: 'Stop X',
      point: { latitude: 1.35, longitude: 103.8 },
    },
    {
      id: 'D',
      kind: 'bus',
      name: 'Stop D',
      point: { latitude: 1.4, longitude: 103.9 },
    },
  ],
}

const workplaceD: Workplace = {
  kind: 'postal',
  postalCode: '820000',
  label: 'Stop D',
  point: { latitude: 1.4, longitude: 103.9 },
}

describe('backward-planner', () => {
  it('prunes unreachable distant stops, excludes walk-only stops, and reports uncovered stops', () => {
    const network = buildTransitNetworkIndex({
      inventory: INVENTORY,
      busRoutes: {
        '381': [
          [
            { stopId: 'MID_BUS', times: '0530 2330 0530 2330 0530 2330' },
            { stopId: 'WP_STOP', times: '0535 2335 0535 2335 0535 2335' },
          ],
        ],
        '999': [
          [
            { stopId: 'FAR_WEST', times: '0530 2330 0530 2330 0530 2330' },
            { stopId: 'MID_BUS' },
          ],
        ], // 11+ km single hop > 30m at 18m/s
      },
    })
    // Override 999 minRideMs? Actually 1.34,103.70 to 1.409,103.905 is ~24km -> >22 min at 18m/s + 5 min from MID_BUS, wait 24km / 18m/s = 1333s (~22m). Let's set rideCapMinutes: 15 so FAR_WEST is strictly over cap.
    const plan = planBackwardLeads({
      inventory: INVENTORY,
      networkIndex: network,
      workplace: POSTAL_WORKPLACE,
      constraints: { ...CONSTRAINTS, rideCapMinutes: 15 },
    })

    const leadIds = plan.leads.map((l) => l.stop.id)
    expect(leadIds).toContain('MID_BUS')
    expect(leadIds).toContain('NE17')
    expect(leadIds).not.toContain('WP_STOP') // walk-only seed without boarding transit
    expect(leadIds).not.toContain('FAR_WEST') // pruned by ride cap
    expect(plan.uncoveredStopIds).toEqual(['UNCOVERED'])
  })

  it('keeps merged Pareto alternatives when a later label is dominated by an earlier bag entry', () => {
    const branches: TransitPattern[] = (
      [
        [4, 8],
        [6, 6],
        [8, 10],
      ] as const
    ).map(([minRide, estRide], index) =>
      busPattern(`branch-${index}`, {
        fromStopId: 'MID_BUS',
        toStopId: 'WP_STOP',
        minRideMs: minRide * 60_000,
        estRideMs: estRide * 60_000,
        operatingWindows: { weekday: { firstMin: 530, lastMin: 540 } },
      }),
    )
    const trunk: TransitPattern = busPattern('trunk', {
      fromStopId: 'FAR_WEST',
      toStopId: 'MID_BUS',
      minRideMs: 60_000,
      estRideMs: 60_000,
    })
    const plan = (patterns: readonly TransitPattern[]) =>
      planBackwardLeads({
        inventory: INVENTORY,
        networkIndex: {
          transfers: [],
          patterns,
        },
        workplace: WP_GATE_WORKPLACE,
        constraints: CONSTRAINTS,
        maxFinalWalkMeters: 0,
        maxTransfers: 1,
      })
    const baseline = plan([...branches.slice(0, 2), trunk])
    expect(baseline.leads.some((lead) => lead.stop.id === 'FAR_WEST')).toBe(
      true,
    )
    expect(plan([...branches, trunk])).toEqual(baseline)
  })

  it('respects service dayType operating windows and pickup/drop-off flags', () => {
    const network = buildTransitNetworkIndex({
      inventory: INVENTORY,
      busRoutes: {
        '44': [
          [
            { stopId: 'MID_BUS', times: '0630 0930 - - - -' },
            { stopId: 'WP_STOP', times: '0635 0935 - - - -' },
          ],
        ],
      },
    })

    const sundayPlan = planBackwardLeads({
      inventory: {
        inventoryDate: INVENTORY.inventoryDate,
        stops: INVENTORY.stops.slice(0, 2),
      },
      networkIndex: {
        ...network,
        patterns: network.patterns.filter((p) => p.mode === 'BUS'),
      },
      workplace: POSTAL_WORKPLACE,
      constraints: { ...CONSTRAINTS, searchDate: '2026-11-29' }, // Sunday
    })
    expect(sundayPlan.leads).toEqual([])
  })

  it('allows upstream rail travel to exact station workplace while excluding destination station from routing leads', () => {
    const network = buildTransitNetworkIndex({
      inventory: INVENTORY,
      busRoutes: {},
    })

    const stationWorkplace: Workplace = {
      kind: 'station',
      stationId: 'NE18',
      label: 'NE18 Punggol Coast',
      point: { latitude: 1.415_018, longitude: 103.910_329 },
    }
    const plan = planBackwardLeads({
      inventory: INVENTORY,
      networkIndex: network,
      workplace: stationWorkplace,
      constraints: { ...CONSTRAINTS, rideCapMinutes: 15 },
    })

    const ids = plan.leads.map((l) => l.stop.id)
    expect(ids).not.toContain('NE18')
    expect(ids).toContain('NE17')
    expect(ids).toContain('NE16')
  })

  it('preserves the best over-cap estimate and its borderline probes', () => {
    const network: TransitNetworkIndex = {
      transfers: [],
      patterns: [
        { min: 5, est: 60 },
        { min: 10, est: 31 },
      ].map(({ min, est }) =>
        busPattern(`borderline-${est}`, {
          fromStopId: 'MID_BUS',
          toStopId: 'WP_STOP',
          minRideMs: min * 60_000,
          estRideMs: est * 60_000,
        }),
      ),
    }
    const plan = planBackwardLeads({
      inventory: INVENTORY,
      networkIndex: network,
      workplace: WP_GATE_WORKPLACE,
      constraints: CONSTRAINTS,
      maxTransfers: 0,
    })

    const lead = plan.leads.find((item) => item.stop.id === 'MID_BUS')
    expect(lead?.minRideMs).toBe(5 * 60_000)
    expect(lead?.estRideMs).toBe(31 * 60_000)
    expect(lead?.candidateDepartures).toEqual(['08:19:30', '08:13:30'])
  })

  it('applies a 4-minute interchange walk floor for same-point non-matching rail stations and symmetric 4-probe bracketing', () => {
    const interchangeInventory: StopInventory = {
      inventoryDate: INVENTORY.inventoryDate,
      stops: [
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
          id: 'CC16',
          kind: 'rail',
          name: 'Marymount',
          point: { latitude: 1.348_707, longitude: 103.839_423 },
        },
      ],
    }
    const network = buildTransitNetworkIndex({
      inventory: interchangeInventory,
      busRoutes: {},
    })
    const ns17 = interchangeInventory.stops[0]
    if (!ns17) {
      throw new Error('Missing NS17')
    }
    const plan = planBackwardLeads({
      inventory: interchangeInventory,
      networkIndex: network,
      workplace: {
        kind: 'station',
        stationId: 'NS17',
        label: 'NS17 Bishan',
        point: ns17.point,
      },
      constraints: CONSTRAINTS,
      maxProbesPerStop: 4,
    })

    const cc16Lead = plan.leads.find((l) => l.stop.id === 'CC16')
    expect(cc16Lead).toBeDefined()
    expect(cc16Lead?.candidateDepartures).toHaveLength(4)
    const primaryClock = cc16Lead?.candidateDepartures[0] ?? '09:00:00'
    // With 4-min interchange walk floor + ~2m CC16->CC15 ride + 2m forward bias, primary must be <= 08:45:00
    expect(primaryClock <= '08:45:00').toBe(true)
    const times = (cc16Lead?.candidateDepartures ?? []).map((c) => {
      const [h = 0, m = 0, s = 0] = c.split(':').map(Number)
      return h * 3600 + m * 60 + s
    })
    expect(times[1]).toBe((times[0] ?? 0) - 360)
    expect(times[2]).toBe((times[0] ?? 0) + 360)
    expect(Math.abs((times[3] ?? 0) - (times[0] ?? 0))).toBe(720)
  })

  it('preserves same-stop transfer eligibility when shifted boarding lands in the same 5-minute clock bucket', () => {
    const network: TransitNetworkIndex = {
      transfers: [],
      patterns: [
        busPattern('main-leg', {
          fromStopId: 'MID_BUS',
          toStopId: 'WP_STOP',
          minRideMs: 3 * 60_000,
          estRideMs: 3 * 60_000,
        }),
        busPattern('feeder-leg', {
          fromStopId: 'FAR_WEST',
          toStopId: 'MID_BUS',
          minRideMs: 5 * 60_000,
          estRideMs: 5 * 60_000,
        }),
      ],
    }

    // Workplace at WP_STOP (0m final walk): targetArrivalMs 08:52:30 -> MID_BUS estClockMs 08:49:30;
    // shifted back 3m for same-stop transfer -> 08:46:30 (same 08:45-08:50 5-min bucket).
    const plan = planBackwardLeads({
      inventory: INVENTORY,
      networkIndex: network,
      workplace: WP_GATE_WORKPLACE,
      constraints: CONSTRAINTS,
      maxFinalWalkMeters: 50,
    })

    expect(plan.leads.map((l) => l.stop.id)).toContain('FAR_WEST')
  })

  it('does not prune 249A-like segments under a 2-minute ride cap when first-bus delta is 3 minutes', () => {
    const inv249A: StopInventory = {
      inventoryDate: INVENTORY.inventoryDate,
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
    const network = buildTransitNetworkIndex({
      inventory: inv249A,
      busRoutes: {
        '249A': [
          [
            { stopId: '21359', times: '0634 0830 - - - -' },
            { stopId: '21349', times: '0637 0832 - - - -' },
          ],
        ],
      },
    })
    const segment = network.patterns.find((p) => p.serviceId === '249A')
      ?.segments[0]
    expect(segment).toBeDefined()
    expect(segment?.minRideMs).toBeLessThan(120_000)
    expect(segment?.estRideMs).toBeGreaterThanOrEqual(180_000)
    const plan = planBackwardLeads({
      inventory: inv249A,
      networkIndex: network,
      workplace: {
        kind: 'postal',
        postalCode: '639999',
        label: 'GSK',
        point: { latitude: 1.335_73, longitude: 103.709_39 },
      },
      constraints: {
        searchDate: SEARCH_DATE,
        officeStart: '08:35',
        rideCapMinutes: 2,
      },
    })
    expect(plan.leads.map((l) => l.stop.id)).toContain('21359')
  })

  it('uses previous service day overnight operating windows for after-midnight boardings', () => {
    const inv: StopInventory = {
      inventoryDate: INVENTORY.inventoryDate,
      stops: INVENTORY.stops.slice(0, 2),
    }

    const overnightNetwork = buildTransitNetworkIndex({
      inventory: inv,
      busRoutes: {
        // Weekday (Mon) runs 06:00 -> 00:35; Sat/Sun don't matter for Tue 00:30
        N1: [
          [
            { stopId: 'MID_BUS', times: '0600 0035 - - - -' },
            { stopId: 'WP_STOP', times: '0605 0040 - - - -' },
          ],
        ],
      },
    })
    const tuesdayPlan = planBackwardLeads({
      inventory: inv,
      networkIndex: overnightNetwork,
      workplace: WP_GATE_WORKPLACE,
      constraints: {
        searchDate: '2026-12-01', // Tuesday
        officeStart: '00:30',
        rideCapMinutes: 30,
      },
      maxFinalWalkMeters: 50,
    })
    const lead = tuesdayPlan.leads.find((l) => l.stop.id === 'MID_BUS')
    expect(lead).toBeDefined()
    expect(
      lead?.candidateDepartures.every((clock) => clock <= '00:30:00'),
    ).toBe(true)

    // Sunday had no service (- -), so Monday 00:30 must NOT use Monday's 06:00 morning window
    const sundayOffNetwork = buildTransitNetworkIndex({
      inventory: inv,
      busRoutes: {
        N1: [
          [
            { stopId: 'MID_BUS', times: '0600 0035 0600 0035 - -' },
            { stopId: 'WP_STOP', times: '0605 0040 0605 0040 - -' },
          ],
        ],
      },
    })
    const mondayEarlyPlan = planBackwardLeads({
      inventory: inv,
      networkIndex: {
        ...sundayOffNetwork,
        patterns: sundayOffNetwork.patterns.filter((p) => p.mode === 'BUS'),
      },
      workplace: WP_GATE_WORKPLACE,
      constraints: {
        searchDate: '2026-11-30', // Monday
        officeStart: '00:30',
        rideCapMinutes: 30,
      },
      maxFinalWalkMeters: 50,
    })
    expect(mondayEarlyPlan.leads).toEqual([])
  })

  it('does not let transfer-walk labels to stop B displace stop A boarding probe times', () => {
    const inv: StopInventory = {
      inventoryDate: INVENTORY.inventoryDate,
      stops: [
        WP_GATE_STOP,
        {
          id: 'STOP_A',
          kind: 'bus',
          name: 'Stop A',
          point: { latitude: 1.409, longitude: 103.905 },
        },
        {
          id: 'STOP_B',
          kind: 'bus',
          name: 'Stop B',
          point: { latitude: 1.4095, longitude: 103.9055 }, // ~78m from STOP_A
        },
      ],
    }
    const network: TransitNetworkIndex = {
      transfers: [
        {
          fromStopId: 'STOP_A',
          toStopId: 'STOP_B',
          walkMs: 60_000,
          minTransferWaitMs: 30_000,
          estTransferWaitMs: 120_000,
        },
      ],
      patterns: [
        busPattern('slow-from-a', {
          fromStopId: 'STOP_A',
          toStopId: 'WP_STOP',
          minRideMs: 25 * 60_000,
          estRideMs: 25 * 60_000,
        }),
        busPattern('fast-from-b', {
          fromStopId: 'STOP_B',
          toStopId: 'WP_STOP',
          minRideMs: 5 * 60_000,
          estRideMs: 5 * 60_000,
        }),
      ],
    }

    const plan = planBackwardLeads({
      inventory: inv,
      networkIndex: network,
      workplace: WP_GATE_WORKPLACE,
      constraints: CONSTRAINTS,
      maxFinalWalkMeters: 50,
    })

    const leadA = plan.leads.find((l) => l.stop.id === 'STOP_A')
    expect(leadA).toBeDefined()
    expect(leadA?.estRideMs).toBe(25 * 60_000)
    // Primary probe must reflect STOP_A's 25-min ride (~08:25:30), NOT STOP_B's ~08:42 transfer walk
    expect((leadA?.candidateDepartures[0] ?? '09:00:00') <= '08:30:00').toBe(
      true,
    )
  })

  it('connects feeder arrivals with waits exceeding twice the estimated transfer wait', () => {
    const network: TransitNetworkIndex = {
      transfers: [],
      patterns: [
        busPattern('main-0845', {
          fromStopId: 'MID_BUS',
          toStopId: 'WP_STOP',
          minRideMs: 10 * 60_000,
          estRideMs: 10 * 60_000,
          operatingWindows: {
            weekday: { firstMin: 525, lastMin: 530 }, // 08:45-08:50
          },
        }),
        busPattern('feeder-0820', {
          fromStopId: 'FAR_WEST',
          toStopId: 'MID_BUS',
          minRideMs: 10 * 60_000,
          estRideMs: 10 * 60_000,
          operatingWindows: {
            weekday: { firstMin: 480, lastMin: 500 }, // 08:00-08:20 (arrives 08:30, 15m wait)
          },
        }),
      ],
    }

    const plan = planBackwardLeads({
      inventory: INVENTORY,
      networkIndex: network,
      workplace: WP_GATE_WORKPLACE,
      constraints: CONSTRAINTS,
      maxFinalWalkMeters: 50,
    })

    expect(plan.leads.map((l) => l.stop.id)).toContain('FAR_WEST')
  })

  it('does not discard a label with a wider feasible interval for a cheaper narrow-window label', () => {
    for (const order of ['cheap-first', 'wide-first'] as const) {
      const cheapPattern = busPattern('cheap-narrow', {
        fromStopId: 'MID_BUS',
        toStopId: 'WP_STOP',
        minRideMs: 5 * 60_000,
        estRideMs: 5 * 60_000,
        operatingWindows: {
          weekday: { firstMin: 522, lastMin: 523 }, // 08:42-08:43
        },
      })
      const widePattern = busPattern('wide-slower', {
        fromStopId: 'MID_BUS',
        toStopId: 'WP_STOP',
        minRideMs: 10 * 60_000,
        estRideMs: 10 * 60_000,
        operatingWindows: {
          weekday: { firstMin: 520, lastMin: 530 }, // 08:40-08:50
        },
      })
      const feederPattern = busPattern('feeder-0846', {
        fromStopId: 'FAR_WEST',
        toStopId: 'MID_BUS',
        minRideMs: 5 * 60_000,
        estRideMs: 5 * 60_000,
        operatingWindows: {
          // Departs 08:41 -> arrives MID_BUS 08:46 -> misses 08:43, connects to 08:50
          weekday: { firstMin: 521, lastMin: 521 },
        },
      })

      const network: TransitNetworkIndex = {
        transfers: [],
        patterns:
          order === 'cheap-first'
            ? [cheapPattern, widePattern, feederPattern]
            : [widePattern, cheapPattern, feederPattern],
      }
      const plan = planBackwardLeads({
        inventory: INVENTORY,
        networkIndex: network,
        workplace: WP_GATE_WORKPLACE,
        constraints: CONSTRAINTS,
        maxFinalWalkMeters: 50,
      })

      expect(plan.leads.map((l) => l.stop.id)).toContain('FAR_WEST')
    }
  })

  it('does not bridge labels across a missing inventory stop in a bus route', () => {
    const inventory: StopInventory = {
      inventoryDate: INVENTORY.inventoryDate,
      stops: [
        WP_GATE_STOP,
        INVENTORY.stops[1] ?? WP_GATE_STOP, // MID_BUS
        {
          id: 'PRE_GAP_B',
          kind: 'bus',
          name: 'Pre Gap B',
          point: { latitude: 1.406, longitude: 103.903 },
        },
        {
          id: 'PRE_GAP_A',
          kind: 'bus',
          name: 'Pre Gap A',
          point: { latitude: 1.404, longitude: 103.901 },
        },
      ],
    }
    const gapNetwork = buildTransitNetworkIndex({
      inventory,
      busRoutes: {
        '77': [
          ['PRE_GAP_A', 'PRE_GAP_B', 'MISSING_STOP', 'MID_BUS', 'WP_STOP'].map(
            (stopId) => ({ stopId }),
          ),
        ],
      },
      maxTransferWalkMeters: 10,
    })
    const chunks = gapNetwork.patterns.filter((p) => p.serviceId === '77')
    expect(chunks).toHaveLength(2)
    expect(
      chunks.map((p) =>
        p.segments.map((s) => `${s.fromStopId}->${s.toStopId}`),
      ),
    ).toEqual([['PRE_GAP_A->PRE_GAP_B'], ['MID_BUS->WP_STOP']])
    const plan = planBackwardLeads({
      inventory,
      networkIndex: {
        ...gapNetwork,
        patterns: gapNetwork.patterns.filter((p) => p.mode === 'BUS'),
      },
      workplace: WP_GATE_WORKPLACE,
      constraints: CONSTRAINTS,
      maxFinalWalkMeters: 50,
    })
    expect(plan.leads.map((l) => l.stop.id)).toEqual(['MID_BUS'])
  })

  it('reaches BP1 from BP7 on Bukit Panjang LRT with zero transfers', () => {
    const bp7Point = { latitude: 1.377_756, longitude: 103.766_634 }
    const bpStops: Stop[] = [
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
        point: bp7Point,
      },
    ]
    const bpInventory: StopInventory = {
      inventoryDate: INVENTORY.inventoryDate,
      stops: bpStops,
    }
    const network = buildTransitNetworkIndex({
      inventory: bpInventory,
      busRoutes: {},
    })
    const plan = planBackwardLeads({
      inventory: bpInventory,
      networkIndex: network,
      workplace: {
        kind: 'station',
        stationId: 'BP7',
        label: 'BP7 Petir',
        point: bp7Point,
      },
      constraints: CONSTRAINTS,
      maxTransfers: 0,
    })

    const bp1Lead = plan.leads.find((l) => l.stop.id === 'BP1')
    expect(bp1Lead).toBeDefined()
    expect(bp1Lead?.transfers).toBe(0)
  })

  it('keeps loop probes invariant under rotation without passing the alighting stop', () => {
    const stops: Stop[] = ['A', 'B', 'C'].map((id, index) => ({
      id,
      kind: 'rail',
      name: id,
      point: { latitude: 1.3 + index * 0.01, longitude: 103.8 },
    }))
    const inventory: StopInventory = {
      inventoryDate: INVENTORY.inventoryDate,
      stops,
    }
    const planRoute = (
      edges: readonly (readonly [string, string])[],
      isLoop: boolean,
    ) =>
      planBackwardLeads({
        inventory,
        networkIndex: {
          transfers: [],
          patterns: [
            {
              patternId: 'loop',
              serviceId: 'loop',
              mode: 'RAIL',
              isLoop,
              segments: edges.map(([fromStopId, toStopId]) => ({
                fromStopId,
                toStopId,
                minRideMs: 600_000,
                estRideMs: 600_000,
              })),
            },
          ],
        },
        workplace: {
          kind: 'station',
          stationId: 'A',
          label: 'A',
          point: { latitude: 1.3, longitude: 103.8 },
        },
        constraints: { ...CONSTRAINTS, rideCapMinutes: 40 },
        maxTransfers: 0,
        maxFinalWalkMeters: 0,
      })
    const direct = planRoute([['C', 'A']], false).leads[0]
    expect(direct?.minRideMs).toBe(600_000)
    const original = planRoute(
      [
        ['A', 'B'],
        ['B', 'C'],
        ['C', 'A'],
      ],
      true,
    )
    const rotated = planRoute(
      [
        ['C', 'A'],
        ['A', 'B'],
        ['B', 'C'],
      ],
      true,
    )
    for (const plan of [original, rotated]) {
      expect(plan.leads.map((lead) => lead.stop.id)).not.toContain('A')
      const cLead = plan.leads.find((lead) => lead.stop.id === 'C')
      expect(cLead?.minRideMs).toBe(600_000)
      expect(cLead?.estRideMs).toBe(600_000)
      expect(cLead?.candidateDepartures).toEqual(direct?.candidateDepartures)
    }
    expect(original.leads).toEqual(rotated.leads)
  })

  it('preserves expressway bus 858 95159 -> 65191 under a 12-minute ride cap', () => {
    const inv858: StopInventory = {
      inventoryDate: INVENTORY.inventoryDate,
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
    const network = buildTransitNetworkIndex({
      inventory: inv858,
      busRoutes: {
        '858': [
          [
            { stopId: '95159', times: '0633 0044 0633 0043 0632 0039' },
            { stopId: '65191', times: '0647 0056 0647 0056 0645 0052' },
          ],
        ],
      },
    })
    const segment = network.patterns.find((p) => p.serviceId === '858')
      ?.segments[0]
    expect(segment).toBeDefined()
    expect(segment?.minRideMs).toBeLessThanOrEqual(12 * 60_000)
    const plan = planBackwardLeads({
      inventory: inv858,
      networkIndex: network,
      workplace: {
        kind: 'postal',
        postalCode: '790000',
        label: 'Aft TPE',
        point: { latitude: 1.390_718, longitude: 103.897_381 },
      },
      constraints: {
        searchDate: '2026-11-27', // Friday after midnight (Thursday service day)
        officeStart: '01:00',
        rideCapMinutes: 12,
      },
      maxFinalWalkMeters: 50,
    })
    expect(plan.leads.map((l) => l.stop.id)).toContain('95159')
  })

  it('carries over Sunday post-midnight 200A stops to Monday 00:10 and avoids false 24h Sunday windows', () => {
    const inv200A: StopInventory = {
      inventoryDate: INVENTORY.inventoryDate,
      stops: [
        {
          id: '18149',
          kind: 'bus',
          name: 'Aft Clementi Rd',
          point: { latitude: 1.298_95, longitude: 103.770_43 },
        },
        {
          id: '18129',
          kind: 'bus',
          name: 'Kent Ridge Stn',
          point: { latitude: 1.294_09, longitude: 103.784_01 },
        },
        {
          id: '16021',
          kind: 'bus',
          name: 'Bef Dover Rd',
          point: { latitude: 1.301_54, longitude: 103.778_84 },
        },
      ],
    }
    const network = buildTransitNetworkIndex({
      inventory: inv200A,
      busRoutes: {
        '200A': [
          [
            { stopId: '18149', times: '0850 0003 0003 0003 0002 0002' },
            { stopId: '18129', times: '0852 0005 0004 0004 0003 0003' },
            { stopId: '16021', times: '0903 0014 0015 0015 0014 0014' },
          ],
        ],
      },
    })

    const mondayPlan = planBackwardLeads({
      inventory: inv200A,
      networkIndex: network,
      workplace: {
        kind: 'postal',
        postalCode: '119074',
        label: '18129',
        point: { latitude: 1.294_09, longitude: 103.784_01 },
      },
      constraints: {
        searchDate: '2026-11-30', // Monday
        officeStart: '00:10',
        rideCapMinutes: 30,
      },
      maxFinalWalkMeters: 50,
    })
    const stop18149 = mondayPlan.leads.find((l) => l.stop.id === '18149')
    expect(stop18149).toBeDefined()
    expect(
      stop18149?.candidateDepartures.every((clock) => clock <= '00:10:00'),
    ).toBe(true)

    // Sunday 12:00 must NOT discover 18129 -> 16021 since Sunday 200A only runs after midnight (00:03 / 00:14)
    const sundayDayPlan = planBackwardLeads({
      inventory: inv200A,
      networkIndex: network,
      workplace: {
        kind: 'postal',
        postalCode: '119074',
        label: '16021',
        point: { latitude: 1.301_54, longitude: 103.778_84 },
      },
      constraints: {
        searchDate: '2026-11-29', // Sunday
        officeStart: '12:00',
        rideCapMinutes: 30,
      },
      maxFinalWalkMeters: 50,
    })
    expect(sundayDayPlan.leads).toEqual([])
  })

  it('allocates probes across both overnight and morning feasible windows within the 4-probe budget', () => {
    const network: TransitNetworkIndex = {
      transfers: [],
      patterns: [
        busPattern('connecting-0545-0600', {
          fromStopId: 'MID_BUS',
          toStopId: 'WP_STOP',
          minRideMs: 10 * 60_000,
          estRideMs: 10 * 60_000,
          operatingWindows: {
            weekday: { firstMin: 345, lastMin: 360 }, // 05:45-06:00
          },
        }),
        busPattern('feeder-0530-2522', {
          fromStopId: 'FAR_WEST',
          toStopId: 'MID_BUS',
          minRideMs: 10 * 60_000,
          estRideMs: 10 * 60_000,
          operatingWindows: {
            // Previous day runs 05:30 -> 25:22 (carries over 00:00-01:22), current day starts 05:30
            weekday: { firstMin: 330, lastMin: 1522 },
          },
        }),
      ],
    }

    const plan = planBackwardLeads({
      inventory: INVENTORY,
      networkIndex: network,
      workplace: WP_GATE_WORKPLACE,
      constraints: {
        searchDate: SEARCH_DATE,
        officeStart: '06:00',
        rideCapMinutes: 180,
      },
      maxFinalWalkMeters: 50,
      maxProbesPerStop: 4,
    })

    const farLead = plan.leads.find((l) => l.stop.id === 'FAR_WEST')
    expect(farLead).toBeDefined()
    expect(farLead?.candidateDepartures.length).toBeLessThanOrEqual(4)
    expect(
      farLead?.candidateDepartures.some((clock) => clock >= '05:00:00'),
    ).toBe(true)
    expect(
      farLead?.candidateDepartures.some((clock) => clock < '02:00:00'),
    ).toBe(true)
  })

  it('discovers an early 812 candidate from its second interchange visit', () => {
    const { network, plan } = planBundledService('812', '59091', '760000', {
      searchDate: SEARCH_DATE,
      officeStart: '05:35',
      rideCapMinutes: 5,
    })
    const visits = network.patterns
      .filter((pattern) => pattern.serviceId === '812')
      .flatMap((pattern) => pattern.segments)
      .filter((segment) => segment.fromStopId === '59009')
    expect(visits.map((segment) => segment.toStopId)).toEqual([
      '59169',
      '59091',
    ])
    expect(visits[1]?.operatingWindows).toEqual({
      weekday: { firstMin: 330, lastMin: 1496 },
      saturday: { firstMin: 330, lastMin: 1497 },
      sunday_holiday: { firstMin: 330, lastMin: 1496 },
    })
    const lead = plan.leads.find((item) => item.stop.id === '59009')
    expect(lead).toBeDefined()
    expect(
      lead?.candidateDepartures.some(
        (clock) => clock >= '05:30:00' && clock <= '05:35:00',
      ),
    ).toBe(true)
  })

  it('keeps the late 665 departure when its ride exceeds the estimate but fits the cap', () => {
    const { plan } = planBundledService('665', '08057', '238843', {
      searchDate: SEARCH_DATE,
      officeStart: '09:05',
      rideCapMinutes: 60,
    })

    // The last bus leaves 46991 at 08:01 and arrives at 08057 at 08:53.
    const lead = plan.leads.find((item) => item.stop.id === '46991')
    expect(lead).toBeDefined()
    expect(
      lead?.candidateDepartures.some(
        (clock) => clock >= '07:55:00' && clock <= '08:01:59',
      ),
    ).toBe(true)
  })

  it('discovers bundled 200A stop 16021 on Monday 00:20 across two 00:14 stops without widening service days', () => {
    const { plan } = planBundledService('200A', '16041', '119000', {
      searchDate: '2026-11-30',
      officeStart: '00:20',
      rideCapMinutes: 15,
    })

    const leadIds = plan.leads.map((l) => l.stop.id)
    expect(leadIds).toContain('16031')
    expect(leadIds).toContain('16021')
    // 11181 is 23:58 on Sunday (before midnight) and must not bleed into Monday
    expect(leadIds).not.toContain('11181')
  })

  it('preserves sorted ride costs after multiple evictions regardless of pattern order', () => {
    const stopIds = ['A1', 'A2', 'B', 'A3', 'U', 'Y', 'D']
    const inventory: StopInventory = {
      inventoryDate: INVENTORY.inventoryDate,
      stops: stopIds.map((id, index) => ({
        id,
        kind: 'bus',
        name: id,
        point: { latitude: (130 + index) / 100, longitude: 103.8 },
      })),
    }
    const downstream: TransitPattern[] = [
      { id: 'A1', departure: 524, minRide: 5, estRide: 6 },
      { id: 'A2', departure: 527, minRide: 5, estRide: 7 },
      { id: 'B', departure: 532, minRide: 8, estRide: 8 },
      { id: 'A3', departure: 528, minRide: 5, estRide: 5 },
    ].map(({ id, departure, minRide, estRide }) =>
      busPattern(id, {
        fromStopId: id,
        toStopId: 'D',
        minRideMs: minRide * 60_000,
        estRideMs: estRide * 60_000,
        operatingWindows: {
          weekday: { firstMin: departure, lastMin: departure },
        },
      }),
    )
    const upstream: TransitPattern = busPattern('U', {
      fromStopId: 'U',
      toStopId: 'Y',
      minRideMs: 6 * 60_000,
      estRideMs: 6 * 60_000,
    })

    for (const patterns of [
      [...downstream, upstream],
      [...downstream.slice(3), ...downstream.slice(0, 3), upstream],
    ]) {
      const network: TransitNetworkIndex = {
        patterns,
        transfers: ['A1', 'A2', 'B', 'A3'].map((toStopId) => ({
          fromStopId: 'Y',
          toStopId,
          walkMs: 60_000,
          minTransferWaitMs: 30_000,
          estTransferWaitMs: 3 * 60_000,
        })),
      }
      const plan = planBackwardLeads({
        inventory,
        networkIndex: network,
        workplace: {
          kind: 'postal',
          postalCode: '820000',
          label: 'D',
          point: { latitude: 1.36, longitude: 103.8 },
        },
        constraints: { ...CONSTRAINTS, rideCapMinutes: 12 },
        maxTransfers: 1,
        maxFinalWalkMeters: 0,
      })
      const uLead = plan.leads.find((lead) => lead.stop.id === 'U')
      expect(uLead?.minRideMs).toBe(11 * 60_000)
      expect(uLead?.estRideMs).toBe(11 * 60_000)
      expect(uLead?.transfers).toBe(1)
    }
  })

  it('preserves ride-cost and boarding-time correlation instead of splicing early cost onto later departure', () => {
    const xdCheapEarly: TransitPattern = busPattern('xd-cheap-early', {
      fromStopId: 'X',
      toStopId: 'D',
      minRideMs: 5 * 60_000,
      estRideMs: 5 * 60_000,
      operatingWindows: { weekday: { firstMin: 520, lastMin: 520 } }, // 08:40
    })
    const xdSlowLate: TransitPattern = busPattern('xd-slow-late', {
      fromStopId: 'X',
      toStopId: 'D',
      minRideMs: 10 * 60_000,
      estRideMs: 10 * 60_000,
      operatingWindows: { weekday: { firstMin: 529, lastMin: 529 } }, // 08:49
    })
    const uxLeg: TransitPattern = busPattern('ux-leg', {
      fromStopId: 'U',
      toStopId: 'X',
      minRideMs: 3 * 60_000,
      estRideMs: 3 * 60_000,
      operatingWindows: { weekday: { firstMin: 525, lastMin: 525 } }, // 08:45
    })

    for (const patterns of [
      [xdCheapEarly, xdSlowLate, uxLeg],
      [xdSlowLate, xdCheapEarly, uxLeg],
    ]) {
      const network: TransitNetworkIndex = {
        transfers: [],
        patterns,
      }
      const capped12 = planBackwardLeads({
        inventory: uxdInventory,
        networkIndex: network,
        workplace: workplaceD,
        constraints: {
          searchDate: SEARCH_DATE,
          officeStart: '09:00',
          rideCapMinutes: 12,
        },
        maxTransfers: 1,
      })
      expect(capped12.leads.map((l) => l.stop.id)).toEqual(['X'])

      const capped13 = planBackwardLeads({
        inventory: uxdInventory,
        networkIndex: network,
        workplace: workplaceD,
        constraints: {
          searchDate: SEARCH_DATE,
          officeStart: '09:00',
          rideCapMinutes: 13,
        },
        maxTransfers: 1,
      })
      const uLead = capped13.leads.find((l) => l.stop.id === 'U')
      expect(uLead?.minRideMs).toBe(13 * 60_000)
    }
  })

  it('propagates estimate-only improvements upstream regardless of pattern order', () => {
    const slowerXd: TransitPattern = busPattern('xd-slower-est', {
      fromStopId: 'X',
      toStopId: 'D',
      minRideMs: 5 * 60_000,
      estRideMs: 5 * 60_000 + 50_000,
      operatingWindows: { weekday: { firstMin: 530, lastMin: 530 } }, // 08:50
    })
    const fasterXd: TransitPattern = busPattern('xd-faster-est', {
      fromStopId: 'X',
      toStopId: 'D',
      minRideMs: 5 * 60_000,
      estRideMs: 5 * 60_000 + 10_000,
      operatingWindows: { weekday: { firstMin: 530, lastMin: 530 } }, // 08:50
    })
    const uxPattern: TransitPattern = busPattern('ux-open', {
      fromStopId: 'U',
      toStopId: 'X',
      minRideMs: 4 * 60_000,
      estRideMs: 4 * 60_000 + 30_000,
    })

    for (const patterns of [
      [slowerXd, fasterXd, uxPattern],
      [fasterXd, slowerXd, uxPattern],
    ]) {
      const plan = planBackwardLeads({
        inventory: uxdInventory,
        networkIndex: {
          transfers: [],
          patterns,
        },
        workplace: workplaceD,
        constraints: {
          searchDate: SEARCH_DATE,
          officeStart: '09:00',
          rideCapMinutes: 10,
        },
        maxTransfers: 1,
        maxProbesPerStop: 4,
      })

      const uLead = plan.leads.find((l) => l.stop.id === 'U')
      expect(uLead?.estRideMs).toBe(9 * 60_000 + 40_000)
      expect(uLead?.candidateDepartures).toHaveLength(4)
    }
  })

  it('allocates probes across disjoint feasible intervals even when windows are under 30 minutes apart', () => {
    const network: TransitNetworkIndex = {
      transfers: [],
      patterns: [
        busPattern('xd-0850', {
          fromStopId: 'X',
          toStopId: 'D',
          minRideMs: 5 * 60_000,
          estRideMs: 5 * 60_000,
          operatingWindows: { weekday: { firstMin: 530, lastMin: 530 } }, // 08:50
        }),
        busPattern('ux-0800', {
          fromStopId: 'U',
          toStopId: 'X',
          minRideMs: 5 * 60_000,
          estRideMs: 5 * 60_000,
          operatingWindows: { weekday: { firstMin: 480, lastMin: 480 } }, // 08:00
        }),
        busPattern('ux-0825', {
          fromStopId: 'U',
          toStopId: 'X',
          minRideMs: 5 * 60_000,
          estRideMs: 5 * 60_000,
          operatingWindows: { weekday: { firstMin: 505, lastMin: 505 } }, // 08:25
        }),
      ],
    }

    const plan = planBackwardLeads({
      inventory: uxdInventory,
      networkIndex: network,
      workplace: workplaceD,
      constraints: CONSTRAINTS,
      maxTransfers: 1,
      maxProbesPerStop: 4,
    })

    const uLead = plan.leads.find((l) => l.stop.id === 'U')
    expect(uLead).toBeDefined()
    expect(uLead?.candidateDepartures.length).toBeLessThanOrEqual(4)
    expect(
      uLead?.candidateDepartures.some(
        (c) => c >= '07:55:00' && c <= '08:00:59',
      ),
    ).toBe(true)
    expect(
      uLead?.candidateDepartures.some(
        (c) => c >= '08:20:00' && c <= '08:25:59',
      ),
    ).toBe(true)
  })

  it('retains materially different departure estimates when feasible intervals partially overlap', () => {
    const upstream: Stop = {
      id: 'U',
      kind: 'bus',
      name: 'Stop U',
      point: { latitude: 1.3, longitude: 103.7 },
    }
    const destination: Stop = { ...WP_GATE_STOP, id: 'D' }
    const plan = planBackwardLeads({
      inventory: {
        inventoryDate: INVENTORY.inventoryDate,
        stops: [upstream, destination],
      },
      networkIndex: {
        transfers: [],
        patterns: (
          [
            [5, 10],
            [12, 45],
          ] as const
        ).map<TransitPattern>(([minMinutes, estMinutes]) =>
          busPattern(`ud-${estMinutes}`, {
            fromStopId: 'U',
            toStopId: 'D',
            minRideMs: minMinutes * 60_000,
            estRideMs: estMinutes * 60_000,
          }),
        ),
      },
      workplace: WP_GATE_WORKPLACE,
      constraints: { ...CONSTRAINTS, rideCapMinutes: 45 },
      maxTransfers: 0,
      maxProbesPerStop: 4,
    })

    const departures = plan.leads.find(
      (lead) => lead.stop.id === 'U',
    )?.candidateDepartures
    expect(departures).toHaveLength(4)
    expect(departures).toContain('08:40:30')
    expect(departures).toContain('08:05:30')
  })

  it('routes the bundled Circle Line loop and spur within their operating windows', () => {
    const inventory = {
      ...bundledInventory,
      stops: bundledInventory.stops.filter((s) => s.id.startsWith('CC')),
    }
    const network = buildTransitNetworkIndex({
      inventory,
      busRoutes: {},
    })
    const networkIndex = { ...network, transfers: [] }
    const journey = (
      from: string,
      to: string,
      officeStart: string,
      rideCapMinutes: number,
      maxTransfers = 0,
      searchDate = SEARCH_DATE,
    ) => {
      const station = inventory.stops.find((s) => s.id === to)
      if (!station) throw new Error(`Missing bundled station ${to}`)
      const plan = planBackwardLeads({
        inventory,
        networkIndex,
        workplace: {
          kind: 'station',
          stationId: to,
          label: station.name,
          point: station.point,
        },
        constraints: { searchDate, officeStart, rideCapMinutes },
        maxTransfers,
        maxFinalWalkMeters: 0,
      })
      return plan.leads.find((lead) => lead.stop.id === from)
    }

    for (const [from, to] of [
      ['CC34', 'CC5'],
      ['CC5', 'CC34'],
    ] as const) {
      const loop = journey(from, to, '09:00', 15)
      expect(loop?.transfers).toBe(0)
    }
    expect(journey('CC34', 'CC5', '05:50', 15)).toBeUndefined()
    expect(journey('CC3', 'CC5', '09:00', 10)?.transfers).toBe(0)
    expect(journey('CC3', 'CC34', '09:00', 5)).toBeUndefined()

    // Spur riders change at Promenade off peak. Weekend mornings aren't a peak.
    expect(journey('CC3', 'CC8', '14:00', 20)).toBeUndefined()
    expect(journey('CC3', 'CC8', '14:00', 20, 1)?.transfers).toBe(1)
    expect(journey('CC3', 'CC8', '09:00', 20, 0, '2026-11-29')).toBeUndefined()
    for (const peak of ['09:00', '09:40', '16:30', '18:30']) {
      expect(journey('CC3', 'CC8', peak, 20)?.transfers).toBe(0)
    }
    // The reverse peak window advances with the train.
    expect(journey('CC8', 'CC3', '10:00', 20)?.transfers).toBe(0)
    expect(journey('CC1', 'CC32', '09:00', 60)?.transfers).toBe(0)
    expect(journey('CC1', 'CC34', '09:00', 60)).toBeUndefined()
  })
})
