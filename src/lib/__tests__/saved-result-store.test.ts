import { describe, expect, it } from 'bun:test'
import type { CompletedSearchSnapshot } from '@lib/commute-types.js'
import {
  loadCompletedResult,
  saveCompletedResult,
} from '@lib/saved-result-store.js'

const createMemoryStorage = (): Storage => {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => {
      map.delete(key)
    },
    setItem: (key: string, value: string) => {
      map.set(key, value)
    },
  }
}

const SAMPLE_SNAPSHOT: CompletedSearchSnapshot = {
  version: 1,
  completedAtIso: '2026-06-02T01:10:00.000Z',
  inventoryDate: '2026-11-24',
  workplace: {
    kind: 'postal',
    postalCode: '018989',
    label: '18 MARINA GARDENS DR',
    point: { latitude: 1.2789, longitude: 103.8536 },
  },
  constraints: {
    searchDate: '2026-06-02',
    officeStart: '09:00',
    rideCapMinutes: 30,
  },
  triedCount: 5426,
  totalCount: 5426,
  matches: [
    {
      stop: {
        id: '65009',
        kind: 'bus',
        name: 'Punggol Temp Int',
        point: { latitude: 1.403_69, longitude: 103.902_26 },
      },
      journey: {
        stopId: '65009',
        searchDate: '2026-06-02',
        boardingAtMs: 1_780_359_600_000,
        arrivalAtMs: 1_780_361_400_000,
        rideMs: 1_500_000,
        services: [{ id: '116', name: '116', mode: 'BUS' }],
        isAtDestination: false,
      },
    },
  ],
}

describe('saved-result-store', () => {
  it('saves and reloads postal, station and checked-area snapshots', () => {
    const storage = createMemoryStorage()
    saveCompletedResult(storage, SAMPLE_SNAPSHOT)
    expect(loadCompletedResult(storage)).toEqual(SAMPLE_SNAPSHOT)

    const stationSnapshot: CompletedSearchSnapshot = {
      ...SAMPLE_SNAPSHOT,
      workplace: {
        kind: 'station',
        stationId: 'NS17',
        label: 'NS17 Bishan',
        point: { latitude: 1.351, longitude: 103.848 },
      },
    }
    saveCompletedResult(storage, stationSnapshot)
    expect(loadCompletedResult(storage)).toEqual(stationSnapshot)

    const areaSnapshot: CompletedSearchSnapshot = {
      ...SAMPLE_SNAPSHOT,
      checkedArea: {
        centre: { latitude: 1.403_69, longitude: 103.902_26 },
        proofStopId: '65009',
      },
    }
    saveCompletedResult(storage, areaSnapshot)
    expect(loadCompletedResult(storage)).toEqual(areaSnapshot)
  })

  it('returns null safely when storage is empty, invalid JSON, or invalid structure', () => {
    const storage = createMemoryStorage()
    expect(loadCompletedResult(storage)).toBeNull()

    storage.setItem('house-hunter:last-completed-result:v1', '{bad-json')
    expect(loadCompletedResult(storage)).toBeNull()

    const invalidShapes: unknown[] = [
      { version: 99 },
      { ...SAMPLE_SNAPSHOT, workplace: { kind: 'postal' } },
      { ...SAMPLE_SNAPSHOT, constraints: { searchDate: '2026-06-02' } },
      {
        ...SAMPLE_SNAPSHOT,
        checkedArea: {
          centre: { latitude: 1.403_69, longitude: 103.902_26 },
          proofStopId: 'unknown-stop',
        },
      },
      {
        ...SAMPLE_SNAPSHOT,
        matches: [{ stop: { id: '1' }, journey: { stopId: '1' } }],
      },
      {
        ...SAMPLE_SNAPSHOT,
        matches: [
          {
            stop: SAMPLE_SNAPSHOT.matches[0]?.stop,
            journey: {
              ...SAMPLE_SNAPSHOT.matches[0]?.journey,
              services: [{ id: '1', name: '1', mode: 'CAR' }],
            },
          },
        ],
      },
    ]

    for (const bad of invalidShapes) {
      storage.setItem(
        'house-hunter:last-completed-result:v1',
        JSON.stringify(bad),
      )
      expect(loadCompletedResult(storage)).toBeNull()
    }
  })
})
