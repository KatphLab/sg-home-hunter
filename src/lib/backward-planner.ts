import { isDestinationStationMatch } from '@lib/commute-rules.js'
import type {
  SearchConstraints,
  Stop,
  StopInventory,
  Workplace,
} from '@lib/commute-types.js'
import {
  formatSingaporeTime,
  getSingaporeDateFromInstant,
  parseSingaporeDateTimeMs,
} from '@lib/singapore-calendar.js'
import {
  getServiceDayType,
  haversineDistanceMeters,
  type TransferLink,
  type TransitNetworkIndex,
  type TransitPattern,
} from '@lib/transit-network.js'
import type {
  DayOperatingWindows,
  DayType,
  OperatingWindow,
  TransitSegment,
} from '@lib/transit-segment.js'

const ARRIVAL_WINDOW_EARLY_MS = 900_000
const DEFAULT_MAX_FINAL_WALK_M = 1200
const DEFAULT_MAX_TRANSFERS = 2
const DEFAULT_MAX_PROBES_PER_STOP = 4
const MIN_DEPARTURE_LOOKBACK_MS = 120 * 60_000
const SAME_STOP_MIN_WAIT_MS = 30_000
const SAME_STOP_EST_WAIT_MS = 180_000
const PRIMARY_FORWARD_BIAS_MS = 2 * 60_000
const BRACKET_OFFSET_MS = 6 * 60_000
const INTERCHANGE_MIN_EST_WALK_MS = 240_000
const INTERCHANGE_MIN_MAX_WALK_MS = 360_000
const DAY_MINUTES_MS = 1440 * 60_000

export interface BackwardLead {
  readonly stop: Stop
  readonly candidateDepartures: readonly string[]
  readonly minRideMs: number
  readonly estRideMs: number
  readonly transfers: number
}

export interface BackwardPlanResult {
  readonly leads: readonly BackwardLead[]
  readonly coveredStopCount: number
  readonly uncoveredStopIds: readonly string[]
  readonly prunedStopCount: number
}

export interface PlanBackwardLeadsOptions {
  readonly inventory: StopInventory
  readonly networkIndex: TransitNetworkIndex
  readonly workplace: Workplace
  readonly constraints: SearchConstraints
  readonly maxFinalWalkMeters?: number
  readonly maxTransfers?: number
  readonly maxProbesPerStop?: number
}

interface BackwardLabel {
  readonly stopId: string
  readonly minRideMs: number
  readonly estRideMs: number
  readonly earliestClockMs: number
  readonly latestClockMs: number
  readonly estClockMs: number
  readonly transfers: number
}

interface PlannerContext {
  readonly searchDate: string
  readonly dayType: DayType
  readonly prevDayType: DayType
  readonly dayStartMs: number
  readonly dayEndMs: number
  readonly deadlineMs: number
  readonly rideCapMs: number
  readonly minDepartureMs: number
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))

const MINUTE_END_OFFSET_MS = 59_999

type StopFrontier = Map<string, BackwardLabel[]>

const isWithinSearchDay = (ms: number, ctx: PlannerContext): boolean =>
  ms >= ctx.dayStartMs && ms < ctx.dayEndMs

const dominatesLabel = (
  existing: BackwardLabel,
  candidate: BackwardLabel,
  ignoreEarliest: boolean,
): boolean =>
  existing.transfers <= candidate.transfers &&
  existing.minRideMs <= candidate.minRideMs &&
  existing.estRideMs <= candidate.estRideMs &&
  existing.latestClockMs >= candidate.latestClockMs &&
  (ignoreEarliest || existing.earliestClockMs <= candidate.earliestClockMs)

const findDominanceInsertPoint = (
  list: readonly BackwardLabel[],
  label: BackwardLabel,
  ignoreEarliest: boolean,
): { readonly insertPos: number; readonly startEvict: number } | null => {
  let i = 0
  let firstEq = -1
  while (i < list.length) {
    const ex = list[i]
    if (!ex || ex.minRideMs > label.minRideMs) {
      break
    }
    if (firstEq === -1 && ex.minRideMs === label.minRideMs) {
      firstEq = i
    }
    if (dominatesLabel(ex, label, ignoreEarliest)) {
      return null
    }
    i += 1
  }
  return { insertPos: i, startEvict: firstEq !== -1 ? firstEq : i }
}

