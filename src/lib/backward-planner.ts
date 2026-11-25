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
  readonly hasBoardedTransit: boolean
}

interface PlannerContext {
  readonly searchDate: string
  readonly dayType: DayType
  readonly dayStartMs: number
  readonly deadlineMs: number
  readonly rideCapMs: number
  readonly minDepartureMs: number
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))

const CLOCK_BUCKET_MS = 300_000

const isDominated = (
  candidate: BackwardLabel,
  existing: BackwardLabel,
): boolean => {
  if (
    existing.hasBoardedTransit !== candidate.hasBoardedTransit ||
    existing.minRideMs > candidate.minRideMs ||
    existing.estRideMs > candidate.estRideMs ||
    existing.transfers > candidate.transfers
  ) {
    return false
  }
  return (
    Math.floor(existing.estClockMs / CLOCK_BUCKET_MS) ===
    Math.floor(candidate.estClockMs / CLOCK_BUCKET_MS)
  )
}

const insertIntoLabelList = (
  existing: readonly BackwardLabel[],
  label: BackwardLabel,
): { readonly next: BackwardLabel[]; readonly added: boolean } => {
  const next: BackwardLabel[] = []
  let absorbed = false
  for (const item of existing) {
    if (!absorbed && isDominated(label, item)) {
      const needsWiden =
        label.earliestClockMs < item.earliestClockMs ||
        label.latestClockMs > item.latestClockMs
      next.push(
        needsWiden
          ? {
              ...item,
              earliestClockMs: Math.min(
                item.earliestClockMs,
                label.earliestClockMs,
              ),
              latestClockMs: Math.max(item.latestClockMs, label.latestClockMs),
            }
          : item,
      )
      absorbed = true
      continue
    }
    if (!isDominated(item, label)) {
      next.push(item)
    }
  }
  if (absorbed) {
    return { next, added: false }
  }
  next.push(label)
  return { next, added: true }
}

const insertParetoLabel = (
  frontier: Map<string, BackwardLabel[]>,
  label: BackwardLabel,
): boolean => {
  const { next, added } = insertIntoLabelList(
    frontier.get(label.stopId) ?? [],
    label,
  )
  frontier.set(label.stopId, next)
  return added
}

const addLabelToBag = (
  bag: BackwardLabel[],
  label: BackwardLabel,
): BackwardLabel[] => insertIntoLabelList(bag, label).next

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
    hasBoardedTransit: false,
  }
}

const seedFinalWalkLabels = (
  inventory: StopInventory,
  workplace: Workplace,
  ctx: PlannerContext,
  maxFinalWalkMeters: number,
): Map<string, BackwardLabel[]> => {
  const seeds = new Map<string, BackwardLabel[]>()
  for (const stop of inventory.stops) {
    const label = createSeedLabel(stop, workplace, ctx, maxFinalWalkMeters)
    if (label) {
      insertParetoLabel(seeds, label)
    }
  }
  return seeds
}

const stepLabelAcrossSegment = (
  label: BackwardLabel,
  seg: TransitSegment,
  round: number,
  ctx: PlannerContext,
): BackwardLabel | null => {
  const nextMinRide = label.minRideMs + seg.minRideMs
  if (nextMinRide > ctx.rideCapMs) {
    return null
  }
  const op = seg.operatingWindows?.[ctx.dayType]
  if (seg.operatingWindows !== undefined && op === undefined) {
    return null
  }
  const opStartMs = op ? ctx.dayStartMs + op.firstMin * 60_000 : ctx.dayStartMs
  const opEndMs = op
    ? ctx.dayStartMs + op.lastMin * 60_000
    : ctx.dayStartMs + DAY_MINUTES_MS
  const nextLatest = Math.min(label.latestClockMs - seg.minRideMs, opEndMs)
  const maxStepMs = Math.max(seg.estRideMs, seg.minRideMs)
  const nextEarliest = Math.max(
    label.earliestClockMs - maxStepMs,
    opStartMs,
    ctx.minDepartureMs,
  )
  if (
    nextLatest < nextEarliest ||
    getSingaporeDateFromInstant(nextLatest) !== ctx.searchDate
  ) {
    return null
  }
  return {
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
    hasBoardedTransit: true,
  }
}

interface FrontierTracker {
  readonly frontiers: Map<string, BackwardLabel[]>
  readonly updatedStops: Map<string, BackwardLabel[]>
  readonly boardedStops: Set<string>
}

const recordUpdatedLabel = (
  label: BackwardLabel,
  tracker: FrontierTracker,
): void => {
  tracker.boardedStops.add(label.stopId)
  if (insertParetoLabel(tracker.frontiers, label)) {
    insertParetoLabel(tracker.updatedStops, label)
  }
}

const mergeEnteringLabels = (
  bag: BackwardLabel[],
  entering: readonly BackwardLabel[] | undefined,
): BackwardLabel[] => {
  if (!entering) {
    return bag
  }
  let merged = bag
  for (const label of entering) {
    merged = addLabelToBag(merged, label)
  }
  return merged
}

