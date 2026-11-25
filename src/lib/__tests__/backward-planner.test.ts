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

describe('backward-planner', () => {
  it('prunes unreachable distant stops, excludes walk-only stops, and reports uncovered stops', () => {
    const network = buildTransitNetworkIndex({
      inventory: INVENTORY,
      networkDate: SEARCH_DATE,
      busServices: {
        '381': { name: 'Local', routes: [['MID_BUS', 'WP_STOP']] },
        '999': { name: 'West Local', routes: [['FAR_WEST', 'MID_BUS']] }, // 11+ km single hop > 30m at 18m/s
      },
      busFirstLast: {
        MID_BUS: ['381 0530 2330 = = = ='],
        WP_STOP: ['381 0535 2335 = = = ='],
        FAR_WEST: ['999 0530 2330 = = = ='],
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
    expect(plan.prunedStopCount).toBeGreaterThanOrEqual(1)
  })

  it('preserves Pareto-distinct timing vs ride-time alternatives', () => {
    // Pattern FAST only runs after 08:50 when combined ride exceeds remaining window, while SLOWER operates in-window
    const network: TransitNetworkIndex = {
      version: 1,
      networkDate: SEARCH_DATE,
      inventoryDate: INVENTORY.inventoryDate,
      provenance: [],
      coveredStopIds: ['MID_BUS', 'WP_STOP'],
      transfers: [],
      patterns: [
        {
          patternId: 'fast-early',
          serviceId: 'F1',
          serviceName: 'F1',
          mode: 'BUS',
          headwayMs: 600_000,
          segments: [
            {
              fromStopId: 'MID_BUS',
              toStopId: 'WP_STOP',
              minRideMs: 28 * 60_000,
              estRideMs: 28 * 60_000,
              operatingWindows: {
                weekday: { firstMin: 530, lastMin: 560 },
              },
            },
          ],
        },
        {
          patternId: 'slow-in-window',
          serviceId: 'S1',
          serviceName: 'S1',
          mode: 'BUS',
          headwayMs: 600_000,
          segments: [
            {
              fromStopId: 'MID_BUS',
              toStopId: 'WP_STOP',
              minRideMs: 15 * 60_000,
              estRideMs: 20 * 60_000,
            },
          ],
        },
      ],
    }

    const plan = planBackwardLeads({
      inventory: INVENTORY,
      networkIndex: network,
      workplace: POSTAL_WORKPLACE,
      constraints: CONSTRAINTS,
    })

    const midLead = plan.leads.find((l) => l.stop.id === 'MID_BUS')
    expect(midLead).toBeDefined()
    expect(midLead?.minRideMs).toBe(15 * 60_000)
    expect(midLead?.estRideMs).toBe(20 * 60_000)
  })

  it('respects service dayType operating windows and pickup/drop-off flags', () => {
    const network = buildTransitNetworkIndex({
      inventory: INVENTORY,
      networkDate: SEARCH_DATE,
      busServices: {
        '44': { name: 'Weekday Only', routes: [['MID_BUS', 'WP_STOP']] },
      },
      busFirstLast: {
        MID_BUS: ['44 0630 0930 - - - -'],
        WP_STOP: ['44 0635 0935 - - - -'],
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
      networkDate: SEARCH_DATE,
      busServices: {},
      busFirstLast: {},
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

  it('caps borderline leads whose estimated ride exceeds ride cap to at most 2 candidate probes', () => {
    const network: TransitNetworkIndex = {
      version: 1,
      networkDate: SEARCH_DATE,
      inventoryDate: INVENTORY.inventoryDate,
      provenance: [],
      coveredStopIds: ['MID_BUS', 'WP_STOP'],
      transfers: [],
      patterns: [
        {
          patternId: 'borderline-bus',
          serviceId: 'B1',
          serviceName: 'B1',
          mode: 'BUS',
          headwayMs: 600_000,
          segments: [
            {
              fromStopId: 'MID_BUS',
              toStopId: 'WP_STOP',
              minRideMs: 3 * 60_000,
              estRideMs: 5 * 60_000,
            },
          ],
        },
      ],
    }
    const plan = planBackwardLeads({
      inventory: INVENTORY,
      networkIndex: network,
      workplace: POSTAL_WORKPLACE,
      constraints: { ...CONSTRAINTS, rideCapMinutes: 4 },
      maxProbesPerStop: 4,
    })

    const borderline = plan.leads.filter((l) => l.estRideMs > 4 * 60_000)
    expect(borderline).toHaveLength(1)
    expect(borderline[0]?.candidateDepartures.length).toBe(2)
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
      networkDate: SEARCH_DATE,
      busServices: {},
      busFirstLast: {},
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
      version: 1,
      networkDate: SEARCH_DATE,
      inventoryDate: INVENTORY.inventoryDate,
      provenance: [],
      coveredStopIds: ['FAR_WEST', 'MID_BUS', 'WP_STOP'],
      transfers: [],
      patterns: [
        {
          patternId: 'main-leg',
          serviceId: 'M1',
          serviceName: 'M1',
          mode: 'BUS',
          headwayMs: 600_000,
          segments: [
            {
              fromStopId: 'MID_BUS',
              toStopId: 'WP_STOP',
              minRideMs: 3 * 60_000,
              estRideMs: 3 * 60_000,
            },
          ],
        },
        {
          patternId: 'feeder-leg',
          serviceId: 'F1',
          serviceName: 'F1',
          mode: 'BUS',
          headwayMs: 600_000,
          segments: [
            {
              fromStopId: 'FAR_WEST',
              toStopId: 'MID_BUS',
              minRideMs: 5 * 60_000,
              estRideMs: 5 * 60_000,
            },
          ],
        },
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
      networkDate: SEARCH_DATE,
      busServices: {
        '249A': { name: '249A', routes: [['21359', '21349']] },
      },
      busFirstLast: {
        '21359': ['249A 0634 0830 - - - -'],
        '21349': ['249A 0637 0832 - - - -'],
      },
    })
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
      networkDate: '2026-12-01',
      busServices: {
        N1: { name: 'N1', routes: [['MID_BUS', 'WP_STOP']] },
      },
      busFirstLast: {
        // Weekday (Mon) runs 06:00 -> 00:35; Sat/Sun don't matter for Tue 00:30
        MID_BUS: ['N1 0600 0035 - - - -'],
        WP_STOP: ['N1 0605 0040 - - - -'],
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
      networkDate: '2026-11-30',
      busServices: {
        N1: { name: 'N1', routes: [['MID_BUS', 'WP_STOP']] },
      },
      busFirstLast: {
        MID_BUS: ['N1 0600 0035 0600 0035 - -'],
        WP_STOP: ['N1 0605 0040 0605 0040 - -'],
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
      version: 1,
      networkDate: SEARCH_DATE,
      inventoryDate: INVENTORY.inventoryDate,
      provenance: [],
      coveredStopIds: ['STOP_A', 'STOP_B', 'WP_STOP'],
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
        {
          patternId: 'slow-from-a',
          serviceId: 'A1',
          serviceName: 'A1',
          mode: 'BUS',
          headwayMs: 600_000,
          segments: [
            {
              fromStopId: 'STOP_A',
              toStopId: 'WP_STOP',
              minRideMs: 25 * 60_000,
              estRideMs: 25 * 60_000,
            },
          ],
        },
        {
          patternId: 'fast-from-b',
          serviceId: 'B1',
          serviceName: 'B1',
          mode: 'BUS',
          headwayMs: 600_000,
          segments: [
            {
              fromStopId: 'STOP_B',
              toStopId: 'WP_STOP',
              minRideMs: 5 * 60_000,
              estRideMs: 5 * 60_000,
            },
          ],
        },
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
      version: 1,
      networkDate: SEARCH_DATE,
      inventoryDate: INVENTORY.inventoryDate,
      provenance: [],
      coveredStopIds: ['FAR_WEST', 'MID_BUS', 'WP_STOP'],
      transfers: [],
      patterns: [
        {
          patternId: 'main-0845',
          serviceId: 'M1',
          serviceName: 'M1',
          mode: 'BUS',
          headwayMs: 600_000,
          segments: [
            {
              fromStopId: 'MID_BUS',
              toStopId: 'WP_STOP',
              minRideMs: 10 * 60_000,
              estRideMs: 10 * 60_000,
              operatingWindows: {
                weekday: { firstMin: 525, lastMin: 530 }, // 08:45-08:50
              },
            },
          ],
        },
        {
          patternId: 'feeder-0820',
          serviceId: 'F1',
          serviceName: 'F1',
          mode: 'BUS',
          headwayMs: 600_000,
          segments: [
            {
              fromStopId: 'FAR_WEST',
              toStopId: 'MID_BUS',
              minRideMs: 10 * 60_000,
              estRideMs: 10 * 60_000,
              operatingWindows: {
                weekday: { firstMin: 480, lastMin: 500 }, // 08:00-08:20 (arrives 08:30, 15m wait)
              },
            },
          ],
        },
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
      const cheapPattern = {
        patternId: 'cheap-narrow',
        serviceId: 'C1',
        serviceName: 'C1',
        mode: 'BUS' as const,
        headwayMs: 600_000,
        segments: [
          {
            fromStopId: 'MID_BUS',
            toStopId: 'WP_STOP',
            minRideMs: 5 * 60_000,
            estRideMs: 5 * 60_000,
            operatingWindows: {
              weekday: { firstMin: 522, lastMin: 523 }, // 08:42-08:43
            },
          },
        ],
      }
      const widePattern = {
        patternId: 'wide-slower',
        serviceId: 'W1',
        serviceName: 'W1',
        mode: 'BUS' as const,
        headwayMs: 600_000,
        segments: [
          {
            fromStopId: 'MID_BUS',
            toStopId: 'WP_STOP',
            minRideMs: 10 * 60_000,
            estRideMs: 10 * 60_000,
            operatingWindows: {
              weekday: { firstMin: 520, lastMin: 530 }, // 08:40-08:50
            },
          },
        ],
      }
      const feederPattern = {
        patternId: 'feeder-0846',
        serviceId: 'F1',
        serviceName: 'F1',
        mode: 'BUS' as const,
        headwayMs: 600_000,
        segments: [
          {
            fromStopId: 'FAR_WEST',
            toStopId: 'MID_BUS',
            minRideMs: 5 * 60_000,
            estRideMs: 5 * 60_000,
            operatingWindows: {
              // Departs 08:41 -> arrives MID_BUS 08:46 -> misses 08:43, connects to 08:50
              weekday: { firstMin: 521, lastMin: 521 },
            },
          },
        ],
      }

      const network: TransitNetworkIndex = {
        version: 1,
        networkDate: SEARCH_DATE,
        inventoryDate: INVENTORY.inventoryDate,
        provenance: [],
        coveredStopIds: ['FAR_WEST', 'MID_BUS', 'WP_STOP'],
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
    const gapNetwork = buildTransitNetworkIndex({
      inventory: {
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
      },
      networkDate: SEARCH_DATE,
      busServices: {
        '77': {
          name: '77',
          routes: [
            ['PRE_GAP_A', 'PRE_GAP_B', 'MISSING_STOP', 'MID_BUS', 'WP_STOP'],
          ],
        },
      },
      busFirstLast: {},
      maxTransferWalkMeters: 10,
    })
    const plan = planBackwardLeads({
      inventory: {
        inventoryDate: INVENTORY.inventoryDate,
        stops: [
          WP_GATE_STOP,
          INVENTORY.stops[1] ?? WP_GATE_STOP,
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
      },
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
      networkDate: SEARCH_DATE,
      busServices: {},
      busFirstLast: {},
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
      networkDate: SEARCH_DATE,
      busServices: {
        '858': { name: '858', routes: [['95159', '65191']] },
      },
      busFirstLast: {
        '95159': ['858 0633 0044 = 0043 0632 0039'],
        '65191': ['858 0647 0056 = = 0645 0052'],
      },
    })
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
      networkDate: '2026-11-30',
      busServices: {
        '200A': { name: '200A', routes: [['18149', '18129', '16021']] },
      },
      busFirstLast: {
        '18149': ['200A 0850 0003 0003 = 0002 0002'],
        '18129': ['200A 0852 0005 0004 0004 0003 0003'],
        '16021': ['200A 0903 0014 0015 0015 0014 ='],
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
      version: 1,
      networkDate: SEARCH_DATE,
      inventoryDate: INVENTORY.inventoryDate,
      provenance: [],
      coveredStopIds: ['FAR_WEST', 'MID_BUS', 'WP_STOP'],
      transfers: [],
      patterns: [
        {
          patternId: 'connecting-0545-0600',
          serviceId: 'C1',
          serviceName: 'C1',
          mode: 'BUS',
          headwayMs: 600_000,
          segments: [
            {
              fromStopId: 'MID_BUS',
              toStopId: 'WP_STOP',
              minRideMs: 10 * 60_000,
              estRideMs: 10 * 60_000,
              operatingWindows: {
                weekday: { firstMin: 345, lastMin: 360 }, // 05:45-06:00
              },
            },
          ],
        },
        {
          patternId: 'feeder-0530-2522',
          serviceId: 'F1',
          serviceName: 'F1',
          mode: 'BUS',
          headwayMs: 600_000,
          segments: [
            {
              fromStopId: 'FAR_WEST',
              toStopId: 'MID_BUS',
              minRideMs: 10 * 60_000,
              estRideMs: 10 * 60_000,
              operatingWindows: {
                // Previous day runs 05:30 -> 25:22 (carries over 00:00-01:22), current day starts 05:30
                weekday: { firstMin: 330, lastMin: 1522 },
              },
            },
          ],
        },
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

  it('routes CC3 to CC5 on Circle Line with zero transfers without inventing CC3 -> CC4 -> CC34', () => {
    const ccStops: Stop[] = [
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
        id: 'CC10',
        kind: 'rail',
        name: 'MacPherson',
        point: { latitude: 1.326_728, longitude: 103.890_102 },
      },
      {
        id: 'CC34',
        kind: 'rail',
        name: 'Bayfront',
        point: { latitude: 1.282_535, longitude: 103.859_73 },
      },
    ]
    const ccInventory: StopInventory = {
      inventoryDate: INVENTORY.inventoryDate,
      stops: ccStops,
    }
    const network = buildTransitNetworkIndex({
      inventory: ccInventory,
      networkDate: SEARCH_DATE,
      busServices: {},
      busFirstLast: {},
    })

    const cc5Plan = planBackwardLeads({
      inventory: ccInventory,
      networkIndex: network,
      workplace: {
        kind: 'station',
        stationId: 'CC5',
        label: 'CC5 Nicoll Highway',
        point: { latitude: 1.299_671, longitude: 103.8635 },
      },
      constraints: { ...CONSTRAINTS, rideCapMinutes: 10 },
      maxTransfers: 0,
      maxFinalWalkMeters: 50,
    })
    expect(cc5Plan.leads.find((l) => l.stop.id === 'CC3')?.transfers).toBe(0)

    // CC3 -> CC4 -> CC10 -> CC34 is far longer than 5 minutes, whereas an invented CC3 -> CC4 -> CC34 shortcut would take ~3m
    const cc34Plan = planBackwardLeads({
      inventory: ccInventory,
      networkIndex: network,
      workplace: {
        kind: 'station',
        stationId: 'CC34',
        label: 'CC34 Bayfront',
        point: { latitude: 1.282_535, longitude: 103.859_73 },
      },
      constraints: { ...CONSTRAINTS, rideCapMinutes: 5 },
      maxTransfers: 0,
      maxFinalWalkMeters: 50,
    })
    expect(cc34Plan.leads.map((l) => l.stop.id)).not.toContain('CC3')
  })

  it('discovers bundled 200A stop 16021 on Monday 00:20 across two 00:14 stops without widening service days', () => {
    const inventory = parseStopInventory(
      readFileSync('public/data/stops.tsv', 'utf8'),
    )
    const bus = parseBusNetworkTsv(
      readFileSync('public/data/bus-network.tsv', 'utf8'),
    )
    const fullNetwork = buildTransitNetworkIndex({
      inventory,
      networkDate: bus.networkDate,
      busServices: bus.busServices,
      busFirstLast: bus.busFirstLast,
    })
    const stop16041 = inventory.stops.find((s) => s.id === '16041')
    if (!stop16041) {
      throw new Error('Missing stop 16041')
    }
    const plan = planBackwardLeads({
      inventory,
      networkIndex: {
        ...fullNetwork,
        patterns: fullNetwork.patterns.filter((p) => p.serviceId === '200A'),
        transfers: [],
      },
      workplace: {
        kind: 'postal',
        postalCode: '119000',
        label: '16041',
        point: stop16041.point,
      },
      constraints: {
        searchDate: '2026-11-30',
        officeStart: '00:20',
        rideCapMinutes: 15,
      },
      maxTransfers: 0,
      maxFinalWalkMeters: 0,
    })

    const leadIds = plan.leads.map((l) => l.stop.id)
    expect(leadIds).toContain('16031')
    expect(leadIds).toContain('16021')
    // 11181 is 23:58 on Sunday (before midnight) and must not bleed into Monday
    expect(leadIds).not.toContain('11181')
  })

  it('preserves ride-cost and boarding-time correlation instead of splicing early cost onto later departure', () => {
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
    const xdCheapEarly: TransitPattern = {
      patternId: 'xd-cheap-early',
      serviceId: 'XD1',
      serviceName: 'XD1',
      mode: 'BUS',
      headwayMs: 600_000,
      segments: [
        {
          fromStopId: 'X',
          toStopId: 'D',
          minRideMs: 5 * 60_000,
          estRideMs: 5 * 60_000,
          operatingWindows: { weekday: { firstMin: 520, lastMin: 520 } }, // 08:40
        },
      ],
    }
    const xdSlowLate: TransitPattern = {
      patternId: 'xd-slow-late',
      serviceId: 'XD2',
      serviceName: 'XD2',
      mode: 'BUS',
      headwayMs: 600_000,
      segments: [
        {
          fromStopId: 'X',
          toStopId: 'D',
          minRideMs: 10 * 60_000,
          estRideMs: 10 * 60_000,
          operatingWindows: { weekday: { firstMin: 529, lastMin: 529 } }, // 08:49
        },
      ],
    }
    const uxLeg: TransitPattern = {
      patternId: 'ux-leg',
      serviceId: 'UX1',
      serviceName: 'UX1',
      mode: 'BUS',
      headwayMs: 600_000,
      segments: [
        {
          fromStopId: 'U',
          toStopId: 'X',
          minRideMs: 3 * 60_000,
          estRideMs: 3 * 60_000,
          operatingWindows: { weekday: { firstMin: 525, lastMin: 525 } }, // 08:45
        },
      ],
    }

    for (const patterns of [
      [xdCheapEarly, xdSlowLate, uxLeg],
      [xdSlowLate, xdCheapEarly, uxLeg],
    ]) {
      const network: TransitNetworkIndex = {
        version: 1,
        networkDate: SEARCH_DATE,
        inventoryDate: INVENTORY.inventoryDate,
        provenance: [],
        coveredStopIds: ['U', 'X', 'D'],
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
    const slowerXd: TransitPattern = {
      patternId: 'xd-slower-est',
      serviceId: 'XD1',
      serviceName: 'XD1',
      mode: 'BUS',
      headwayMs: 600_000,
      segments: [
        {
          fromStopId: 'X',
          toStopId: 'D',
          minRideMs: 5 * 60_000,
          estRideMs: 5 * 60_000 + 50_000,
          operatingWindows: { weekday: { firstMin: 530, lastMin: 530 } }, // 08:50
        },
      ],
    }
    const fasterXd: TransitPattern = {
      patternId: 'xd-faster-est',
      serviceId: 'XD2',
      serviceName: 'XD2',
      mode: 'BUS',
      headwayMs: 600_000,
      segments: [
        {
          fromStopId: 'X',
          toStopId: 'D',
          minRideMs: 5 * 60_000,
          estRideMs: 5 * 60_000 + 10_000,
          operatingWindows: { weekday: { firstMin: 530, lastMin: 530 } }, // 08:50
        },
      ],
    }
    const uxPattern: TransitPattern = {
      patternId: 'ux-open',
      serviceId: 'UX1',
      serviceName: 'UX1',
      mode: 'BUS',
      headwayMs: 600_000,
      segments: [
        {
          fromStopId: 'U',
          toStopId: 'X',
          minRideMs: 4 * 60_000,
          estRideMs: 4 * 60_000 + 30_000,
        },
      ],
    }

    for (const patterns of [
      [slowerXd, fasterXd, uxPattern],
      [fasterXd, slowerXd, uxPattern],
    ]) {
      const plan = planBackwardLeads({
        inventory: uxdInventory,
        networkIndex: {
          version: 1,
          networkDate: SEARCH_DATE,
          inventoryDate: INVENTORY.inventoryDate,
          provenance: [],
          coveredStopIds: ['U', 'X', 'D'],
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
    const network: TransitNetworkIndex = {
      version: 1,
      networkDate: SEARCH_DATE,
      inventoryDate: INVENTORY.inventoryDate,
      provenance: [],
      coveredStopIds: ['U', 'X', 'D'],
      transfers: [],
      patterns: [
        {
          patternId: 'xd-0850',
          serviceId: 'XD',
          serviceName: 'XD',
          mode: 'BUS',
          headwayMs: 600_000,
          segments: [
            {
              fromStopId: 'X',
              toStopId: 'D',
              minRideMs: 5 * 60_000,
              estRideMs: 5 * 60_000,
              operatingWindows: { weekday: { firstMin: 530, lastMin: 530 } }, // 08:50
            },
          ],
        },
        {
          patternId: 'ux-0800',
          serviceId: 'UX_EARLY',
          serviceName: 'UX_EARLY',
          mode: 'BUS',
          headwayMs: 600_000,
          segments: [
            {
              fromStopId: 'U',
              toStopId: 'X',
              minRideMs: 5 * 60_000,
              estRideMs: 5 * 60_000,
              operatingWindows: { weekday: { firstMin: 480, lastMin: 480 } }, // 08:00
            },
          ],
        },
        {
          patternId: 'ux-0825',
          serviceId: 'UX_LATE',
          serviceName: 'UX_LATE',
          mode: 'BUS',
          headwayMs: 600_000,
          segments: [
            {
              fromStopId: 'U',
              toStopId: 'X',
              minRideMs: 5 * 60_000,
              estRideMs: 5 * 60_000,
              operatingWindows: { weekday: { firstMin: 505, lastMin: 505 } }, // 08:25
            },
          ],
        },
      ],
    }

    const plan = planBackwardLeads({
      inventory: uxdInventory,
      networkIndex: network,
      workplace: {
        kind: 'postal',
        postalCode: '820000',
        label: 'Stop D',
        point: { latitude: 1.4, longitude: 103.9 },
      },
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

  it('carries Circle Line loop through CC4 in both directions with zero transfers', () => {
    const inventory = parseStopInventory(
      readFileSync('public/data/stops.tsv', 'utf8'),
    )
    const bus = parseBusNetworkTsv(
      readFileSync('public/data/bus-network.tsv', 'utf8'),
    )
    const fullNetwork = buildTransitNetworkIndex({
      inventory,
      networkDate: bus.networkDate,
      busServices: bus.busServices,
      busFirstLast: bus.busFirstLast,
    })
    const ccOnlyNetwork: TransitNetworkIndex = {
      ...fullNetwork,
      patterns: fullNetwork.patterns.filter(
        (p) => p.serviceId === 'CC' || p.serviceId === 'CC_LOOP',
      ),
      transfers: [],
    }
    const cc5 = inventory.stops.find((s) => s.id === 'CC5')
    const cc34 = inventory.stops.find((s) => s.id === 'CC34')
    if (!cc5 || !cc34) {
      throw new Error('Missing CC5 or CC34')
    }

    const toCc5 = planBackwardLeads({
      inventory,
      networkIndex: ccOnlyNetwork,
      workplace: {
        kind: 'station',
        stationId: 'CC5',
        label: 'CC5 Nicoll Highway',
        point: cc5.point,
      },
      constraints: {
        searchDate: '2026-11-26',
        officeStart: '09:00',
        rideCapMinutes: 15,
      },
      maxTransfers: 0,
      maxFinalWalkMeters: 0,
    })
    const cc34Lead = toCc5.leads.find((l) => l.stop.id === 'CC34')
    expect(cc34Lead?.transfers).toBe(0)
    expect(cc34Lead?.minRideMs).toBeGreaterThan(120_000)

    const toCc34 = planBackwardLeads({
      inventory,
      networkIndex: ccOnlyNetwork,
      workplace: {
        kind: 'station',
        stationId: 'CC34',
        label: 'CC34 Bayfront',
        point: cc34.point,
      },
      constraints: {
        searchDate: '2026-11-26',
        officeStart: '09:00',
        rideCapMinutes: 15,
      },
      maxTransfers: 0,
      maxFinalWalkMeters: 0,
    })
    const cc5Lead = toCc34.leads.find((l) => l.stop.id === 'CC5')
    expect(cc5Lead?.transfers).toBe(0)
    expect(cc5Lead?.minRideMs).toBeGreaterThan(120_000)
  })

  it('models Circle Line spur peak through-service vs off-peak/weekend shuttle at Promenade', () => {
    const inventory = parseStopInventory(
      readFileSync('public/data/stops.tsv', 'utf8'),
    )
    const bus = parseBusNetworkTsv(
      readFileSync('public/data/bus-network.tsv', 'utf8'),
    )
    const fullNetwork = buildTransitNetworkIndex({
      inventory,
      networkDate: bus.networkDate,
      busServices: bus.busServices,
      busFirstLast: bus.busFirstLast,
    })
    const ccOnlyNetwork: TransitNetworkIndex = {
      ...fullNetwork,
      patterns: fullNetwork.patterns.filter(
        (p) => p.serviceId === 'CC' || p.serviceId === 'CC_LOOP',
      ),
      transfers: [],
    }
    const cc8 = inventory.stops.find((s) => s.id === 'CC8')
    const cc32 = inventory.stops.find((s) => s.id === 'CC32')
    const cc34 = inventory.stops.find((s) => s.id === 'CC34')
    if (!cc8 || !cc32 || !cc34) {
      throw new Error('Missing CC8, CC32, or CC34')
    }

    const cc8Workplace: Workplace = {
      kind: 'station',
      stationId: 'CC8',
      label: 'CC8 Dakota',
      point: cc8.point,
    }

    // Off-peak weekday: CC3 -> CC8 requires a transfer (not a direct spur ride)
    const offPeakDirect = planBackwardLeads({
      inventory,
      networkIndex: ccOnlyNetwork,
      workplace: cc8Workplace,
      constraints: {
        searchDate: '2026-11-26',
        officeStart: '14:00',
        rideCapMinutes: 20,
      },
      maxTransfers: 0,
      maxFinalWalkMeters: 0,
    })
    expect(offPeakDirect.leads.map((l) => l.stop.id)).not.toContain('CC3')

    const offPeakTransfer = planBackwardLeads({
      inventory,
      networkIndex: ccOnlyNetwork,
      workplace: cc8Workplace,
      constraints: {
        searchDate: '2026-11-26',
        officeStart: '14:00',
        rideCapMinutes: 20,
      },
      maxTransfers: 1,
      maxFinalWalkMeters: 0,
    })
    expect(
      offPeakTransfer.leads.find((l) => l.stop.id === 'CC3')?.transfers,
    ).toBe(1)

    // Weekend: CC3 -> CC8 also requires a transfer
    const sundayDirect = planBackwardLeads({
      inventory,
      networkIndex: ccOnlyNetwork,
      workplace: cc8Workplace,
      constraints: {
        searchDate: '2026-11-29',
        officeStart: '09:00',
        rideCapMinutes: 20,
      },
      maxTransfers: 0,
      maxFinalWalkMeters: 0,
    })
    expect(sundayDirect.leads.map((l) => l.stop.id)).not.toContain('CC3')

    // Weekday AM and PM peaks: CC3 -> CC8 is a direct spur ride
    for (const officeStart of ['09:00', '18:30']) {
      const peakDirect = planBackwardLeads({
        inventory,
        networkIndex: ccOnlyNetwork,
        workplace: cc8Workplace,
        constraints: {
          searchDate: '2026-11-26',
          officeStart,
          rideCapMinutes: 20,
        },
        maxTransfers: 0,
        maxFinalWalkMeters: 0,
      })
      expect(peakDirect.leads.find((l) => l.stop.id === 'CC3')?.transfers).toBe(
        0,
      )
    }

    // Weekday peak spur serves CC1 <-> CC32 via CC4->CC5->Bishan, never CC1 -> CC34 direct
    const cc1ToCc32 = planBackwardLeads({
      inventory,
      networkIndex: ccOnlyNetwork,
      workplace: {
        kind: 'station',
        stationId: 'CC32',
        label: 'CC32 Prince Edward Road',
        point: cc32.point,
      },
      constraints: {
        searchDate: '2026-11-26',
        officeStart: '09:00',
        rideCapMinutes: 60,
      },
      maxTransfers: 0,
      maxFinalWalkMeters: 0,
    })
    expect(cc1ToCc32.leads.find((l) => l.stop.id === 'CC1')?.transfers).toBe(0)

    const cc1ToCc34 = planBackwardLeads({
      inventory,
      networkIndex: ccOnlyNetwork,
      workplace: {
        kind: 'station',
        stationId: 'CC34',
        label: 'CC34 Bayfront',
        point: cc34.point,
      },
      constraints: {
        searchDate: '2026-11-26',
        officeStart: '09:00',
        rideCapMinutes: 60,
      },
      maxTransfers: 0,
      maxFinalWalkMeters: 0,
    })
    expect(cc1ToCc34.leads.map((l) => l.stop.id)).not.toContain('CC1')
  })
})
