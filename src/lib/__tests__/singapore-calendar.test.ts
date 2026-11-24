import { describe, expect, it } from 'bun:test'
import {
  formatSingaporeTime,
  getDefaultSearchDate,
  getSingaporeDateFromInstant,
  isSingaporePublicHoliday,
  parseClockMinutes,
  parseSingaporeDateTimeMs,
} from '@lib/singapore-calendar.js'

describe('singapore-calendar', () => {
  it('converts UTC instants across Singapore midnight boundaries (UTC+8)', () => {
    const beforeMidnightSgt = Date.parse('2026-05-29T15:59:59.000Z')
    const atMidnightSgt = Date.parse('2026-05-29T16:00:00.000Z')

    expect(getSingaporeDateFromInstant(beforeMidnightSgt)).toBe('2026-05-29')
    expect(getSingaporeDateFromInstant(atMidnightSgt)).toBe('2026-05-30')
    expect(formatSingaporeTime(atMidnightSgt)).toBe('00:00')
  })

  it('parses and formats Singapore date-time strings deterministically', () => {
    const ms = parseSingaporeDateTimeMs('2026-06-02', '09:00')
    expect(ms).toBe(Date.parse('2026-06-02T01:00:00.000Z'))
    expect(formatSingaporeTime(ms)).toBe('09:00')
    expect(parseClockMinutes('09:30')).toBe(570)
    expect(() => parseSingaporeDateTimeMs('2026-06-31', '09:00')).toThrow()
    expect(() => parseSingaporeDateTimeMs('2026-06-02', '25:00')).toThrow()
  })

  it('recognizes gazetted holidays and Sunday-to-Monday observed holidays', () => {
    // 2026 Vesak Day falls on Sunday 2026-05-31 -> Monday 2026-06-01 is observed
    expect(isSingaporePublicHoliday('2026-05-31')).toBe(true)
    expect(isSingaporePublicHoliday('2026-06-01')).toBe(true)
    expect(isSingaporePublicHoliday('2026-06-02')).toBe(false)

    // 2026 Hari Raya Puasa falls on Saturday 2026-03-21 -> Monday 2026-03-23 is NOT observed
    expect(isSingaporePublicHoliday('2026-03-21')).toBe(true)
    expect(isSingaporePublicHoliday('2026-03-23')).toBe(false)

    // 2027 CNY 2nd day falls on Sunday 2027-02-07 -> Monday 2027-02-08 is observed
    expect(isSingaporePublicHoliday('2027-02-07')).toBe(true)
    expect(isSingaporePublicHoliday('2027-02-08')).toBe(true)
  })

  it('selects first non-holiday Monday-Friday strictly after today in Singapore', () => {
    expect(getDefaultSearchDate(Date.parse('2026-06-02T09:00:00+08:00'))).toBe(
      '2026-06-03',
    )
    expect(getDefaultSearchDate(Date.parse('2026-05-29T09:00:00+08:00'))).toBe(
      '2026-06-02',
    )
    expect(getDefaultSearchDate(Date.parse('2026-08-07T18:00:00+08:00'))).toBe(
      '2026-08-11',
    )
    expect(getDefaultSearchDate(Date.parse('2026-11-06T08:00:00+08:00'))).toBe(
      '2026-11-10',
    )
    expect(getDefaultSearchDate(Date.parse('2027-02-05T10:00:00+08:00'))).toBe(
      '2027-02-09',
    )
    expect(getDefaultSearchDate(Date.parse('2026-12-31T12:00:00+08:00'))).toBe(
      '2027-01-04',
    )
    expect(getDefaultSearchDate(Date.parse('2026-03-20T12:00:00+08:00'))).toBe(
      '2026-03-23',
    )
  })

  it('derives Singapore public and observed holidays for 2029 and beyond', () => {
    // 2029 Good Friday (2029-03-30)
    expect(isSingaporePublicHoliday('2029-03-30')).toBe(true)
    expect(getDefaultSearchDate(Date.parse('2029-03-29T09:00:00+08:00'))).toBe(
      '2029-04-02',
    )

    // 2029 Sunday Vesak Day (2029-05-27) -> observed Monday 2029-05-28
    expect(isSingaporePublicHoliday('2029-05-27')).toBe(true)
    expect(isSingaporePublicHoliday('2029-05-28')).toBe(true)
    expect(getDefaultSearchDate(Date.parse('2029-05-25T09:00:00+08:00'))).toBe(
      '2029-05-29',
    )

    // 2029 Deepavali (2029-11-05 Monday)
    expect(isSingaporePublicHoliday('2029-11-05')).toBe(true)
    expect(getDefaultSearchDate(Date.parse('2029-11-02T09:00:00+08:00'))).toBe(
      '2029-11-06',
    )

    // 2030 CNY Day 1 Sun 2030-02-03 & Day 2 Mon 2030-02-04 -> observed Tue 2030-02-05
    expect(isSingaporePublicHoliday('2030-02-03')).toBe(true)
    expect(isSingaporePublicHoliday('2030-02-04')).toBe(true)
    expect(isSingaporePublicHoliday('2030-02-05')).toBe(true)
    expect(getDefaultSearchDate(Date.parse('2030-02-01T09:00:00+08:00'))).toBe(
      '2030-02-06',
    )

    // Beyond 2035 fallback works cleanly without throwing
    expect(isSingaporePublicHoliday('2036-01-01')).toBe(true)
    expect(isSingaporePublicHoliday('2036-08-09')).toBe(true)
  })
})
