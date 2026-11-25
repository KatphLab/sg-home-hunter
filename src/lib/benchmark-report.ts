import { isDestinationStationMatch } from '@lib/commute-rules.js'
import type {
  QualifiedStop,
  SearchConstraints,
  StopInventory,
  Workplace,
} from '@lib/commute-types.js'
import {
  formatSingaporeTime,
  getSingaporeDateFromInstant,
  parseSingaporeDateTimeMs,
} from '@lib/singapore-calendar.js'

const ARRIVAL_WINDOW_EARLY_MS = 900_000

export interface BenchmarkCaseSpec {
  readonly caseId: string
  readonly label: string
  readonly workplace: Workplace
  readonly constraints: SearchConstraints
}

export interface BenchmarkRunMetrics {
  readonly algorithm: 'baseline' | 'backward-prototype'
  readonly status: 'completed' | 'partial'
  readonly authExpired: boolean
  readonly inventoryDate: string
  readonly networkDate?: string
  readonly coldIndexMs?: number
  readonly warmIndexMs?: number
  readonly planMs?: number
  readonly elapsedMs: number
  readonly requestCount: number
  readonly wastedRequestCount: number
  readonly failedQueries: number
  readonly triedCount: number
  readonly totalCount: number
  readonly candidateStopCount?: number
  readonly prunedStopCount?: number
  readonly uncoveredStopCount?: number
  readonly matches: readonly QualifiedStop[]
}

export interface CaseComparison {
  readonly caseSpec: BenchmarkCaseSpec
  readonly baseline: BenchmarkRunMetrics
  readonly prototype: BenchmarkRunMetrics
  readonly speedup: number | null
  readonly requestRatio: number | null
  readonly sharedStopIds: readonly string[]
  readonly lostMatches: readonly QualifiedStop[]
  readonly newMatches: readonly QualifiedStop[]
  readonly validationErrors: readonly string[]
}

const validateSingleMatch = (
  entry: QualifiedStop,
  stopsById: ReadonlyMap<string, unknown>,
  workplace: Workplace,
  constraints: SearchConstraints,
  windowStartMs: number,
  deadlineMs: number,
): string | null => {
  const { stop, journey } = entry
  if (!stopsById.has(stop.id) || journey.stopId !== stop.id) {
    return `Unknown or mismatched stop ID ${stop.id}`
  }
  if (journey.searchDate !== constraints.searchDate) {
    return `Stop ${stop.id} searchDate ${journey.searchDate} != ${constraints.searchDate}`
  }
  if (journey.isAtDestination) {
    return isDestinationStationMatch(stop, workplace) && journey.rideMs === 0
      ? null
      : `Invalid zero-ride destination match for ${stop.id}`
  }
  if (
    getSingaporeDateFromInstant(journey.boardingAtMs) !==
      constraints.searchDate ||
    getSingaporeDateFromInstant(journey.arrivalAtMs) !== constraints.searchDate
  ) {
    return `Stop ${stop.id} journey falls outside search date ${constraints.searchDate}`
  }
  if (journey.arrivalAtMs < windowStartMs || journey.arrivalAtMs > deadlineMs) {
    return `Stop ${stop.id} arrival ${formatSingaporeTime(journey.arrivalAtMs, true)} outside arrival window`
  }
  if (journey.rideMs > constraints.rideCapMinutes * 60_000) {
    return `Stop ${stop.id} rideMs ${String(journey.rideMs)} exceeds ride cap`
  }
  return null
}

/** Validate that every reported match satisfies Singapore date, arrival window, ride cap, and identity rules. */
export const validateQualifiedStops = (
  matches: readonly QualifiedStop[],
  inventory: StopInventory,
  workplace: Workplace,
  constraints: SearchConstraints,
): readonly string[] => {
  const stopsById = new Map(inventory.stops.map((s) => [s.id, s]))
  const deadlineMs = parseSingaporeDateTimeMs(
    constraints.searchDate,
    constraints.officeStart,
  )
  const windowStartMs = deadlineMs - ARRIVAL_WINDOW_EARLY_MS
  const errors: string[] = []
  for (const entry of matches) {
    const err = validateSingleMatch(
      entry,
      stopsById,
      workplace,
      constraints,
      windowStartMs,
      deadlineMs,
    )
    if (err) {
      errors.push(err)
    }
  }
  return errors
}

