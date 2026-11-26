export type DayType = 'weekday' | 'saturday' | 'sunday_holiday'

export interface OperatingWindow {
  readonly firstMin: number
  readonly lastMin: number
}

export type DayOperatingWindows = OperatingWindow | readonly OperatingWindow[]

export interface TransitSegment {
  readonly fromStopId: string
  readonly toStopId: string
  readonly minRideMs: number
  readonly estRideMs: number
  readonly operatingWindows?: Readonly<
    Partial<Record<DayType, DayOperatingWindows>>
  >
}
