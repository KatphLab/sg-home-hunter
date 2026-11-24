const SINGAPORE_OFFSET_MS = 8 * 3_600_000
const DAY_MS = 86_400_000
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/
const CLOCK_HHMM_PATTERN = /^(\d{2}):(\d{2})$/

const GAZETTED_HOLIDAYS: readonly string[] = [
  // 2025
  '2025-01-01',
  '2025-01-29',
  '2025-01-30',
  '2025-03-31',
  '2025-04-18',
  '2025-05-01',
  '2025-05-12',
  '2025-06-07',
  '2025-08-09',
  '2025-10-20',
  '2025-12-25',
  // 2026
  '2026-01-01',
  '2026-02-17',
  '2026-02-18',
  '2026-03-21',
  '2026-04-03',
  '2026-05-01',
  '2026-05-27',
  '2026-05-31',
  '2026-08-09',
  '2026-11-08',
  '2026-12-25',
  // 2027
  '2027-01-01',
  '2027-02-06',
  '2027-02-07',
  '2027-03-10',
  '2027-03-26',
  '2027-05-01',
  '2027-05-17',
  '2027-05-20',
  '2027-08-09',
  '2027-10-28',
  '2027-12-25',
  // 2028
  '2028-01-01',
  '2028-01-26',
  '2028-01-27',
  '2028-02-27',
  '2028-04-14',
  '2028-05-01',
  '2028-05-05',
  '2028-05-08',
  '2028-08-09',
  '2028-10-17',
  '2028-12-25',
]

const parseIsoDateParts = (
  isoDate: string,
): { readonly year: number; readonly month: number; readonly day: number } => {
  const match = ISO_DATE_PATTERN.exec(isoDate)
  if (!match) {
    throw new Error(`Invalid ISO date: ${isoDate}`)
  }
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const probe = new Date(Date.UTC(year, month - 1, day))
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() + 1 !== month ||
    probe.getUTCDate() !== day
  ) {
    throw new Error(`Non-existent calendar date: ${isoDate}`)
  }
  return { year, month, day }
}

const getUtcDayOfWeek = (isoDate: string): number => {
  const { year, month, day } = parseIsoDateParts(isoDate)
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay()
}

const addDaysIso = (isoDate: string, days: number): string => {
  const { year, month, day } = parseIsoDateParts(isoDate)
  const next = new Date(Date.UTC(year, month - 1, day) + days * DAY_MS)
  return next.toISOString().slice(0, 10)
}

const buildHolidaySet = (): ReadonlySet<string> => {
  const set = new Set<string>()
  for (const date of GAZETTED_HOLIDAYS) {
    set.add(date)
    if (getUtcDayOfWeek(date) === 0) {
      set.add(addDaysIso(date, 1))
    }
  }
  return set
}

const SINGAPORE_HOLIDAY_SET = buildHolidaySet()

export const getSingaporeDateFromInstant = (instantMs: number): string => {
  if (!Number.isFinite(instantMs)) {
    throw new Error('Instant must be a finite epoch millisecond timestamp')
  }
  return new Date(instantMs + SINGAPORE_OFFSET_MS).toISOString().slice(0, 10)
}

export const formatSingaporeTime = (instantMs: number): string => {
  if (!Number.isFinite(instantMs)) {
    throw new Error('Instant must be a finite epoch millisecond timestamp')
  }
  return new Date(instantMs + SINGAPORE_OFFSET_MS).toISOString().slice(11, 16)
}

export const parseSingaporeDateTimeMs = (
  isoDate: string,
  clockHHMM: string,
): number => {
  const { year, month, day } = parseIsoDateParts(isoDate)
  const match = CLOCK_HHMM_PATTERN.exec(clockHHMM)
  if (!match) {
    throw new Error(`Invalid clock time: ${clockHHMM}`)
  }
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) {
    throw new Error(`Clock time out of range: ${clockHHMM}`)
  }
  return (
    Date.UTC(year, month - 1, day, hour, minute, 0, 0) - SINGAPORE_OFFSET_MS
  )
}

export const isSingaporePublicHoliday = (isoDate: string): boolean => {
  parseIsoDateParts(isoDate)
  return SINGAPORE_HOLIDAY_SET.has(isoDate)
}

export const getDefaultSearchDate = (nowMs: number): string => {
  const todaySgt = getSingaporeDateFromInstant(nowMs)
  for (let offset = 1; offset <= 31; offset += 1) {
    const candidate = addDaysIso(todaySgt, offset)
    const dayOfWeek = getUtcDayOfWeek(candidate)
    if (
      dayOfWeek >= 1 &&
      dayOfWeek <= 5 &&
      !SINGAPORE_HOLIDAY_SET.has(candidate)
    ) {
      return candidate
    }
  }
  throw new Error('Could not find a working search date within 31 days')
}