/** Compare baseline and prototype benchmark runs, computing speedup only when both complete. */
export const compareBenchmarkRuns = (
  caseSpec: BenchmarkCaseSpec,
  baseline: BenchmarkRunMetrics,
  prototype: BenchmarkRunMetrics,
  inventory: StopInventory,
): CaseComparison => {
  const baseMap = new Map(baseline.matches.map((m) => [m.stop.id, m]))
  const protoMap = new Map(prototype.matches.map((m) => [m.stop.id, m]))

  const sharedStopIds = [...baseMap.keys()]
    .filter((id) => protoMap.has(id))
    .sort((a, b) => a.localeCompare(b))
  const lostMatches = [...baseMap.values()]
    .filter((m) => !protoMap.has(m.stop.id))
    .sort((a, b) => a.stop.id.localeCompare(b.stop.id))
  const newMatches = [...protoMap.values()]
    .filter((m) => !baseMap.has(m.stop.id))
    .sort((a, b) => a.stop.id.localeCompare(b.stop.id))

  const bothCompleted =
    baseline.status === 'completed' && prototype.status === 'completed'
  const speedup =
    bothCompleted && prototype.elapsedMs > 0
      ? Math.round((baseline.elapsedMs / prototype.elapsedMs) * 100) / 100
      : null
  const requestRatio =
    prototype.requestCount > 0
      ? Math.round((baseline.requestCount / prototype.requestCount) * 100) / 100
      : null

  const validationErrors = [
    ...validateQualifiedStops(
      baseline.matches,
      inventory,
      caseSpec.workplace,
      caseSpec.constraints,
    ).map((e) => `baseline: ${e}`),
    ...validateQualifiedStops(
      prototype.matches,
      inventory,
      caseSpec.workplace,
      caseSpec.constraints,
    ).map((e) => `prototype: ${e}`),
  ]

  return {
    caseSpec,
    baseline,
    prototype,
    speedup,
    requestRatio,
    sharedStopIds,
    lostMatches,
    newMatches,
    validationErrors,
  }
}

const formatJourneyEvidence = (entry: QualifiedStop): string => {
  const { stop, journey } = entry
  if (journey.isAtDestination) {
    return `\`${stop.id}\` (${stop.name}, destination zero-ride)`
  }
  const board = formatSingaporeTime(journey.boardingAtMs, true)
  const arrive = formatSingaporeTime(journey.arrivalAtMs, true)
  const rideMin = Math.round((journey.rideMs / 60_000) * 10) / 10
  const svcs = journey.services.map((s) => s.name).join(' → ')
  return `\`${stop.id}\` (${stop.name}): board ${board}, arrive ${arrive}, ride ${String(rideMin)}m via ${svcs}`
}

const formatDurationSec = (ms: number): string => `${(ms / 1000).toFixed(2)}s`

const formatSummaryRow = (cmp: CaseComparison): string => {
  const { caseSpec, baseline, prototype } = cmp
  const speedupText =
    cmp.speedup !== null ? `${cmp.speedup.toFixed(2)}x` : 'N/A (partial)'
  const coldWarm =
    prototype.coldIndexMs !== undefined && prototype.warmIndexMs !== undefined
      ? `${String(Math.round(prototype.coldIndexMs))}ms / ${String(Math.round(prototype.warmIndexMs))}ms`
      : '—'
  return `| ${caseSpec.caseId} | ${caseSpec.constraints.searchDate} | ${String(caseSpec.constraints.rideCapMinutes)}m | ${baseline.status} (${formatDurationSec(baseline.elapsedMs)}, ${String(baseline.requestCount)} req, ${String(baseline.wastedRequestCount)} wasted) | ${prototype.status} (${formatDurationSec(prototype.elapsedMs)}, ${String(prototype.requestCount)} req, ${String(prototype.wastedRequestCount)} wasted) | ${coldWarm} | ${String(baseline.matches.length)} | ${String(prototype.matches.length)} | ${String(cmp.lostMatches.length)} / ${String(cmp.newMatches.length)} | ${speedupText} |`
}

