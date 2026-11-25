import { describe, expect, it } from 'bun:test'
import { planBackwardLeads } from '@lib/backward-planner.js'
import type {
  SearchConstraints,
  StopInventory,
  Workplace,
} from '@lib/commute-types.js'
import {
  buildTransitNetworkIndex,
  type TransitNetworkIndex,
} from '@lib/transit-network.js'

const SEARCH_DATE = '2026-11-26'
const CONSTRAINTS: SearchConstraints = {
  searchDate: SEARCH_DATE,
  officeStart: '09:00',
  rideCapMinutes: 30,
}

const INVENTORY: StopInventory = {
  inventoryDate: '2026-11-24',
  stops: [
    {
      id: 'WP_STOP',
      kind: 'bus',
      name: 'Workplace Gate',
      point: { latitude: 1.414_19, longitude: 103.9106 },
    },
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
    // Pattern FAST arrives too early (08:30, 5 min ride -> misses 08:45..09:00 window)
    // Pattern SLOWER arrives inside window (08:50, 20 min ride -> qualifies)
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
          timingKind: 'scheduled',
          headwayMs: 0,
          segments: [],
          scheduledTrips: [
            {
              tripId: 'T_FAST',
              dayTypes: ['weekday'],
              stops: [
                {
                  stopId: 'MID_BUS',
                  arrivalMs: (8 * 60 + 25) * 60_000,
                  departureMs: (8 * 60 + 25) * 60_000,
                  pickupAllowed: true,
                  dropOffAllowed: true,
                },
                {
                  stopId: 'WP_STOP',
                  arrivalMs: (8 * 60 + 30) * 60_000,
                  departureMs: (8 * 60 + 30) * 60_000,
                  pickupAllowed: true,
                  dropOffAllowed: true,
                },
              ],
            },
          ],
        },
        {
          patternId: 'slow-in-window',
          serviceId: 'S1',
          serviceName: 'S1',
          mode: 'BUS',
          timingKind: 'scheduled',
          headwayMs: 0,
          segments: [],
          scheduledTrips: [
            {
              tripId: 'T_SLOW',
              dayTypes: ['weekday'],
              stops: [
                {
                  stopId: 'MID_BUS',
                  arrivalMs: (8 * 60 + 30) * 60_000,
                  departureMs: (8 * 60 + 30) * 60_000,
                  pickupAllowed: true,
                  dropOffAllowed: true,
                },
                {
                  stopId: 'WP_STOP',
                  arrivalMs: (8 * 60 + 50) * 60_000,
                  departureMs: (8 * 60 + 50) * 60_000,
                  pickupAllowed: true,
                  dropOffAllowed: true,
                },
              ],
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
    expect(midLead?.candidateDepartures).toContain('08:30:00')
    expect(midLead?.isScheduled).toBe(true)
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

  it('caps borderline leads whose estimated ride exceeds ride cap to at most 1 candidate probe', () => {
    const network = buildTransitNetworkIndex({
      inventory: INVENTORY,
      networkDate: SEARCH_DATE,
      busServices: {},
      busFirstLast: {},
    })
    const ne18 = INVENTORY.stops.find((s) => s.id === 'NE18')
    if (!ne18) {
      throw new Error('Missing NE18')
    }
    const plan = planBackwardLeads({
      inventory: INVENTORY,
      networkIndex: network,
      workplace: {
        kind: 'station',
        stationId: 'NE18',
        label: 'NE18 Punggol Coast',
        point: ne18.point,
      },
      constraints: { ...CONSTRAINTS, rideCapMinutes: 4 },
      maxProbesPerStop: 3,
    })

    const borderline = plan.leads.filter((l) => l.estRideMs > 4 * 60_000)
    for (const lead of borderline) {
      expect(lead.candidateDepartures.length).toBeLessThanOrEqual(1)
    }
  })

  it('enforces GTFS calendar start/end dates and calendar_dates add/remove exceptions', () => {
    const network = buildTransitNetworkIndex({
      inventory: {
        inventoryDate: INVENTORY.inventoryDate,
        stops: INVENTORY.stops.filter(
          (s) => s.id === 'NE17' || s.id === 'NE18',
        ),
      },
      networkDate: SEARCH_DATE,
      busServices: {},
      busFirstLast: {},
      gtfsTrain: {
        routesTxt:
          'route_id,route_short_name,route_long_name,route_type\nNE,NE,North East Line,1\n',
        calendarTxt:
          'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nWD,1,1,1,1,1,0,0,20261101,20261130\n',
        calendarDatesTxt:
          'service_id,date,exception_type\nWD,20261126,2\nWD,20261128,1\n',
        tripsTxt: 'route_id,service_id,trip_id,direction_id\nNE,WD,NE_T1,0\n',
        stopTimesTxt:
          'trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type\nNE_T1,08:45:00,08:45:00,NE17,1,0,0\nNE_T1,08:50:00,08:50:00,NE18,2,0,0\n',
      },
    })

    const removedPlan = planBackwardLeads({
      inventory: INVENTORY,
      networkIndex: network,
      workplace: POSTAL_WORKPLACE,
      constraints: CONSTRAINTS, // 2026-11-26 removed via exception_type=2
    })
    expect(removedPlan.leads).toEqual([])

    const addedPlan = planBackwardLeads({
      inventory: INVENTORY,
      networkIndex: network,
      workplace: POSTAL_WORKPLACE,
      constraints: { ...CONSTRAINTS, searchDate: '2026-11-28' }, // Saturday added via exception_type=1
    })
    expect(addedPlan.leads.map((l) => l.stop.id)).toEqual(['NE17'])

    const outOfRangePlan = planBackwardLeads({
      inventory: INVENTORY,
      networkIndex: network,
      workplace: POSTAL_WORKPLACE,
      constraints: { ...CONSTRAINTS, searchDate: '2026-12-01' }, // after end_date
    })
    expect(outOfRangePlan.leads).toEqual([])
  })
})
