const SINGAPORE_OFFSET_MS = 8 * 3_600_000
const DAY_MS = 86_400_000
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/
const CLOCK_HHMM_PATTERN = /^(\d{2}):(\d{2})$/

const GAZETTED_HOLIDAYS_BY_YEAR: Readonly<Record<number, readonly string[]>> = {
  2025: [
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
  ],
  2026: [
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
  ],
  2027: [
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
  ],
  2028: [
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
  ],
}

const DEEPAVALI_BY_YEAR: Readonly<Record<number, string>> = {
  2029: '2029-11-05',
  2030: '2030-10-26',
  2031: '2031-11-14',
  2032: '2032-11-02',
  2033: '2033-10-22',
  2034: '2034-11-10',
  2035: '2035-10-30',
}

const CHINESE_CALENDAR_FORMAT = new Intl.DateTimeFormat('en-US-u-ca-chinese', {
  month: 'numeric',
  day: 'numeric',
  timeZone: 'UTC',
})

const ISLAMIC_CALENDAR_FORMAT = new Intl.DateTimeFormat(
  'en-US-u-ca-islamic-umalqura',
  {
    month: 'numeric',
    day: 'numeric',
    timeZone: 'UTC',
  },
)

const YEAR_HOLIDAY_CACHE = new Map<number, ReadonlySet<string>>()

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

const computeGoodFridayIso = (year: number): string => {
  const a = year % 19
  const b = Math.floor(year / 100)
  const c = year % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31)
  const day = ((h + l - 7 * m + 114) % 31) + 1
  const easterMs = Date.UTC(year, month - 1, day)
  return new Date(easterMs - 2 * DAY_MS).toISOString().slice(0, 10)
}

const readCalendarMonthDay = (
  formatter: Intl.DateTimeFormat,
  date: Date,
): { readonly month: string; readonly day: string } => {
  let month = ''
  let day = ''
  for (const part of formatter.formatToParts(date)) {
    if (part.type === 'month') {
      month = part.value
    } else if (part.type === 'day') {
      day = part.value
    }
  }
  return { month, day }
}

const collectLunarHolidaysForDay = (
  dt: Date,
  iso: string,
  includeDerivedDeepavali: boolean,
  holidays: string[],
): void => {
  const cn = readCalendarMonthDay(CHINESE_CALENDAR_FORMAT, dt)
  if (cn.month === '1' && (cn.day === '1' || cn.day === '2')) {
    holidays.push(iso)
  } else if (cn.month === '4' && cn.day === '15') {
    holidays.push(iso)
  } else if (includeDerivedDeepavali && cn.month === '10' && cn.day === '1') {
    holidays.push(addDaysIso(iso, -1))
  }

  const isl = readCalendarMonthDay(ISLAMIC_CALENDAR_FORMAT, dt)
  if (
    (isl.month === '10' && isl.day === '1') ||
    (isl.month === '12' && isl.day === '10')
  ) {
    holidays.push(iso)
  }
}

const deriveYearBaseHolidays = (year: number): readonly string[] => {
  const holidays: string[] = [
    `${String(year)}-01-01`,
    computeGoodFridayIso(year),
    `${String(year)}-05-01`,
    `${String(year)}-08-09`,
    `${String(year)}-12-25`,
  ]
  const knownDeepavali = DEEPAVALI_BY_YEAR[year]
  if (knownDeepavali !== undefined) {
    holidays.push(knownDeepavali)
  }

  let cursorMs = Date.UTC(year, 0, 1)
  const endMs = Date.UTC(year + 1, 0, 1)
  while (cursorMs < endMs) {
    const dt = new Date(cursorMs)
    const iso = dt.toISOString().slice(0, 10)
    collectLunarHolidaysForDay(dt, iso, knownDeepavali === undefined, holidays)
    cursorMs += DAY_MS
  }

  return holidays
}

const expandWithObservedHolidays = (
  baseDates: readonly string[],
): ReadonlySet<string> => {
  const sorted = [...new Set(baseDates)].sort((a, b) => a.localeCompare(b))
  const set = new Set<string>(sorted)
  for (const date of sorted) {
    if (getUtcDayOfWeek(date) !== 0) {
      continue
    }
    let observed = addDaysIso(date, 1)
    while (set.has(observed)) {
      observed = addDaysIso(observed, 1)
    }
    set.add(observed)
  }
  return set
}

const getHolidaysForYear = (year: number): ReadonlySet<string> => {
  const cached = YEAR_HOLIDAY_CACHE.get(year)
  if (cached) {
    return cached
  }
  const gazetted = GAZETTED_HOLIDAYS_BY_YEAR[year]
  const base = gazetted ?? deriveYearBaseHolidays(year)
  const expanded = expandWithObservedHolidays(base)
  YEAR_HOLIDAY_CACHE.set(year, expanded)
  return expanded
}

export const parseClockMinutes = (clockHHMM: string): number => {
  const match = CLOCK_HHMM_PATTERN.exec(clockHHMM)
  if (!match) {
    throw new Error(`Invalid clock time: ${clockHHMM}`)
  }
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) {
    throw new Error(`Clock time out of range: ${clockHHMM}`)
  }
  return hour * 60 + minute
}

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
  const totalMinutes = parseClockMinutes(clockHHMM)
  const hour = Math.floor(totalMinutes / 60)
  const minute = totalMinutes % 60
  return (
    Date.UTC(year, month - 1, day, hour, minute, 0, 0) - SINGAPORE_OFFSET_MS
  )
}

export const isSingaporePublicHoliday = (isoDate: string): boolean => {
  const { year } = parseIsoDateParts(isoDate)
  return (
    getHolidaysForYear(year).has(isoDate) ||
    getHolidaysForYear(year - 1).has(isoDate)
  )
}

export const getDefaultSearchDate = (nowMs: number): string => {
  const todaySgt = getSingaporeDateFromInstant(nowMs)
  for (let offset = 1; offset <= 31; offset += 1) {
    const candidate = addDaysIso(todaySgt, offset)
    const dayOfWeek = getUtcDayOfWeek(candidate)
    if (
      dayOfWeek >= 1 &&
      dayOfWeek <= 5 &&
      !isSingaporePublicHoliday(candidate)
    ) {
      return candidate
    }
  }
  throw new Error('Could not find a working search date within 31 days')
}