const insertSortedLabel = (
  list: BackwardLabel[],
  label: BackwardLabel,
  ignoreEarliest: boolean,
): BackwardLabel | null => {
  const point = findDominanceInsertPoint(list, label, ignoreEarliest)
  if (!point) {
    return null
  }
  let { insertPos } = point
  let writeIdx = point.startEvict
  for (let j = point.startEvict; j < list.length; j += 1) {
    const ex = list[j]
    if (!ex) {
      continue
    }
    if (dominatesLabel(label, ex, ignoreEarliest)) {
      if (j < point.insertPos) {
        insertPos -= 1
      }
      continue
    }
    list[writeIdx] = ex
    writeIdx += 1
  }
  list.length = writeIdx
  list.push(label)
  for (let k = writeIdx; k > insertPos; k -= 1) {
    const prev = list[k - 1]
    if (prev) {
      list[k] = prev
    }
  }
  list[insertPos] = label
  return label
}

const pushMonotonicLabel = (
  out: BackwardLabel[],
  label: BackwardLabel,
): void => {
  for (let i = out.length - 1; i >= 0; i -= 1) {
    const ex = out[i]
    if (ex && dominatesLabel(ex, label, false)) {
      return
    }
  }
  let tailStart = out.length
  while (tailStart > 0 && out[tailStart - 1]?.minRideMs === label.minRideMs) {
    tailStart -= 1
  }
  let writeIdx = tailStart
  for (let j = tailStart; j < out.length; j += 1) {
    const ex = out[j]
    if (ex && !dominatesLabel(label, ex, false)) {
      out[writeIdx] = ex
      writeIdx += 1
    }
  }
  out.length = writeIdx
  out.push(label)
}

const appendSortedTail = (
  out: BackwardLabel[],
  source: readonly BackwardLabel[],
  startIdx: number,
  maxMinRideMs: number,
): void => {
  for (let i = startIdx; i < source.length; i += 1) {
    const item = source[i]
    if (!item || item.minRideMs > maxMinRideMs) {
      break
    }
    pushMonotonicLabel(out, item)
  }
}

const mergeSortedBags = (
  bag: readonly BackwardLabel[],
  entering: readonly BackwardLabel[],
  maxMinRideMs: number,
): BackwardLabel[] => {
  const out: BackwardLabel[] = []
  let ia = 0
  let ib = 0
  while (ia < bag.length && ib < entering.length) {
    const a = bag[ia]
    const b = entering[ib]
    if (!a || !b || a.minRideMs > maxMinRideMs || b.minRideMs > maxMinRideMs) {
      break
    }
    if (a.minRideMs <= b.minRideMs) {
      pushMonotonicLabel(out, a)
      ia += 1
    } else {
      pushMonotonicLabel(out, b)
      ib += 1
    }
  }
  appendSortedTail(out, bag, ia, maxMinRideMs)
  appendSortedTail(out, entering, ib, maxMinRideMs)
  return out
}

const insertFrontierLabel = (
  frontier: StopFrontier,
  label: BackwardLabel,
  ignoreEarliest = false,
): BackwardLabel | null => {
  const list = frontier.get(label.stopId)
  if (!list) {
    frontier.set(label.stopId, [label])
    return label
  }
  return insertSortedLabel(list, label, ignoreEarliest)
}

const computeFinalWalkBounds = (
  stop: Stop,
  workplace: Workplace,
  distM: number,
): {
  readonly minWalkMs: number
  readonly estWalkMs: number
  readonly maxWalkMs: number
} => {
  const minWalkMs = distM < 30 ? 0 : Math.round((distM / 1.5) * 1000)
  const rawEstWalkMs =
    distM < 30 ? 0 : Math.round(((distM * 1.35) / 1.25) * 1000)
  const rawMaxWalkMs =
    distM < 30 ? 0 : Math.round(((distM * 1.45) / 0.9) * 1000)
  const isOtherInterchange =
    workplace.kind === 'station' &&
    stop.id !== workplace.stationId &&
    distM < 100
  return {
    minWalkMs,
    estWalkMs: isOtherInterchange
      ? Math.max(INTERCHANGE_MIN_EST_WALK_MS, rawEstWalkMs)
      : rawEstWalkMs,
    maxWalkMs: isOtherInterchange
      ? Math.max(INTERCHANGE_MIN_MAX_WALK_MS, rawMaxWalkMs)
      : rawMaxWalkMs,
  }
}

