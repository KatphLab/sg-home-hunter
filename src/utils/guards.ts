import type { TransitMode } from '@lib/commute-types.js'

const TRANSIT_MODES: ReadonlySet<string> = new Set([
  'BUS',
  'SUBWAY',
  'TRAM',
  'RAIL',
])

export const isTransitMode = (value: unknown): value is TransitMode =>
  typeof value === 'string' && TRANSIT_MODES.has(value)

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const isFiniteNonNegativeNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0

export const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0

export const parseJsonUnknown = (text: string): unknown => JSON.parse(text)

export const normalizeError = (
  error: unknown,
  fallbackMessage: string,
): Error => {
  if (error instanceof Error) {
    return error
  }
  if (typeof error === 'string' && error.trim().length > 0) {
    return new Error(error)
  }
  return new Error(fallbackMessage)
}
