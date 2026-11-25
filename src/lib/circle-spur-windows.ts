import type { TransitSegment } from '@lib/transit-segment.js'

// Current outbound CC3 timetable (updated 15 July 2026):
// https://landtransportguru.net/esplanade-station/
// Weekdays towards CC32: 05:40–09:29 and 16:04–20:44.
// Do not reuse the CC1→HarbourFront windows that ended on 11 July 2026.
const ESPLANADE_PEAK_WINDOWS = [
  { firstMin: 340, lastMin: 569 },
  { firstMin: 964, lastMin: 1244 },
] as const

/** Shift the published station window along the modeled train journey. */
export const withCircleSpurWindows = (
  segments: readonly TransitSegment[],
): TransitSegment[] => {
  const ascending = segments[0]?.fromStopId === 'CC1'
  const anchorIndex = segments.findIndex((s) => s.fromStopId === 'CC3')
  let anchorMinMs = 0
  let anchorEstMs = 0
  for (const segment of segments) {
    if (segment.fromStopId === 'CC3') {
      break
    }
    anchorMinMs += segment.minRideMs
    anchorEstMs += segment.estRideMs
  }
  const journeyEstMs = segments.reduce((sum, s) => sum + s.estRideMs, 0)
  let elapsedMinMs = 0
  let elapsedEstMs = 0
  return segments.map((segment, index) => {
    // Reverse peak bounds are not published by this source. Use the known
    // weekday peak periods as an estimated CC32 departure envelope, widened
    // by one whole modeled journey in either direction, not an exact timetable.
    // Both directions retain an end-of-service tail for trains already underway;
    // min/estimated ride times bound the station offsets conservatively.
    const minOffsetMs =
      index >= anchorIndex
        ? elapsedMinMs - anchorMinMs
        : elapsedEstMs - anchorEstMs
    const estOffsetMs =
      index >= anchorIndex
        ? elapsedEstMs - anchorEstMs
        : elapsedMinMs - anchorMinMs
    const firstOffsetMs = ascending ? minOffsetMs : elapsedMinMs - journeyEstMs
    const lastOffsetMs = ascending ? estOffsetMs : elapsedEstMs + journeyEstMs
    elapsedMinMs += segment.minRideMs
    elapsedEstMs += segment.estRideMs
    return {
      ...segment,
      operatingWindows: {
        weekday: ESPLANADE_PEAK_WINDOWS.map((window) => ({
          firstMin: Math.max(330, window.firstMin + firstOffsetMs / 60_000),
          lastMin: window.lastMin + lastOffsetMs / 60_000,
        })),
      },
    }
  })
}