const createSeedLabel = (
  stop: Stop,
  workplace: Workplace,
  ctx: PlannerContext,
  maxFinalWalkMeters: number,
): BackwardLabel | null => {
  const distM = haversineDistanceMeters(stop.point, workplace.point)
  if (distM > maxFinalWalkMeters) {
    return null
  }
  const { minWalkMs, estWalkMs, maxWalkMs } = computeFinalWalkBounds(
    stop,
    workplace,
    distM,
  )
  const latestClockMs = ctx.deadlineMs - minWalkMs
  const windowStartMs = ctx.deadlineMs - ARRIVAL_WINDOW_EARLY_MS
  const earliestClockMs = Math.max(
    ctx.minDepartureMs,
    windowStartMs - maxWalkMs,
  )
  if (latestClockMs < ctx.dayStartMs || latestClockMs < earliestClockMs) {
    return null
  }
  const targetArrivalMs = ctx.deadlineMs - ARRIVAL_WINDOW_EARLY_MS / 2
  return {
    stopId: stop.id,
    minRideMs: 0,
    estRideMs: 0,
    earliestClockMs,
    latestClockMs,
    estClockMs: clamp(
      targetArrivalMs - estWalkMs,
      earliestClockMs,
      latestClockMs,
    ),
    transfers: 0,
  }
}

const seedFinalWalkLabels = (
  inventory: StopInventory,
  workplace: Workplace,
  ctx: PlannerContext,
  maxFinalWalkMeters: number,
): StopFrontier => {
  const seeds: StopFrontier = new Map()
  for (const stop of inventory.stops) {
    const label = createSeedLabel(stop, workplace, ctx, maxFinalWalkMeters)
    if (label) {
      insertFrontierLabel(seeds, label)
    }
  }
  return seeds
}

interface OperatingIntervalMs {
  readonly startMs: number
  readonly endMs: number
}

const normalizeDayWindows = (
  raw: DayOperatingWindows | undefined,
): readonly OperatingWindow[] => {
  if (raw === undefined) {
    return []
  }
  return 'firstMin' in raw ? [raw] : raw
}

const appendServiceDayIntervals = (
  intervals: OperatingIntervalMs[],
  windows: DayOperatingWindows | undefined,
  fromPreviousDay: boolean,
  ctx: PlannerContext,
): void => {
  for (const op of normalizeDayWindows(windows)) {
    const eligible = fromPreviousDay ? op.lastMin >= 1440 : op.firstMin < 1440
    if (!eligible) {
      continue
    }
    const dayShiftMin = fromPreviousDay ? -1440 : 0
    const startMs = Math.max(
      ctx.dayStartMs,
      ctx.dayStartMs + (op.firstMin + dayShiftMin) * 60_000,
    )
    const endMs = Math.min(
      ctx.dayEndMs - 1,
      ctx.dayStartMs +
        (op.lastMin + dayShiftMin) * 60_000 +
        MINUTE_END_OFFSET_MS,
    )
    if (endMs >= startMs) {
      intervals.push({ startMs, endMs })
    }
  }
}

const getOperatingIntervalsForDate = (
  seg: TransitSegment,
  ctx: PlannerContext,
): readonly OperatingIntervalMs[] => {
  if (seg.operatingWindows === undefined) {
    return [{ startMs: ctx.dayStartMs, endMs: ctx.dayEndMs - 1 }]
  }
  const intervals: OperatingIntervalMs[] = []
  appendServiceDayIntervals(
    intervals,
    seg.operatingWindows[ctx.prevDayType],
    true,
    ctx,
  )
  appendServiceDayIntervals(
    intervals,
    seg.operatingWindows[ctx.dayType],
    false,
    ctx,
  )
  return intervals
}