const relaxEstimatedPattern = (
  pattern: TransitPattern,
  round: number,
  roundInput: ReadonlyMap<string, readonly BackwardLabel[]>,
  tracker: FrontierTracker,
  ctx: PlannerContext,
): void => {
  let bag: BackwardLabel[] = []
  for (let i = pattern.segments.length - 1; i >= 0; i -= 1) {
    const seg = pattern.segments[i]
    if (!seg) {
      continue
    }
    bag = mergeEnteringLabels(bag, roundInput.get(seg.toStopId))
    if (bag.length === 0) {
      continue
    }
    let nextBag: BackwardLabel[] = []
    for (const label of bag) {
      const stepped = stepLabelAcrossSegment(label, seg, round, ctx)
      if (!stepped) {
        continue
      }
      nextBag = addLabelToBag(nextBag, stepped)
      recordUpdatedLabel(stepped, tracker)
    }
    bag = nextBag
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
  const nextEarliest = Math.max(
    ctx.minDepartureMs,
    label.earliestClockMs - walkMs - estWaitMs * 2,
  )
  if (
    nextLatest < nextEarliest ||
    getSingaporeDateFromInstant(nextLatest) !== ctx.searchDate
  ) {
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
    hasBoardedTransit: true,
  }
}

const addShiftedTransfer = (
  shifted: BackwardLabel | null,
  frontiers: Map<string, BackwardLabel[]>,
  nextInput: Map<string, BackwardLabel[]>,
): void => {
  if (shifted && insertParetoLabel(frontiers, shifted)) {
    insertParetoLabel(nextInput, shifted)
  }
}

const propagateTransfers = (
  updatedStops: ReadonlyMap<string, readonly BackwardLabel[]>,
  incomingTransfers: ReadonlyMap<string, readonly TransferLink[]>,
  nextRound: number,
  frontiers: Map<string, BackwardLabel[]>,
  ctx: PlannerContext,
): Map<string, BackwardLabel[]> => {
  const nextInput = new Map<string, BackwardLabel[]>()
  for (const [toStopId, labels] of updatedStops.entries()) {
    const links = incomingTransfers.get(toStopId) ?? []
    for (const label of labels) {
      if (!label.hasBoardedTransit) {
        continue
      }
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
        frontiers,
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
          frontiers,
          nextInput,
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
    return a.transfers !== b.transfers
      ? a.transfers - b.transfers
      : a.estRideMs - b.estRideMs
  })

const appendBracketInstants = (
  chosenInstants: number[],
  primary: BackwardLabel,
  ctx: PlannerContext,
  maxProbesPerStop: number,
): void => {
  const anchorMs = clamp(
    primary.estClockMs - PRIMARY_FORWARD_BIAS_MS,
    ctx.dayStartMs,
    ctx.deadlineMs,
  )
  const fourthOffset =
    anchorMs + 2 * BRACKET_OFFSET_MS <= primary.latestClockMs
      ? 2 * BRACKET_OFFSET_MS
      : -2 * BRACKET_OFFSET_MS
  const offsets = [0, -BRACKET_OFFSET_MS, BRACKET_OFFSET_MS, fourthOffset]
  for (const offset of offsets) {
    if (chosenInstants.length >= maxProbesPerStop) {
      return
    }
    const probeMs = clamp(anchorMs + offset, ctx.dayStartMs, ctx.deadlineMs)
    if (getSingaporeDateFromInstant(probeMs) === ctx.searchDate) {
      chosenInstants.push(probeMs)
    }
  }
}

const buildCandidateDepartures = (
  labels: readonly BackwardLabel[],
  ctx: PlannerContext,
  maxProbesPerStop: number,
): readonly string[] => {
  const ordered = orderLabelsForProbe(labels, ctx.rideCapMs)
  const chosenInstants: number[] = []
  const primary = ordered[0]
  if (primary) {
    appendBracketInstants(chosenInstants, primary, ctx, maxProbesPerStop)
  }

  const uniqueClocks: string[] = []
  for (const ms of chosenInstants) {
    const formatted = formatSingaporeTime(ms, true)
    if (!uniqueClocks.includes(formatted)) {
      uniqueClocks.push(formatted)
    }
  }
  return uniqueClocks.slice(0, maxProbesPerStop)
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
  boardedStops: ReadonlySet<string>,
  frontiers: ReadonlyMap<string, readonly BackwardLabel[]>,
  ctx: PlannerContext,
  maxProbesPerStop: number,
): readonly BackwardLead[] => {
  const stopsById = new Map(inventory.stops.map((s) => [s.id, s]))
  const leads: BackwardLead[] = []
  for (const stopId of boardedStops) {
    const stop = stopsById.get(stopId)
    if (!stop || isDestinationStationMatch(stop, workplace)) {
      continue
    }
    const labels = (frontiers.get(stopId) ?? []).filter(
      (l) => l.hasBoardedTransit,
    )
    if (labels.length === 0) {
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
  roundInput: ReadonlyMap<string, readonly BackwardLabel[]>,
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
  frontiers: Map<string, BackwardLabel[]>,
  maxTransfers: number,
  ctx: PlannerContext,
): ReadonlySet<string> => {
  const incomingTransfers = indexIncomingTransfers(networkIndex.transfers)
  const boardedStops = new Set<string>()
  let roundInput = new Map<string, BackwardLabel[]>(frontiers)

  for (let round = 0; round <= maxTransfers; round += 1) {
    if (roundInput.size === 0) {
      break
    }
    const tracker: FrontierTracker = {
      frontiers,
      updatedStops: new Map<string, BackwardLabel[]>(),
      boardedStops,
    }
    relaxPatternsForRound(
      networkIndex.patterns,
      round,
      roundInput,
      tracker,
      ctx,
    )
    roundInput =
      round < maxTransfers
        ? propagateTransfers(
            tracker.updatedStops,
            incomingTransfers,
            round + 1,
            frontiers,
            ctx,
          )
        : new Map()
  }
  return boardedStops
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
    dayStartMs,
    deadlineMs,
    rideCapMs,
    minDepartureMs: Math.max(
      dayStartMs,
      deadlineMs - rideCapMs - MIN_DEPARTURE_LOOKBACK_MS,
    ),
  }

  const frontiers = seedFinalWalkLabels(
    options.inventory,
    options.workplace,
    ctx,
    maxFinalWalkMeters,
  )
  const boardedStops = runBackwardRounds(
    options.networkIndex,
    frontiers,
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
    boardedStops,
    frontiers,
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
