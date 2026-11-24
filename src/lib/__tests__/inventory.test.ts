import { describe, expect, it } from 'bun:test'
import {
  filterRailStations,
  findRailStationById,
  parseStopInventory,
  validatePostalCode,
} from '@lib/inventory.js'

const SAMPLE_TSV = [
  'inventoryDate\t2026-11-24',
  'id\tkind\tname\tlatitude\tlongitude',
  '01012\tbus\tHotel Grand Pacific\t1.296850\t103.852540',
  '65009\tbus\tPunggol Temp Int\t1.403690\t103.902260',
  'CC15\trail\tBishan\t1.351455\t103.848263',
  'NS17\trail\tBishan\t1.351455\t103.848263',
].join('\n')

describe('inventory', () => {
  it('parses dated TSV inventory preserving leading zeros', () => {
    const inv = parseStopInventory(SAMPLE_TSV)
    expect(inv.inventoryDate).toBe('2026-11-24')
    expect(inv.stops).toHaveLength(4)
    expect(inv.stops[0]?.id).toBe('01012')
    expect(findRailStationById(inv, 'NS17')?.name).toBe('Bishan')
    expect(findRailStationById(inv, 'ns17')).toBeNull()
  })

  it('filters rail stations by exact ID or name', () => {
    const inv = parseStopInventory(SAMPLE_TSV)
    expect(filterRailStations(inv, 'bishan').map((s) => s.id)).toEqual([
      'CC15',
      'NS17',
    ])
    expect(filterRailStations(inv, 'ns17').map((s) => s.id)).toEqual(['NS17'])
  })

  it('rejects duplicate (kind, id) pairs and malformed rows', () => {
    const dup = `${SAMPLE_TSV}\n01012\tbus\tDuplicate\t1.3\t103.8`
    expect(() => parseStopInventory(dup)).toThrow()
    expect(() => parseStopInventory('bad header')).toThrow()
  })

  it('validates 6-digit Singapore postal codes while preserving leading zeros', () => {
    expect(validatePostalCode('018989')).toBe('018989')
    expect(validatePostalCode(' 018989 ')).toBe('018989')
    expect(validatePostalCode('18989')).toBeNull()
    expect(validatePostalCode('01898A')).toBeNull()
  })
})