const appendSteppedBagLabel = (
  nextBag: BackwardLabel[],
  stepped: BackwardLabel,
  singleInterval: boolean,
): void => {
  if (singleInterval) {
    pushMonotonicLabel(nextBag, stepped)
  } else {
    insertSortedLabel(nextBag, stepped, false)
  }
}

const stepLabelAcrossSegment = (
  label: BackwardLabel,
  seg: TransitSegment,
  round: number,
  intervals: readonly OperatingIntervalMs[],
  ctx: PlannerContext,
  nextBag: BackwardLabel[] | null,
  tracker: FrontierTracker,
): void => {
  const nextMinRide = label.minRideMs + seg.minRideMs
  if (nextMinRide > ctx.rideCapMs) {
    return
  }
  const maxStepMs = Math.max(seg.estRideMs, seg.minRideMs)
  const singleInterval = intervals.length === 1
  for (const { startMs, endMs } of intervals) {
    const nextLatest = Math.min(label.latestClockMs - seg.minRideMs, endMs)
    const nextEarliest = Math.max(
      label.earliestClockMs - maxStepMs,
      startMs,
      ctx.minDepartureMs,
    )
    if (nextLatest < nextEarliest || !isWithinSearchDay(nextLatest, ctx)) {
      continue
    }
    const stepped: BackwardLabel = {
      stopId: seg.fromStopId,
      minRideMs: nextMinRide,
      estRideMs: label.estRideMs + seg.estRideMs,
      earliestClockMs: nextEarliest,
      latestClockMs: nextLatest,
      estClockMs: clamp(
        label.estClockMs - seg.estRideMs,
        nextEarliest,
        nextLatest,
      ),
      transfers: round,
    }
    if (nextBag) {
      appendSteppedBagLabel(nextBag, stepped, singleInterval)
    }
    recordUpdatedLabel(stepped, tracker)
  }
}

interface FrontierTracker {
  readonly boardedFrontiers: StopFrontier
  readonly updatedStops: StopFrontier | null
}

const recordUpdatedLabel = (
  label: BackwardLabel,
  tracker: FrontierTracker,
): void => {
  const recorded = insertFrontierLabel(tracker.boardedFrontiers, label, false)
  if (recorded && tracker.updatedStops) {
    insertFrontierLabel(tracker.updatedStops, recorded, true)
  }
}

const stepBagAcrossSegment = (
  bag: readonly BackwardLabel[],
  seg: TransitSegment,
  round: number,
  needNextBag: boolean,
  tracker: FrontierTracker,
  ctx: PlannerContext,
): BackwardLabel[] => {
  const intervals = getOperatingIntervalsForDate(seg, ctx)
  if (intervals.length === 0) {
    return []
  }
  const nextBag: BackwardLabel[] | null = needNextBag ? [] : null
  for (const label of bag) {
    if (label.minRideMs + seg.minRideMs > ctx.rideCapMs) {
      break
    }
    stepLabelAcrossSegment(label, seg, round, intervals, ctx, nextBag, tracker)
  }
  return nextBag ?? []
}

const prepareSegmentBag = (
  bag: BackwardLabel[],
  seg: TransitSegment,
  prevFromStopId: string | undefined,
  roundInput: StopFrontier,
  ctx: PlannerContext,
): BackwardLabel[] => {
  const activeBag =
    prevFromStopId !== undefined && seg.toStopId !== prevFromStopId ? [] : bag
  const maxInputMinRide = ctx.rideCapMs - seg.minRideMs
  if (maxInputMinRide < 0) {
    return []
  }
  const entering = roundInput.get(seg.toStopId)
  return entering
    ? mergeSortedBags(activeBag, entering, maxInputMinRide)
    : activeBag
}

const relaxPatternPass = (
  pattern: TransitPattern,
  round: number,
  roundInput: StopFrontier,
  tracker: FrontierTracker,
  ctx: PlannerContext,
): void => {
  let bag: BackwardLabel[] = []
  let prevFromStopId: string | undefined
  for (let i = pattern.segments.length - 1; i >= 0; i -= 1) {
    const seg = pattern.segments[i]
    if (!seg) {
      continue
    }
    bag = prepareSegmentBag(bag, seg, prevFromStopId, roundInput, ctx)
    prevFromStopId = seg.fromStopId
    if (bag.length === 0) {
      continue
    }
    const needNextBag =
      i > 0 && pattern.segments[i - 1]?.toStopId === seg.fromStopId
    bag = stepBagAcrossSegment(bag, seg, round, needNextBag, tracker, ctx)
  }
}

