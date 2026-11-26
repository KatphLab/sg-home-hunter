import type { Stop, StopInventory, StopKind } from '@lib/commute-types.js'

const POSTAL_CODE_PATTERN = /^[0-9]{6}$/
export const BUS_ID_PATTERN = /^[0-9]{5}$/
export const RAIL_ID_PATTERN = /^[A-Z]{1,3}(?:[0-9]{1,2}[A-Z]?)?$/
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const stationCodeCollator = new Intl.Collator('en', { numeric: true })

export const isValidSingaporeCoordinate = (lat: number, lon: number): boolean =>
  Number.isFinite(lat) &&
  Number.isFinite(lon) &&
  lat >= 1.0 &&
  lat <= 1.6 &&
  lon >= 103.4 &&
  lon <= 104.3

const parseStopRow = (line: string, lineNumber: number): Stop => {
  const fields = line.split('\t')
  if (fields.length !== 5) {
    throw new Error(`Malformed stop row on line ${String(lineNumber)}`)
  }
  const [id = '', kindRaw = '', name = '', latRaw = '', lonRaw = ''] = fields
  const kind: StopKind | null =
    kindRaw === 'bus' ? 'bus' : kindRaw === 'rail' ? 'rail' : null
  if (!kind || name.trim().length === 0) {
    throw new Error(`Invalid stop kind or name on line ${String(lineNumber)}`)
  }
  const validId =
    kind === 'bus' ? BUS_ID_PATTERN.test(id) : RAIL_ID_PATTERN.test(id)
  if (!validId) {
    throw new Error(`Invalid ${kind} stop ID on line ${String(lineNumber)}`)
  }
  const latitude = Number(latRaw)
  const longitude = Number(lonRaw)
  if (!isValidSingaporeCoordinate(latitude, longitude)) {
    throw new Error(`Invalid coordinates on line ${String(lineNumber)}`)
  }
  return {
    id,
    kind,
    name: name.trim(),
    point: { latitude, longitude },
  }
}

export const parseStopInventory = (rawTsv: string): StopInventory => {
  const lines = rawTsv
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  if (lines.length < 3) {
    throw new Error('Stop inventory TSV is missing required headers or rows')
  }

  const metaParts = (lines[0] ?? '').split('\t')
  const inventoryDate = metaParts[1] ?? ''
  if (
    metaParts[0] !== 'inventoryDate' ||
    !ISO_DATE_PATTERN.test(inventoryDate)
  ) {
    throw new Error('Stop inventory TSV missing valid inventoryDate header')
  }

  if (lines[1] !== 'id\tkind\tname\tlatitude\tlongitude') {
    throw new Error('Stop inventory TSV column header mismatch')
  }

  const seen = new Set<string>()
  const stops: Stop[] = []
  for (let index = 2; index < lines.length; index += 1) {
    const stop = parseStopRow(lines[index] ?? '', index + 1)
    const key = `${stop.kind}:${stop.id}`
    if (seen.has(key)) {
      throw new Error(`Duplicate stop entry ${key}`)
    }
    seen.add(key)
    stops.push(stop)
  }

  return { inventoryDate, stops }
}

export const validatePostalCode = (input: string): string | null => {
  const trimmed = input.trim()
  return POSTAL_CODE_PATTERN.test(trimmed) ? trimmed : null
}

export const findRailStationById = (
  inventory: StopInventory,
  stationId: string,
): Stop | null =>
  inventory.stops.find(
    (stop) => stop.kind === 'rail' && stop.id === stationId,
  ) ?? null

const isSubsequence = (query: string, text: string): boolean => {
  let from = 0
  for (const char of query) {
    const index = text.indexOf(char, from)
    if (index === -1) return false
    from = index + 1
  }
  return true
}

const isOneEditAway = (query: string, text: string): boolean => {
  if (Math.abs(query.length - text.length) > 1) return false
  const [shorter, longer] =
    query.length <= text.length ? [query, text] : [text, query]
  let i = 0
  while (i < shorter.length && shorter[i] === longer[i]) i += 1
  if (shorter.length !== longer.length) {
    return shorter.slice(i) === longer.slice(i + 1)
  }
  return (
    shorter.slice(i + 1) === longer.slice(i + 1) ||
    (shorter[i] === longer[i + 1] &&
      shorter[i + 1] === longer[i] &&
      shorter.slice(i + 2) === longer.slice(i + 2))
  )
}

const stationMatchRank = (query: string, text: string): number => {
  if (text === query) return 0
  if (text.startsWith(query)) return 1
  if (text.includes(query)) return 2
  if (query.length >= 3 && isOneEditAway(query, text)) return 3
  if (query.length >= 3 && isSubsequence(query, text)) return 4
  return Number.POSITIVE_INFINITY
}

export const filterRailStations = (
  inventory: StopInventory,
  query: string,
): readonly Stop[] => {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return []
  const matches: { stop: Stop; rank: number }[] = []
  for (const stop of inventory.stops) {
    if (stop.kind !== 'rail') continue
    const rank = Math.min(
      stationMatchRank(normalized, stop.id.toLowerCase()),
      stationMatchRank(normalized, stop.name.toLowerCase()),
    )
    if (rank !== Number.POSITIVE_INFINITY) matches.push({ stop, rank })
  }
  return matches
    .sort(
      (a, b) =>
        a.rank - b.rank || stationCodeCollator.compare(a.stop.id, b.stop.id),
    )
    .map(({ stop }) => stop)
}