const appendMatchSection = (
  lines: string[],
  heading: string,
  entries: readonly QualifiedStop[],
): void => {
  if (entries.length === 0) {
    return
  }
  lines.push('', heading)
  for (const m of entries) {
    lines.push(`- ${formatJourneyEvidence(m)}`)
  }
}

const formatCaseDetail = (cmp: CaseComparison): string => {
  const { caseSpec, baseline, prototype } = cmp
  const sharedMatches = baseline.matches.filter((m) =>
    cmp.sharedStopIds.includes(m.stop.id),
  )
  const coldTotalMs =
    prototype.coldIndexMs !== undefined
      ? formatDurationSec(prototype.coldIndexMs + prototype.elapsedMs)
      : '—'
  const warmTotalMs =
    prototype.warmIndexMs !== undefined
      ? formatDurationSec(prototype.warmIndexMs + prototype.elapsedMs)
      : '—'
  const reqRatioText =
    cmp.requestRatio !== null ? `${cmp.requestRatio.toFixed(2)}x` : '—'

  const lines: string[] = [
    `### ${caseSpec.caseId}: ${caseSpec.label}`,
    '',
    `- **Workplace**: ${caseSpec.workplace.label} (${caseSpec.workplace.kind})`,
    `- **Constraints**: Date ${caseSpec.constraints.searchDate}, Office start ${caseSpec.constraints.officeStart} SGT (window -15m..0m), Ride cap ${String(caseSpec.constraints.rideCapMinutes)}m`,
    `- **Inventory**: ${baseline.inventoryDate} (${String(baseline.totalCount)} stops)`,
    `- **Baseline**: status=${baseline.status}, elapsed=${formatDurationSec(baseline.elapsedMs)}, tried=${String(baseline.triedCount)}/${String(baseline.totalCount)}, requests=${String(baseline.requestCount)}, wasted=${String(baseline.wastedRequestCount)}, failed=${String(baseline.failedQueries)}, matches=${String(baseline.matches.length)}`,
    `- **Prototype**: status=${prototype.status}, searchElapsed=${formatDurationSec(prototype.elapsedMs)}, coldTotal=${coldTotalMs}, warmTotal=${warmTotalMs}, plan=${String(prototype.planMs ?? 0)}ms, candidates=${String(prototype.candidateStopCount ?? 0)}, pruned=${String(prototype.prunedStopCount ?? 0)}, uncovered=${String(prototype.uncoveredStopCount ?? 0)}, requests=${String(prototype.requestCount)} (ratio ${reqRatioText}), wasted=${String(prototype.wastedRequestCount)}, failed=${String(prototype.failedQueries)}, matches=${String(prototype.matches.length)}`,
    `- **Shared matches**: ${String(cmp.sharedStopIds.length)} | **Lost (baseline only)**: ${String(cmp.lostMatches.length)} | **New (prototype only)**: ${String(cmp.newMatches.length)}`,
  ]

  if (cmp.validationErrors.length > 0) {
    lines.push(`- **Validation errors**: ${cmp.validationErrors.join('; ')}`)
  }
  appendMatchSection(lines, '**Shared verified matches:**', sharedMatches)
  appendMatchSection(
    lines,
    '**Baseline matches missing from prototype:**',
    cmp.lostMatches,
  )
  appendMatchSection(
    lines,
    '**Newly discovered prototype matches:**',
    cmp.newMatches,
  )
  lines.push('')
  return lines.join('\n')
}

/** Render a complete Markdown comparison table and per-case diff report. */
export const formatBenchmarkMarkdown = (
  comparisons: readonly CaseComparison[],
  title: string,
): string => {
  const header = [
    `# ${title}`,
    '',
    '| Case | Date | Cap | Baseline (status, time, req, wasted) | Prototype (status, time, req, wasted) | Index (cold / warm) | Base Matches | Proto Matches | Lost / New | Speedup |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...comparisons.map(formatSummaryRow),
    '',
  ].join('\n')

  return `${header}\n${comparisons.map(formatCaseDetail).join('\n')}`
}