const relaxLoopWrapPass = (
  pattern: TransitPattern,
  alightIndex: number,
  initialBag: readonly BackwardLabel[],
  round: number,
  tracker: FrontierTracker,
  ctx: PlannerContext,
): void => {
  let bag = initialBag
  const alightStopId = pattern.segments[alightIndex]?.toStopId
  let prevFromStopId = alightStopId
  // Keep each alighting bag separate: merging origins loses where a ride must end.
  for (
    let step = 0;
    step < pattern.segments.length && bag.length > 0;
    step += 1
  ) {
    const i =
      (alightIndex - step + pattern.segments.length) % pattern.segments.length
    const seg = pattern.segments[i]
    if (
      !seg ||
      seg.toStopId !== prevFromStopId ||
      seg.fromStopId === alightStopId
    ) {
      break
    }
    prevFromStopId = seg.fromStopId
    const next =
      pattern.segments[
        (i + pattern.segments.length - 1) % pattern.segments.length
      ]
    const needNextBag =
      step + 1 < pattern.segments.length &&
      next?.toStopId === seg.fromStopId &&
      next.fromStopId !== alightStopId
    bag = stepBagAcrossSegment(bag, seg, round, needNextBag, tracker, ctx)
  }
}

const relaxEstimatedPattern = (
  pattern: TransitPattern,
  round: number,
  roundInput: StopFrontier,
  tracker: FrontierTracker,
  ctx: PlannerContext,
): void => {
  if (!pattern.isLoop) {
    relaxPatternPass(pattern, round, roundInput, tracker, ctx)
    return
  }
  for (let i = pattern.segments.length - 1; i >= 0; i -= 1) {
    const seg = pattern.segments[i]
    const entering = seg && roundInput.get(seg.toStopId)
    if (entering) {
      relaxLoopWrapPass(pattern, i, entering, round, tracker, ctx)
    }
  }
}

const indexIncomingTransfers = (
  transfers: readonly TransferLink[],
): ReadonlyMap<string, readonly TransferLink[]> => {
  const incoming = new Map<string, TransferLink[]>()
  for (const link of transfers) {
    const list = incoming.get(link.toStopId) ?? []
    list.push(link)
    incoming.set(link.toStopId, list)
  }
  return incoming
}

const shiftLabelByTransfer = (
  label: BackwardLabel,
  targetStopId: string,
  walkMs: number,
  minWaitMs: number,
  estWaitMs: number,
  nextRound: number,
  ctx: PlannerContext,
): BackwardLabel | null => {
  const nextLatest = label.latestClockMs - walkMs - minWaitMs
  const nextEarliest = ctx.minDepartureMs
  if (nextLatest < nextEarliest || !isWithinSearchDay(nextLatest, ctx)) {
    return null
  }
  return {
    stopId: targetStopId,
    minRideMs: label.minRideMs,
    estRideMs: label.estRideMs,
    earliestClockMs: nextEarliest,
    latestClockMs: nextLatest,
    estClockMs: clamp(
      label.estClockMs - walkMs - estWaitMs,
      nextEarliest,
      nextLatest,
    ),
    transfers: nextRound,
  }
}

const addShiftedTransfer = (
  shifted: BackwardLabel | null,
  transferFrontiers: StopFrontier,
  nextInput: StopFrontier,
): void => {
  if (!shifted) {
    return
  }
  const recorded = insertFrontierLabel(transferFrontiers, shifted, true)
  if (recorded) {
    insertFrontierLabel(nextInput, recorded, true)
  }
}

