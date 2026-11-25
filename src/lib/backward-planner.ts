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
  type DayType,
  getServiceDayType,
  haversineDistanceMeters,
  type TransferLink,
  type TransitNetworkIndex,
  type TransitPattern,
  type TransitSegment,
} from '@lib/transit-network.js'

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

interface BackwardPlanResult {
  readonly leads: readonly BackwardLead[]
  readonly coveredStopCount: number
  readonly uncoveredStopIds: readonly string[]
  readonly prunedStopCount: number
}

interface PlanBackwardLeadsOptions {
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

const CLOCK_BUCKET_MS = 600_000
const RIDE_BUCKET_MS = 60_000
const DISTINCT_WINDOW_GAP_MS = 30 * 60_000

type BucketedLabels = Map<number, BackwardLabel[]>
type StopFrontier = Map<string, BucketedLabels>

const isWithinSearchDay = (ms: number, ctx: PlannerContext): boolean =>
  ms >= ctx.dayStartMs && ms < ctx.dayEndMs

const isBucketDominated = (
  candidate: BackwardLabel,
  existing: BackwardLabel,
): boolean =>
  existing.transfers <= candidate.transfers &&
  Math.floor(existing.minRideMs / RIDE_BUCKET_MS) <=
    Math.floor(candidate.minRideMs / RIDE_BUCKET_MS) &&
  Math.floor(existing.estRideMs / RIDE_BUCKET_MS) <=
    Math.floor(candidate.estRideMs / RIDE_BUCKET_MS)

const mergeLabelEnvelope = (
  base: BackwardLabel,
  other: BackwardLabel,
): BackwardLabel | null => {
  const minRideMs = Math.min(base.minRideMs, other.minRideMs)
  const estRideMs = Math.min(base.estRideMs, other.estRideMs)
  const earliestClockMs = Math.min(base.earliestClockMs, other.earliestClockMs)
  const latestClockMs = Math.max(base.latestClockMs, other.latestClockMs)
  if (
    minRideMs === base.minRideMs &&
    estRideMs === base.estRideMs &&
    earliestClockMs === base.earliestClockMs &&
    latestClockMs === base.latestClockMs
  ) {
    return null
  }
  return { ...base, minRideMs, estRideMs, earliestClockMs, latestClockMs }
}

const absorbIntoExistingLabel = (
  list: BackwardLabel[],
  index: number,
  existing: BackwardLabel,
  incoming: BackwardLabel,
): BackwardLabel | null => {
  const merged = mergeLabelEnvelope(existing, incoming)
  if (!merged) {
    return null
  }
  list[index] = merged
  const needsPropagate =
    merged.minRideMs < existing.minRideMs ||
    merged.earliestClockMs < existing.earliestClockMs ||
    merged.latestClockMs > existing.latestClockMs
  return needsPropagate ? merged : null
}

const insertIntoBucketList = (
  list: BackwardLabel[],
  label: BackwardLabel,
): BackwardLabel | null => {
  for (let i = 0; i < list.length; i += 1) {
    const existing = list[i]
    if (existing && isBucketDominated(label, existing)) {
      return absorbIntoExistingLabel(list, i, existing, label)
    }
  }
  let writeIdx = 0
  let inserted = label
  for (const item of list) {
    if (isBucketDominated(item, label)) {
      inserted = mergeLabelEnvelope(inserted, item) ?? inserted
    } else {
      list[writeIdx] = item
      writeIdx += 1
    }
  }
  list.length = writeIdx
  list.push(inserted)
  return inserted
}

const insertIntoBuckets = (
  buckets: BucketedLabels,
  label: BackwardLabel,
): BackwardLabel | null => {
  const bucket = Math.floor(label.estClockMs / CLOCK_BUCKET_MS)
  const list = buckets.get(bucket)
  if (!list) {
    buckets.set(bucket, [label])
    return label
  }
  return insertIntoBucketList(list, label)
}

const insertFrontierLabel = (
  frontier: StopFrontier,
  label: BackwardLabel,
): BackwardLabel | null => {
  let buckets = frontier.get(label.stopId)
  if (!buckets) {
    buckets = new Map()
    frontier.set(label.stopId, buckets)
  }
  return insertIntoBuckets(buckets, label)
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

const getOperatingIntervalsForDate = (
  seg: TransitSegment,
  ctx: PlannerContext,
): readonly OperatingIntervalMs[] => {
  if (seg.operatingWindows === undefined) {
    return [{ startMs: ctx.dayStartMs, endMs: ctx.dayEndMs }]
  }
  const intervals: OperatingIntervalMs[] = []
  const prevOp = seg.operatingWindows[ctx.prevDayType]
  if (prevOp !== undefined && prevOp.lastMin >= 1440) {
    const startMs = Math.max(
      ctx.dayStartMs,
      ctx.dayStartMs + (prevOp.firstMin - 1440) * 60_000,
    )
    const endMs = ctx.dayStartMs + (prevOp.lastMin - 1440) * 60_000
    if (endMs >= startMs) {
      intervals.push({ startMs, endMs })
    }
  }
  const op = seg.operatingWindows[ctx.dayType]
  if (op !== undefined && op.firstMin < 1440) {
    intervals.push({
      startMs: ctx.dayStartMs + op.firstMin * 60_000,
      endMs: ctx.dayStartMs + op.lastMin * 60_000,
    })
  }
  return intervals
}

const stepLabelAcrossSegment = (
  label: BackwardLabel,
  seg: TransitSegment,
  round: number,
  intervals: readonly OperatingIntervalMs[],
  ctx: PlannerContext,
  nextBag: BucketedLabels,
  tracker: FrontierTracker,
): void => {
  const nextMinRide = label.minRideMs + seg.minRideMs
  if (nextMinRide > ctx.rideCapMs) {
    return
  }
  const maxStepMs = Math.max(seg.estRideMs, seg.minRideMs)
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
    insertIntoBuckets(nextBag, stepped)
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
  const recorded = insertFrontierLabel(tracker.boardedFrontiers, label)
  if (recorded && tracker.updatedStops) {
    insertFrontierLabel(tracker.updatedStops, recorded)
  }
}

const mergeEnteringLabels = (
  bag: BucketedLabels,
  entering: BucketedLabels | undefined,
): void => {
  if (!entering) {
    return
  }
  for (const list of entering.values()) {
    for (const label of list) {
      insertIntoBuckets(bag, label)
    }
  }
}

const stepBagAcrossSegment = (
  bag: BucketedLabels,
  seg: TransitSegment,
  round: number,
  tracker: FrontierTracker,
  ctx: PlannerContext,
): BucketedLabels => {
  const nextBag: BucketedLabels = new Map()
  const intervals = getOperatingIntervalsForDate(seg, ctx)
  if (intervals.length === 0) {
    return nextBag
  }
  for (const list of bag.values()) {
    for (const label of list) {
      stepLabelAcrossSegment(
        label,
        seg,
        round,
        intervals,
        ctx,
        nextBag,
        tracker,
      )
    }
  }
  return nextBag
}

const relaxEstimatedPattern = (
  pattern: TransitPattern,
  round: number,
  roundInput: StopFrontier,
  tracker: FrontierTracker,
  ctx: PlannerContext,
): void => {
  let bag: BucketedLabels = new Map()
  let prevFromStopId: string | undefined
  for (let i = pattern.segments.length - 1; i >= 0; i -= 1) {
    const seg = pattern.segments[i]
    if (!seg) {
      continue
    }
    if (prevFromStopId !== undefined && seg.toStopId !== prevFromStopId) {
      bag = new Map()
    }
    prevFromStopId = seg.fromStopId
    mergeEnteringLabels(bag, roundInput.get(seg.toStopId))
    if (bag.size === 0) {
      continue
    }
    bag = stepBagAcrossSegment(bag, seg, round, tracker, ctx)
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
  const recorded = insertFrontierLabel(transferFrontiers, shifted)
  if (recorded) {
    insertFrontierLabel(nextInput, recorded)
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
  for (const [toStopId, buckets] of updatedStops.entries()) {
    const links = incomingTransfers.get(toStopId) ?? []
    for (const list of buckets.values()) {
      for (const label of list) {
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
    if (
      anchors.every(
        (anchor) =>
          Math.abs(label.estClockMs - anchor.estClockMs) >=
          DISTINCT_WINDOW_GAP_MS,
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
  const uniqueClocks: string[] = []
  for (const anchor of anchors) {
    const { anchorMs } = getBracketAnchorAndOffsets(anchor, ctx)
    pushUniqueProbeClock(uniqueClocks, anchorMs, ctx, maxProbesPerStop)
  }
  for (const anchor of anchors) {
    if (uniqueClocks.length >= maxProbesPerStop) {
      break
    }
    const { anchorMs, offsets } = getBracketAnchorAndOffsets(anchor, ctx)
    for (const offset of offsets) {
      pushUniqueProbeClock(
        uniqueClocks,
        anchorMs + offset,
        ctx,
        maxProbesPerStop,
      )
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
  for (const [stopId, buckets] of boardedFrontiers.entries()) {
    const stop = stopsById.get(stopId)
    if (
      !stop ||
      isDestinationStationMatch(stop, workplace) ||
      buckets.size === 0
    ) {
      continue
    }
    const labels = [...buckets.values()].flat()
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
