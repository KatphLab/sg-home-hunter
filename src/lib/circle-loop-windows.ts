import type { DayType, OperatingWindow } from '@lib/transit-segment.js'

// Existing modeled rail envelope, shared with the rail builder. Only the loop
// first-service times below are published station/day/direction-specific values;
// retain the existing closing bound rather than truncate genuine short turns.
export const RAIL_DEFAULT_WINDOW: OperatingWindow = {
  firstMin: 330,
  lastMin: 1435,
}

// Land Transport Guru station First / Last Train Timings, retrieved 2026-11-26.
// Minutes after midnight: anticlockwise weekday/Saturday, anticlockwise
// Sunday/holiday, clockwise weekday/Saturday, clockwise Sunday/holiday.
// Use the Loop first trains, not the separate Dhoby Ghaut spur services.
const FIRST_SERVICES: Readonly<
  Record<string, readonly [number, number, number, number]>
> = {
  CC4: [362, 388, 351, 378], // https://landtransportguru.net/promenade-station/
  CC5: [364, 390, 348, 375], // https://landtransportguru.net/nicoll-highway-station/
  CC6: [367, 393, 346, 373], // https://landtransportguru.net/stadium-station/
  CC7: [329, 363, 344, 371], // https://landtransportguru.net/mountbatten-station/
  CC8: [331, 364, 343, 369], // https://landtransportguru.net/dakota-station/
  CC9: [333, 367, 340, 367], // https://landtransportguru.net/paya-lebar-station/
  CC10: [336, 370, 338, 364], // https://landtransportguru.net/macpherson-station/
  CC11: [338, 372, 335, 362], // https://landtransportguru.net/tai-seng-station/
  CC12: [316, 338, 347, 374], // https://landtransportguru.net/bartley-station/
  CC13: [318, 341, 345, 371], // https://landtransportguru.net/serangoon-station/
  CC14: [320, 343, 342, 369], // https://landtransportguru.net/lorong-chuan-station/
  CC15: [323, 346, 340, 367], // https://landtransportguru.net/bishan-station/
  CC16: [326, 349, 336, 364], // https://landtransportguru.net/marymount-station/
  CC17: [329, 351, 334, 362], // https://landtransportguru.net/caldecott-station/
  CC19: [334, 356, 346, 368], // https://landtransportguru.net/botanic-gardens-station/
  CC20: [336, 358, 343, 365], // https://landtransportguru.net/farrer-road-station/
  CC21: [338, 361, 341, 363], // https://landtransportguru.net/holland-village-station/
  CC22: [340, 363, 339, 361], // https://landtransportguru.net/buona-vista-station/
  CC23: [343, 365, 337, 358], // https://landtransportguru.net/one-north-station/
  CC24: [335, 360, 335, 357], // https://landtransportguru.net/kent-ridge-station/
  CC25: [338, 362, 332, 354], // https://landtransportguru.net/haw-par-villa-station/
  CC26: [340, 364, 330, 352], // https://landtransportguru.net/pasir-panjang-station/
  CC27: [342, 367, 334, 355], // https://landtransportguru.net/labrador-park-station/
  CC28: [344, 368, 332, 353], // https://landtransportguru.net/telok-blangah-station/
  CC29: [347, 372, 330, 351], // https://landtransportguru.net/harbourfront-station/
  CC30: [349, 374, 365, 390], // https://landtransportguru.net/keppel-station/
  CC31: [351, 376, 363, 388], // https://landtransportguru.net/cantonment-station/
  CC32: [354, 379, 361, 385], // https://landtransportguru.net/prince-edward-road-station/
  CC33: [358, 383, 359, 383], // https://landtransportguru.net/marina-bay-station/
  CC34: [360, 386, 354, 380], // https://landtransportguru.net/bayfront-station/
}

/** Ascending follows the anticlockwise loop CC4 → CC5 → … → CC34 → CC4. */
export const getCircleLoopWindows = (
  fromStopId: string,
  ascending: boolean,
): Readonly<Partial<Record<DayType, OperatingWindow>>> => {
  const firstServices = FIRST_SERVICES[fromStopId]
  if (!firstServices) {
    return {}
  }
  const weekday = {
    firstMin: firstServices[ascending ? 0 : 2],
    lastMin: RAIL_DEFAULT_WINDOW.lastMin,
  }
  return {
    weekday,
    saturday: weekday,
    sunday_holiday: {
      firstMin: firstServices[ascending ? 1 : 3],
      lastMin: RAIL_DEFAULT_WINDOW.lastMin,
    },
  }
}