const propagateTransfersForLabel = (
  label: BackwardLabel,
  links: readonly TransferLink[],
  nextRound: number,
  transferFrontiers: StopFrontier,
  nextInput: StopFrontier,
  ctx: PlannerContext,
): void => {
  addShiftedTransfer(
    shiftLabelByTransfer(
      label,
      label.stopId,
      0,
      SAME_STOP_MIN_WAIT_MS,
      SAME_STOP_EST_WAIT_MS,
      nextRound,
      ctx,
    ),
    transferFrontiers,
    nextInput,
  )
  for (const link of links) {
    addShiftedTransfer(
      shiftLabelByTransfer(
        label,
        link.fromStopId,
        link.walkMs,
        link.minTransferWaitMs,
        link.estTransferWaitMs,
        nextRound,
        ctx,
      ),
      transferFrontiers,
      nextInput,
    )
  }
}

const propagateTransfers = (
  updatedStops: StopFrontier,
  incomingTransfers: ReadonlyMap<string, readonly TransferLink[]>,
  nextRound: number,
  transferFrontiers: StopFrontier,
  ctx: PlannerContext,
): StopFrontier => {
  const nextInput: StopFrontier = new Map()
  for (const [toStopId, labels] of updatedStops.entries()) {
    const links = incomingTransfers.get(toStopId) ?? []
    for (const label of labels) {
      propagateTransfersForLabel(
        label,
        links,
        nextRound,
        transferFrontiers,
        nextInput,
        ctx,
      )
    }
  }
  return nextInput
}

const orderLabelsForProbe = (
  labels: readonly BackwardLabel[],
  rideCapMs: number,
): readonly BackwardLabel[] =>
  [...labels].sort((a, b) => {
    const aEstOk = a.estRideMs <= rideCapMs ? 0 : 1
    const bEstOk = b.estRideMs <= rideCapMs ? 0 : 1
    if (aEstOk !== bEstOk) {
      return aEstOk - bEstOk
    }
    if (a.transfers !== b.transfers) {
      return a.transfers - b.transfers
    }
    if (a.estRideMs !== b.estRideMs) {
      return a.estRideMs - b.estRideMs
    }
    return b.estClockMs - a.estClockMs
  })

const areIntervalsDisjoint = (a: BackwardLabel, b: BackwardLabel): boolean =>
  a.latestClockMs < b.earliestClockMs || b.latestClockMs < a.earliestClockMs

const selectDistinctWindowAnchors = (
  ordered: readonly BackwardLabel[],
  rideCapMs: number,
  maxProbesPerStop: number,
): readonly BackwardLabel[] => {
  const primary = ordered[0]
  if (!primary) {
    return []
  }
  const primaryEstOk = primary.estRideMs <= rideCapMs
  const anchors: BackwardLabel[] = [primary]
  for (let i = 1; i < ordered.length; i += 1) {
    if (anchors.length >= maxProbesPerStop) {
      break
    }
    const label = ordered[i]
    if (!label || (primaryEstOk && label.estRideMs > rideCapMs)) {
      continue
    }
    // Keep distinct service windows. Inside overlapping windows, don't spend
    // a better journey's brackets on a longer transfer chain or a worse
    // over-cap estimate; split them between comparably ranked departures.
    if (
      anchors.every(
        (anchor) =>
          areIntervalsDisjoint(label, anchor) ||
          (primaryEstOk &&
            label.transfers === anchor.transfers &&
            Math.abs(label.estClockMs - anchor.estClockMs) >
              2 * BRACKET_OFFSET_MS),
      )
    ) {
      anchors.push(label)
    }
  }
  return anchors
}

const pushUniqueProbeClock = (
  uniqueClocks: string[],
  probeMs: number,
  ctx: PlannerContext,
  maxProbesPerStop: number,
): void => {
  if (uniqueClocks.length >= maxProbesPerStop) {
    return
  }
  const clampedMs = clamp(probeMs, ctx.dayStartMs, ctx.deadlineMs)
  if (!isWithinSearchDay(clampedMs, ctx)) {
    return
  }
  const formatted = formatSingaporeTime(clampedMs, true)
  if (!uniqueClocks.includes(formatted)) {
    uniqueClocks.push(formatted)
  }
}

