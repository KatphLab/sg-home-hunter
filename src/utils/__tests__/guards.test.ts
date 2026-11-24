import { describe, expect, it } from 'bun:test'
import {
  isFiniteNonNegativeNumber,
  isNonEmptyString,
  isRecord,
  normalizeError,
  parseJsonUnknown,
} from '@utils/guards.js'

describe('guards', () => {
  it('validates records, strings, finite numbers, and parses JSON', () => {
    expect(isRecord({ a: 1 })).toBe(true)
    expect(isRecord([])).toBe(false)
    expect(isRecord(null)).toBe(false)
    expect(isFiniteNonNegativeNumber(0)).toBe(true)
    expect(isFiniteNonNegativeNumber(-1)).toBe(false)
    expect(isNonEmptyString('ok')).toBe(true)
    expect(isNonEmptyString('   ')).toBe(false)
    expect(parseJsonUnknown('{"x":1}')).toEqual({ x: 1 })
  })

  it('normalizes Error, non-empty string, and unknown thrown values', () => {
    const err = new Error('boom')
    expect(normalizeError(err, 'fallback')).toBe(err)
    expect(normalizeError('string error', 'fallback').message).toBe(
      'string error',
    )
    expect(normalizeError('   ', 'fallback').message).toBe('fallback')
    expect(normalizeError({ code: 500 }, 'fallback').message).toBe('fallback')
  })
})
