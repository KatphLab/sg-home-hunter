import { describe, expect, it } from 'bun:test'
import {
  formatSingaporeTime,
  getDefaultSearchDate,
  getSingaporeDateFromInstant,
  isSingaporePublicHoliday,
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
    // Normal Tuesday -> Wednesday
    expect(getDefaultSearchDate(Date.parse('2026-06-02T09:00:00+08:00'))).toBe(
      '2026-06-03',
    )

    // Friday before Vesak Day observed Monday (2026-06-01) -> Tuesday 2026-06-02
    expect(getDefaultSearchDate(Date.parse('2026-05-29T09:00:00+08:00'))).toBe(
      '2026-06-02',
    )

    // Friday before National Day observed Monday (2026-08-10) -> Tuesday 2026-08-11
    expect(getDefaultSearchDate(Date.parse('2026-08-07T18:00:00+08:00'))).toBe(
      '2026-08-11',
    )

    // Friday before Deepavali observed Monday (2026-11-09) -> Tuesday 2026-11-10
    expect(getDefaultSearchDate(Date.parse('2026-11-06T08:00:00+08:00'))).toBe(
      '2026-11-10',
    )

    // Friday before CNY observed Monday (2027-02-08) -> Tuesday 2027-02-09
    expect(getDefaultSearchDate(Date.parse('2027-02-05T10:00:00+08:00'))).toBe(
      '2027-02-09',
    )

    // Thursday 2026-12-31 before Friday 2027-01-01 New Year's Day -> Monday 2027-01-04
    expect(getDefaultSearchDate(Date.parse('2026-12-31T12:00:00+08:00'))).toBe(
      '2027-01-04',
    )

    // Friday before Saturday Hari Raya Puasa (2026-03-21) -> Monday 2026-03-23 (no observed Mon)
    expect(getDefaultSearchDate(Date.parse('2026-03-20T12:00:00+08:00'))).toBe(
      '2026-03-23',
    )
  })
})