const getBracketAnchorAndOffsets = (
  label: BackwardLabel,
  ctx: PlannerContext,
): { readonly anchorMs: number; readonly offsets: readonly number[] } => {
  const anchorMs = clamp(
    label.estClockMs - PRIMARY_FORWARD_BIAS_MS,
    ctx.dayStartMs,
    ctx.deadlineMs,
  )
  const fourthOffset =
    anchorMs + 2 * BRACKET_OFFSET_MS <= label.latestClockMs
      ? 2 * BRACKET_OFFSET_MS
      : -2 * BRACKET_OFFSET_MS
  return {
    anchorMs,
    offsets: [-BRACKET_OFFSET_MS, BRACKET_OFFSET_MS, fourthOffset],
  }
}

const buildCandidateDepartures = (
  labels: readonly BackwardLabel[],
  ctx: PlannerContext,
  maxProbesPerStop: number,
): readonly string[] => {
  const ordered = orderLabelsForProbe(labels, ctx.rideCapMs)
  const anchors = selectDistinctWindowAnchors(
    ordered,
    ctx.rideCapMs,
    maxProbesPerStop,
  )
  const bracketPlans = anchors.map((anchor) =>
    getBracketAnchorAndOffsets(anchor, ctx),
  )
  const uniqueClocks: string[] = []
  for (const plan of bracketPlans) {
    pushUniqueProbeClock(uniqueClocks, plan.anchorMs, ctx, maxProbesPerStop)
  }
  const maxOffsets = bracketPlans[0]?.offsets.length ?? 0
  for (let offsetIdx = 0; offsetIdx < maxOffsets; offsetIdx += 1) {
    if (uniqueClocks.length >= maxProbesPerStop) {
      break
    }
    for (const plan of bracketPlans) {
      const offset = plan.offsets[offsetIdx]
      if (offset !== undefined) {
        pushUniqueProbeClock(
          uniqueClocks,
          plan.anchorMs + offset,
          ctx,
          maxProbesPerStop,
        )
      }
    }
  }
  return uniqueClocks
}

const summarizeLead = (
  stop: Stop,
  labels: readonly BackwardLabel[],
  ctx: PlannerContext,
  maxProbesPerStop: number,
): BackwardLead | null => {
  let minRideMs = Number.POSITIVE_INFINITY
  let estRideMs = Number.POSITIVE_INFINITY
  let transfers = Number.POSITIVE_INFINITY
  for (const label of labels) {
    minRideMs = Math.min(minRideMs, label.minRideMs)
    estRideMs = Math.min(estRideMs, label.estRideMs)
    transfers = Math.min(transfers, label.transfers)
  }
  const effectiveMaxProbes =
    estRideMs > ctx.rideCapMs ? Math.min(2, maxProbesPerStop) : maxProbesPerStop
  const candidateDepartures = buildCandidateDepartures(
    labels,
    ctx,
    effectiveMaxProbes,
  )
  if (candidateDepartures.length === 0) {
    return null
  }
  return {
    stop,
    candidateDepartures,
    minRideMs,
    estRideMs,
    transfers,
  }
}

const compareLeads = (
  a: BackwardLead,
  b: BackwardLead,
  rideCapMs: number,
): number => {
  const aConfident = a.estRideMs <= rideCapMs ? 0 : 1
  const bConfident = b.estRideMs <= rideCapMs ? 0 : 1
  if (aConfident !== bConfident) {
    return aConfident - bConfident
  }
  if (a.estRideMs !== b.estRideMs) {
    return b.estRideMs - a.estRideMs
  }
  if (a.stop.kind !== b.stop.kind) {
    return a.stop.kind === 'rail' ? -1 : 1
  }
  return a.stop.id.localeCompare(b.stop.id)
}

const buildSortedLeads = (
  inventory: StopInventory,
  workplace: Workplace,
  boardedFrontiers: StopFrontier,
  ctx: PlannerContext,
  maxProbesPerStop: number,
): readonly BackwardLead[] => {
  const stopsById = new Map(inventory.stops.map((s) => [s.id, s]))
  const leads: BackwardLead[] = []
  for (const [stopId, labels] of boardedFrontiers.entries()) {
    const stop = stopsById.get(stopId)
    if (
      !stop ||
      isDestinationStationMatch(stop, workplace) ||
      labels.length === 0
    ) {
      continue
    }
    const lead = summarizeLead(stop, labels, ctx, maxProbesPerStop)
    if (lead) {
      leads.push(lead)
    }
  }
  leads.sort((a, b) => compareLeads(a, b, ctx.rideCapMs))
  return leads
}

const relaxPatternsForRound = (
  patterns: readonly TransitPattern[],
  round: number,
  roundInput: StopFrontier,
  tracker: FrontierTracker,
  ctx: PlannerContext,
): void => {
  for (const pattern of patterns) {
    if (pattern.segments.some((s) => roundInput.has(s.toStopId))) {
      relaxEstimatedPattern(pattern, round, roundInput, tracker, ctx)
    }
  }
}

const runBackwardRounds = (
  networkIndex: TransitNetworkIndex,
  seedLabels: StopFrontier,
  maxTransfers: number,
  ctx: PlannerContext,
): StopFrontier => {
  const incomingTransfers = indexIncomingTransfers(networkIndex.transfers)
  const boardedFrontiers: StopFrontier = new Map()
  const transferFrontiers: StopFrontier = new Map()
  let roundInput = seedLabels

  for (let round = 0; round <= maxTransfers; round += 1) {
    if (roundInput.size === 0) {
      break
    }
    const updatedStops: StopFrontier | null =
      round < maxTransfers ? new Map() : null
    const tracker: FrontierTracker = {
      boardedFrontiers,
      updatedStops,
    }
    relaxPatternsForRound(
      networkIndex.patterns,
      round,
      roundInput,
      tracker,
      ctx,
    )
    roundInput = updatedStops
      ? propagateTransfers(
          updatedStops,
          incomingTransfers,
          round + 1,
          transferFrontiers,
          ctx,
        )
      : new Map()
  }
  return boardedFrontiers
}

/** Plan prioritized boarding leads and candidate departures by searching backward from the workplace. */
export const planBackwardLeads = (
  options: PlanBackwardLeadsOptions,
): BackwardPlanResult => {
  const maxFinalWalkMeters =
    options.maxFinalWalkMeters ?? DEFAULT_MAX_FINAL_WALK_M
  const maxTransfers = options.maxTransfers ?? DEFAULT_MAX_TRANSFERS
  const maxProbesPerStop =
    options.maxProbesPerStop ?? DEFAULT_MAX_PROBES_PER_STOP

  const dayStartMs = parseSingaporeDateTimeMs(
    options.constraints.searchDate,
    '00:00',
  )
  const deadlineMs = parseSingaporeDateTimeMs(
    options.constraints.searchDate,
    options.constraints.officeStart,
  )
  const rideCapMs = options.constraints.rideCapMinutes * 60_000
  const ctx: PlannerContext = {
    searchDate: options.constraints.searchDate,
    dayType: getServiceDayType(options.constraints.searchDate),
    prevDayType: getServiceDayType(getSingaporeDateFromInstant(dayStartMs - 1)),
    dayStartMs,
    dayEndMs: dayStartMs + DAY_MINUTES_MS,
    deadlineMs,
    rideCapMs,
    minDepartureMs: Math.max(
      dayStartMs,
      deadlineMs - rideCapMs - MIN_DEPARTURE_LOOKBACK_MS,
    ),
  }

  const seedLabels = seedFinalWalkLabels(
    options.inventory,
    options.workplace,
    ctx,
    maxFinalWalkMeters,
  )
  const boardedFrontiers = runBackwardRounds(
    options.networkIndex,
    seedLabels,
    maxTransfers,
    ctx,
  )
  const coveredSet = new Set(options.networkIndex.coveredStopIds)
  const uncoveredStopIds = options.inventory.stops
    .filter(
      (s) =>
        !coveredSet.has(s.id) &&
        !isDestinationStationMatch(s, options.workplace),
    )
    .map((s) => s.id)
  const leads = buildSortedLeads(
    options.inventory,
    options.workplace,
    boardedFrontiers,
    ctx,
    maxProbesPerStop,
  )
  const leadStopSet = new Set(leads.map((l) => l.stop.id))
  const prunedStopCount = options.inventory.stops.filter(
    (s) =>
      coveredSet.has(s.id) &&
      !leadStopSet.has(s.id) &&
      !isDestinationStationMatch(s, options.workplace),
  ).length

  return {
    leads,
    coveredStopCount: coveredSet.size,
    uncoveredStopIds,
    prunedStopCount,
  }
}
