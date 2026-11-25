import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { runBackwardCommuteSearch } from '@lib/backward-search.js'
import {
  type BenchmarkCaseSpec,
  type BenchmarkRunMetrics,
  type CaseComparison,
  compareBenchmarkRuns,
  formatBenchmarkMarkdown,
} from '@lib/benchmark-report.js'
import type {
  OneMapAccount,
  Stop,
  StopInventory,
  Workplace,
} from '@lib/commute-types.js'
import { findRailStationById, parseStopInventory } from '@lib/inventory.js'
import {
  fetchTransitPlan,
  resolvePostalWorkplace,
  signInToOneMap,
} from '@lib/onemap-client.js'
import { runCommuteSearch } from '@lib/search-scheduler.js'
import {
  type BusRouterServiceEntry,
  buildTransitNetworkIndex,
  type GtfsScheduleFiles,
  haversineDistanceMeters,
  type TransitNetworkIndex,
} from '@lib/transit-network.js'
import { isRecord, parseJsonUnknown } from '@utils/guards.js'

const SEARCH_DATE = '2026-11-26'
const OFFICE_START = '09:00'
const INVENTORY_PATH = resolve(import.meta.dir, '../public/data/stops.tsv')
const DEFAULT_CACHE_DIR = resolve(
  import.meta.dir,
  '../node_modules/.cache/backward-commute-search',
)
const DEFAULT_OUT_DIR = resolve(
  import.meta.dir,
  '../.scratch/backward-commute-search',
)
const BUSROUTER_SERVICES_URL = 'https://data.busrouter.sg/v1/services.min.json'
const BUSROUTER_FIRSTLAST_URL =
  'https://data.busrouter.sg/v1/firstlast.min.json'

interface CliConfig {
  readonly mode: 'live' | 'replay'
  readonly skipFullIsland: boolean
  readonly minIntervalMs: number
  readonly primaryProtoSec: number
  readonly primaryBaseSec: number
  readonly otherProtoSec: number
  readonly otherBaseSec: number
  readonly cohortSize: number
  readonly cacheDir: string
  readonly outDir: string
  readonly gtfsTrainDir: string | null
}

interface ReplayCaseRecord {
  readonly caseSpec: BenchmarkCaseSpec
  readonly stops: readonly Stop[]
  readonly responses: Readonly<Record<string, readonly unknown[]>>
}

interface ReplayFixture {
  readonly version: 1
  readonly inventoryDate: string
  readonly searchDate: string
  readonly cases: readonly ReplayCaseRecord[]
}

const log = (line: string): void => {
  process.stdout.write(`${line}\n`)
}

const parseIntFlag = (value: string | undefined, fallback: number): number => {
  if (value === undefined) {
    return fallback
  }
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid integer CLI option: ${value}`)
  }
  return parsed
}

const collectCliFlags = (
  argv: readonly string[],
): ReadonlyMap<string, string> => {
  const flags = new Map<string, string>()
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg?.startsWith('--')) {
      continue
    }
    const next = argv[i + 1]
    const hasValue = next !== undefined && !next.startsWith('--')
    flags.set(arg.slice(2), hasValue ? next : 'true')
    if (hasValue) {
      i += 1
    }
  }
  return flags
}

const parseArgs = (argv: readonly string[]): CliConfig => {
  const flags = collectCliFlags(argv)
  const modeRaw = flags.get('mode') ?? 'live'
  if (modeRaw !== 'live' && modeRaw !== 'replay') {
    throw new Error(`Unsupported --mode ${modeRaw}`)
  }
  return {
    mode: modeRaw,
    skipFullIsland: flags.get('skip-full-island') === 'true',
    minIntervalMs: parseIntFlag(flags.get('min-interval-ms'), 250),
    primaryProtoSec: parseIntFlag(flags.get('primary-proto-sec'), 120),
    primaryBaseSec: parseIntFlag(flags.get('primary-base-sec'), 60),
    otherProtoSec: parseIntFlag(flags.get('other-proto-sec'), 30),
    otherBaseSec: parseIntFlag(flags.get('other-base-sec'), 20),
    cohortSize: parseIntFlag(flags.get('cohort-size'), 30),
    cacheDir: resolve(flags.get('cache-dir') ?? DEFAULT_CACHE_DIR),
    outDir: resolve(flags.get('out-dir') ?? DEFAULT_OUT_DIR),
    gtfsTrainDir: flags.get('gtfs-train-dir') ?? null,
  }
}

const parseBusServicesMap = (
  raw: unknown,
): Readonly<Record<string, BusRouterServiceEntry>> => {
  if (!isRecord(raw)) {
    throw new Error('Malformed busrouter services payload')
  }
  const result: Record<string, BusRouterServiceEntry> = {}
  for (const [serviceId, value] of Object.entries(raw)) {
    if (
      !isRecord(value) ||
      typeof value['name'] !== 'string' ||
      !Array.isArray(value['routes'])
    ) {
      continue
    }
    const routes = value['routes']
      .filter((r): r is readonly unknown[] => Array.isArray(r))
      .map((r) => r.filter((id): id is string => typeof id === 'string'))
    result[serviceId] = { name: value['name'], routes }
  }
  return result
}

const parseBusFirstLastMap = (
  raw: unknown,
): Readonly<Record<string, readonly string[]>> => {
  if (!isRecord(raw)) {
    throw new Error('Malformed busrouter firstlast payload')
  }
  const result: Record<string, readonly string[]> = {}
  for (const [stopId, value] of Object.entries(raw)) {
    if (Array.isArray(value)) {
      result[stopId] = value.filter(
        (item): item is string => typeof item === 'string',
      )
    }
  }
  return result
}

const isReplayCaseRecord = (value: unknown): value is ReplayCaseRecord =>
  isRecord(value) &&
  isRecord(value['caseSpec']) &&
  Array.isArray(value['stops']) &&
  isRecord(value['responses'])

const parseReplayFixture = (raw: unknown): ReplayFixture => {
  if (
    !isRecord(raw) ||
    raw['version'] !== 1 ||
    typeof raw['inventoryDate'] !== 'string' ||
    typeof raw['searchDate'] !== 'string' ||
    !Array.isArray(raw['cases'])
  ) {
    throw new Error('Malformed replay-fixture.json')
  }
  const cases = raw['cases'].filter(isReplayCaseRecord)
  return {
    version: 1,
    inventoryDate: raw['inventoryDate'],
    searchDate: raw['searchDate'],
    cases,
  }
}

const readOptionalGtfs = async (
  dir: string | null,
): Promise<GtfsScheduleFiles | undefined> => {
  if (!dir) {
    return undefined
  }
  const [routesTxt, calendarTxt, tripsTxt, stopTimesTxt] = await Promise.all([
    readFile(resolve(dir, 'routes.txt'), 'utf8'),
    readFile(resolve(dir, 'calendar.txt'), 'utf8'),
    readFile(resolve(dir, 'trips.txt'), 'utf8'),
    readFile(resolve(dir, 'stop_times.txt'), 'utf8'),
  ])
  return { routesTxt, calendarTxt, tripsTxt, stopTimesTxt }
}

const fetchJson = async (url: string): Promise<unknown> => {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Fetch failed for ${url}: HTTP ${String(response.status)}`)
  }
  return response.json()
}

const fileExists = async (path: string): Promise<boolean> => {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

const buildIndexFromRaw = (
  inventory: StopInventory,
  servicesRaw: unknown,
  firstLastRaw: unknown,
  gtfsTrain?: GtfsScheduleFiles,
): TransitNetworkIndex =>
  buildTransitNetworkIndex({
    inventory,
    networkDate: SEARCH_DATE,
    busServices: parseBusServicesMap(servicesRaw),
    busFirstLast: parseBusFirstLastMap(firstLastRaw),
    ...(gtfsTrain ? { gtfsTrain } : {}),
  })

const readWarmIndex = async (
  inventory: StopInventory,
  servicesPath: string,
  firstLastPath: string,
  gtfsTrain: GtfsScheduleFiles | undefined,
): Promise<{
  readonly networkIndex: TransitNetworkIndex
  readonly warmIndexMs: number
}> => {
  const warmStart = performance.now()
  const [cachedServices, cachedFirstLast] = await Promise.all([
    readFile(servicesPath, 'utf8').then(parseJsonUnknown),
    readFile(firstLastPath, 'utf8').then(parseJsonUnknown),
  ])
  const networkIndex = buildIndexFromRaw(
    inventory,
    cachedServices,
    cachedFirstLast,
    gtfsTrain,
  )
  return {
    networkIndex,
    warmIndexMs: Math.round((performance.now() - warmStart) * 100) / 100,
  }
}

const loadColdAndWarmIndex = async (
  inventory: StopInventory,
  cacheDir: string,
  gtfsTrainDir: string | null,
): Promise<{
  readonly networkIndex: TransitNetworkIndex
  readonly coldIndexMs: number
  readonly warmIndexMs: number
}> => {
  await mkdir(cacheDir, { recursive: true })
  const servicesPath = resolve(cacheDir, 'busrouter-services.min.json')
  const firstLastPath = resolve(cacheDir, 'busrouter-firstlast.min.json')
  const gtfsTrain = await readOptionalGtfs(gtfsTrainDir)

  const coldStart = performance.now()
  const [servicesRaw, firstLastRaw] = await Promise.all([
    fetchJson(BUSROUTER_SERVICES_URL),
    fetchJson(BUSROUTER_FIRSTLAST_URL),
  ])
  await Promise.all([
    writeFile(servicesPath, JSON.stringify(servicesRaw), 'utf8'),
    writeFile(firstLastPath, JSON.stringify(firstLastRaw), 'utf8'),
  ])
  buildIndexFromRaw(inventory, servicesRaw, firstLastRaw, gtfsTrain)
  const coldIndexMs = Math.round((performance.now() - coldStart) * 100) / 100

  const { networkIndex, warmIndexMs } = await readWarmIndex(
    inventory,
    servicesPath,
    firstLastPath,
    gtfsTrain,
  )
  return { networkIndex, coldIndexMs, warmIndexMs }
}

const loadWarmOrFetchIndex = async (
  inventory: StopInventory,
  cacheDir: string,
  gtfsTrainDir: string | null,
): Promise<{
  readonly networkIndex: TransitNetworkIndex
  readonly coldIndexMs: number
  readonly warmIndexMs: number
}> => {
  const servicesPath = resolve(cacheDir, 'busrouter-services.min.json')
  const firstLastPath = resolve(cacheDir, 'busrouter-firstlast.min.json')
  if ((await fileExists(servicesPath)) && (await fileExists(firstLastPath))) {
    const gtfsTrain = await readOptionalGtfs(gtfsTrainDir)
    const { networkIndex, warmIndexMs } = await readWarmIndex(
      inventory,
      servicesPath,
      firstLastPath,
      gtfsTrain,
    )
    return { networkIndex, coldIndexMs: warmIndexMs, warmIndexMs }
  }
  return loadColdAndWarmIndex(inventory, cacheDir, gtfsTrainDir)
}

const createTimedAbort = (
  budgetSec: number,
): {
  readonly controller: AbortController
  readonly cleanup: () => void
} => {
  const controller = new AbortController()
  if (budgetSec <= 0) {
    return { controller, cleanup: () => {} }
  }
  const timer = setTimeout(() => controller.abort(), budgetSec * 1000)
  return { controller, cleanup: () => clearTimeout(timer) }
}

type RouteStopFn = (
  stop: Stop,
  dep: string,
  signal: AbortSignal,
) => Promise<readonly unknown[]>

interface MeasureRunOptions {
  readonly inventory: StopInventory
  readonly caseSpec: BenchmarkCaseSpec
  readonly routeStop: RouteStopFn
  readonly minIntervalMs: number
  readonly budgetSec: number
}

const runMeasuredBaseline = async (
  opts: MeasureRunOptions,
): Promise<BenchmarkRunMetrics> => {
  const requestsByStop = new Map<string, number>()
  let requestCount = 0
  const { controller, cleanup } = createTimedAbort(opts.budgetSec)
  const startedAt = performance.now()
  try {
    const res = await runCommuteSearch({
      inventory: opts.inventory,
      workplace: opts.caseSpec.workplace,
      constraints: opts.caseSpec.constraints,
      minRequestIntervalMs: opts.minIntervalMs,
      signal: controller.signal,
      routeStop: (stop, dep, signal) => {
        requestCount += 1
        requestsByStop.set(stop.id, (requestsByStop.get(stop.id) ?? 0) + 1)
        return opts.routeStop(stop, dep, signal)
      },
      onProgress: () => {},
    })
    const matchedIds = new Set(res.matches.map((m) => m.stop.id))
    let wasted = 0
    for (const [id, count] of requestsByStop.entries()) {
      if (!matchedIds.has(id)) {
        wasted += count
      }
    }
    return {
      algorithm: 'baseline',
      status: res.status,
      authExpired: res.authExpired,
      inventoryDate: opts.inventory.inventoryDate,
      elapsedMs: Math.round((performance.now() - startedAt) * 100) / 100,
      requestCount,
      wastedRequestCount: wasted,
      failedQueries: res.failedQueries,
      triedCount: res.triedCount,
      totalCount: res.totalCount,
      matches: res.matches,
    }
  } finally {
    cleanup()
  }
}

interface MeasurePrototypeOptions extends MeasureRunOptions {
  readonly networkIndex: TransitNetworkIndex
  readonly coldIndexMs: number
  readonly warmIndexMs: number
}

const runMeasuredPrototype = async (
  opts: MeasurePrototypeOptions,
): Promise<BenchmarkRunMetrics> => {
  const { controller, cleanup } = createTimedAbort(opts.budgetSec)
  const startedAt = performance.now()
  try {
    const res = await runBackwardCommuteSearch({
      inventory: opts.inventory,
      networkIndex: opts.networkIndex,
      workplace: opts.caseSpec.workplace,
      constraints: opts.caseSpec.constraints,
      minRequestIntervalMs: opts.minIntervalMs,
      signal: controller.signal,
      routeStop: opts.routeStop,
      onProgress: () => {},
    })
    return {
      algorithm: 'backward-prototype',
      status: res.status,
      authExpired: res.authExpired,
      inventoryDate: opts.inventory.inventoryDate,
      networkDate: opts.networkIndex.networkDate,
      coldIndexMs: opts.coldIndexMs,
      warmIndexMs: opts.warmIndexMs,
      planMs: res.planElapsedMs,
      elapsedMs: Math.round((performance.now() - startedAt) * 100) / 100,
      requestCount: res.requestCount,
      wastedRequestCount: res.wastedRequestCount,
      failedQueries: res.failedQueries,
      triedCount: res.triedCount,
      totalCount: res.totalCount,
      candidateStopCount: res.candidateStopCount,
      prunedStopCount: res.prunedStopCount,
      uncoveredStopCount: res.uncoveredStopCount,
      matches: res.matches,
    }
  } finally {
    cleanup()
  }
}

const buildMultiRegionCohort = (
  inventory: StopInventory,
  workplace: Workplace,
  cohortSize: number,
): readonly Stop[] => {
  const withDist = inventory.stops
    .map((stop) => ({
      stop,
      distM: haversineDistanceMeters(stop.point, workplace.point),
    }))
    .sort((a, b) => a.distM - b.distM)

  const selected = new Map<string, Stop>()
  const addStop = (stop: Stop | undefined): void => {
    if (stop && selected.size < cohortSize) {
      selected.set(stop.id, stop)
    }
  }

  if (workplace.kind === 'station') {
    addStop(findRailStationById(inventory, workplace.stationId) ?? undefined)
  }
  const buckets = [
    withDist.filter((x) => x.stop.kind === 'rail' && x.distM <= 8000),
    withDist.filter((x) => x.stop.kind === 'bus' && x.distM <= 3000),
    withDist.filter(
      (x) => x.stop.kind === 'rail' && x.distM > 8000 && x.distM <= 18_000,
    ),
    withDist.filter(
      (x) => x.stop.kind === 'bus' && x.distM > 3000 && x.distM <= 12_000,
    ),
    withDist.filter((x) => x.distM > 22_000),
  ]

  let cursor = 0
  while (selected.size < cohortSize && cursor < 20) {
    for (const bucket of buckets) {
      const idx = Math.min(
        bucket.length - 1,
        Math.floor((cursor * Math.max(1, bucket.length)) / 8),
      )
      addStop(bucket[idx]?.stop)
    }
    cursor += 1
  }
  return [...selected.values()]
}

const compactLeg = (leg: unknown): unknown => {
  if (!isRecord(leg)) {
    return leg
  }
  const { legGeometry: _g, steps: _s, ...rest } = leg
  return rest
}

const compactItinerary = (itinerary: unknown): unknown => {
  if (!isRecord(itinerary)) {
    return itinerary
  }
  const legs = Array.isArray(itinerary['legs'])
    ? itinerary['legs'].map(compactLeg)
    : itinerary['legs']
  return { ...itinerary, legs }
}

const makeRecordingRouteStop =
  (
    account: OneMapAccount,
    workplace: Workplace,
    searchDate: string,
    recordedResponses: Map<string, readonly unknown[]>,
  ): RouteStopFn =>
  async (stop, departureTimeHHMMSS, signal) => {
    const key = `${stop.id}@${departureTimeHHMMSS}`
    const plan = await fetchTransitPlan({
      start: stop.point,
      end: workplace.point,
      searchDate,
      departureTimeHHMMSS,
      accessToken: account.accessToken,
      signal,
    })
    const compacted = plan.itineraries.map(compactItinerary)
    recordedResponses.set(key, compacted)
    return compacted
  }

const buildBenchmarkCases = async (
  inventory: StopInventory,
  account: OneMapAccount,
): Promise<readonly BenchmarkCaseSpec[]> => {
  const postalWorkplace = await resolvePostalWorkplace(
    '828616',
    account.accessToken,
  )
  const ns17 = findRailStationById(inventory, 'NS17')
  if (!ns17) {
    throw new Error('NS17 Bishan missing from stop inventory')
  }
  const stationWorkplace: Workplace = {
    kind: 'station',
    stationId: ns17.id,
    label: `${ns17.id} ${ns17.name}`,
    point: ns17.point,
  }

  return [
    {
      caseId: 'postal-828616-30m',
      label: 'Postal 828616 (30m ride cap, primary)',
      workplace: postalWorkplace,
      constraints: {
        searchDate: SEARCH_DATE,
        officeStart: OFFICE_START,
        rideCapMinutes: 30,
      },
    },
    {
      caseId: 'postal-828616-60m',
      label: 'Postal 828616 (60m ride cap)',
      workplace: postalWorkplace,
      constraints: {
        searchDate: SEARCH_DATE,
        officeStart: OFFICE_START,
        rideCapMinutes: 60,
      },
    },
    {
      caseId: 'station-NS17-20m',
      label: 'Station NS17 Bishan (20m ride cap)',
      workplace: stationWorkplace,
      constraints: {
        searchDate: SEARCH_DATE,
        officeStart: OFFICE_START,
        rideCapMinutes: 20,
      },
    },
    {
      caseId: 'station-NS17-45m',
      label: 'Station NS17 Bishan (45m ride cap)',
      workplace: stationWorkplace,
      constraints: {
        searchDate: SEARCH_DATE,
        officeStart: OFFICE_START,
        rideCapMinutes: 45,
      },
    },
  ]
}

interface LiveRunnerContext {
  readonly inventory: StopInventory
  readonly networkIndex: TransitNetworkIndex
  readonly account: OneMapAccount
  readonly config: CliConfig
  readonly coldIndexMs: number
  readonly warmIndexMs: number
}

const runFullIslandLive = async (
  ctx: LiveRunnerContext,
  cases: readonly BenchmarkCaseSpec[],
): Promise<readonly CaseComparison[]> => {
  const comparisons: CaseComparison[] = []
  for (let idx = 0; idx < cases.length; idx += 1) {
    const caseSpec = cases[idx]
    if (!caseSpec) {
      continue
    }
    const isPrimary = idx === 0
    const protoSec = isPrimary
      ? ctx.config.primaryProtoSec
      : ctx.config.otherProtoSec
    const baseSec = isPrimary
      ? ctx.config.primaryBaseSec
      : ctx.config.otherBaseSec
    const cache = new Map<string, readonly unknown[]>()
    const routeStop = makeRecordingRouteStop(
      ctx.account,
      caseSpec.workplace,
      caseSpec.constraints.searchDate,
      cache,
    )

    log(
      `[full-island] ${caseSpec.caseId}: prototype (${String(protoSec)}s) + baseline (${String(baseSec)}s)...`,
    )
    const prototype = await runMeasuredPrototype({
      inventory: ctx.inventory,
      networkIndex: ctx.networkIndex,
      caseSpec,
      routeStop,
      minIntervalMs: ctx.config.minIntervalMs,
      budgetSec: protoSec,
      coldIndexMs: ctx.coldIndexMs,
      warmIndexMs: ctx.warmIndexMs,
    })
    const baseline = await runMeasuredBaseline({
      inventory: ctx.inventory,
      caseSpec,
      routeStop,
      minIntervalMs: ctx.config.minIntervalMs,
      budgetSec: baseSec,
    })
    comparisons.push(
      compareBenchmarkRuns(caseSpec, baseline, prototype, ctx.inventory),
    )
  }
  return comparisons
}

const runLiveCohorts = async (
  ctx: LiveRunnerContext,
  cases: readonly BenchmarkCaseSpec[],
): Promise<{
  readonly comparisons: readonly CaseComparison[]
  readonly replayCases: readonly ReplayCaseRecord[]
}> => {
  const cohortCases = cases.filter(
    (c) => c.caseId === 'postal-828616-30m' || c.caseId === 'station-NS17-20m',
  )
  const comparisons: CaseComparison[] = []
  const replayCases: ReplayCaseRecord[] = []

  for (const caseSpec of cohortCases) {
    const cohortStops = buildMultiRegionCohort(
      ctx.inventory,
      caseSpec.workplace,
      ctx.config.cohortSize,
    )
    const subInventory: StopInventory = {
      inventoryDate: ctx.inventory.inventoryDate,
      stops: cohortStops,
    }
    const cache = new Map<string, readonly unknown[]>()
    const routeStop = makeRecordingRouteStop(
      ctx.account,
      caseSpec.workplace,
      caseSpec.constraints.searchDate,
      cache,
    )

    log(
      `[cohort] ${caseSpec.caseId} (${String(cohortStops.length)} stops): completed baseline + prototype...`,
    )
    const baseline = await runMeasuredBaseline({
      inventory: subInventory,
      caseSpec,
      routeStop,
      minIntervalMs: ctx.config.minIntervalMs,
      budgetSec: 0,
    })
    const prototype = await runMeasuredPrototype({
      inventory: subInventory,
      networkIndex: ctx.networkIndex,
      caseSpec,
      routeStop,
      minIntervalMs: ctx.config.minIntervalMs,
      budgetSec: 0,
      coldIndexMs: ctx.coldIndexMs,
      warmIndexMs: ctx.warmIndexMs,
    })
    comparisons.push(
      compareBenchmarkRuns(caseSpec, baseline, prototype, subInventory),
    )
    replayCases.push({
      caseSpec,
      stops: cohortStops,
      responses: Object.fromEntries(cache.entries()),
    })
  }
  return { comparisons, replayCases }
}

const runReplayMode = async (
  config: CliConfig,
  fullInventory: StopInventory,
  networkIndex: TransitNetworkIndex,
  coldIndexMs: number,
  warmIndexMs: number,
): Promise<void> => {
  const fixturePath = resolve(config.cacheDir, 'replay-fixture.json')
  const fixture = parseReplayFixture(
    parseJsonUnknown(await readFile(fixturePath, 'utf8')),
  )

  const comparisons: CaseComparison[] = []
  const missingCounts: Record<string, number> = {}

  for (const rec of fixture.cases) {
    const subInventory: StopInventory = {
      inventoryDate: fixture.inventoryDate,
      stops: rec.stops,
    }
    const missingKeys: string[] = []
    const replayRouteStop: RouteStopFn = (stop, dep) => {
      const key = `${stop.id}@${dep}`
      const hit = rec.responses[key]
      if (hit === undefined) {
        missingKeys.push(key)
        return Promise.reject(new Error(`Missing replay response for ${key}`))
      }
      return Promise.resolve(hit)
    }

    const baseline = await runMeasuredBaseline({
      inventory: subInventory,
      caseSpec: rec.caseSpec,
      routeStop: replayRouteStop,
      minIntervalMs: 0,
      budgetSec: 0,
    })
    const prototype = await runMeasuredPrototype({
      inventory: subInventory,
      networkIndex,
      caseSpec: rec.caseSpec,
      routeStop: replayRouteStop,
      minIntervalMs: 0,
      budgetSec: 0,
      coldIndexMs,
      warmIndexMs,
    })
    missingCounts[rec.caseSpec.caseId] = missingKeys.length
    comparisons.push(
      compareBenchmarkRuns(rec.caseSpec, baseline, prototype, subInventory),
    )
  }

  const md = [
    formatBenchmarkMarkdown(
      comparisons,
      'Backward Commute Search: Credential-Free Replay Report',
    ),
    '## Replay Integrity',
    '',
    `- Full inventory loaded: ${fullInventory.inventoryDate} (${String(fullInventory.stops.length)} stops)`,
    `- Missing recorded responses per case (treated as errors, never negative routes): ${JSON.stringify(missingCounts)}`,
    '',
  ].join('\n')

  await writeFile(resolve(config.outDir, 'replay-report.md'), md, 'utf8')
  log(`Replay complete. Missing responses: ${JSON.stringify(missingCounts)}`)
  log(`Wrote ${resolve(config.outDir, 'replay-report.md')}`)
}

const buildDecisionGateSection = (
  fullIsland: readonly CaseComparison[],
  cohorts: readonly CaseComparison[],
): string => {
  const lostTotal = cohorts.reduce((sum, c) => sum + c.lostMatches.length, 0)
  const newTotal = cohorts.reduce((sum, c) => sum + c.newMatches.length, 0)
  const lostIds = cohorts.flatMap((c) => c.lostMatches.map((m) => m.stop.id))
  const primaryFull = fullIsland[0]
  const cohortNote =
    lostTotal === 0
      ? 'Zero baseline matches lost across all paired completed cohorts.'
      : `Lost cohort stop IDs: ${lostIds.join(', ')}.`

  const lines = [
    '## Decision Gate Verdict',
    '',
    '- **Production search status**: **Unchanged** (prototype-only evaluation; no application, UI, scheduler, or saved-result schema changes).',
    `- **Completed cohort coverage**: ${String(lostTotal)} baseline match(es) lost, ${String(newTotal)} newly discovered match(es) across ${String(cohorts.length)} paired multi-region completed cohorts. ${cohortNote}`,
  ]
  if (primaryFull) {
    lines.push(
      `- **Primary full-island planning**: candidate stops=${String(primaryFull.prototype.candidateStopCount ?? 0)}, pruned stops=${String(primaryFull.prototype.prunedStopCount ?? 0)}, uncovered stops=${String(primaryFull.prototype.uncoveredStopCount ?? 0)}, planMs=${String(primaryFull.prototype.planMs ?? 0)}ms.`,
    )
  }
  lines.push(
    '- **Estimated-data pruning tradeoff**: Bus travel uses `busrouter.sg` first/last windows + speed bounds (`minRideMs`) rather than scheduled timetables, and rail uses topology speed bounds unless LTA `GTFSScheduleTrain` is supplied. While every reported match is strictly verified by OneMap and `evaluateBoardings`, pruning stops solely via estimated `minRideMs` / transfer bounds trades formal completeness guarantees for speed unless `LTA_ACCOUNT_KEY` (`GTFSScheduleTrain`) or wider bounds are configured.',
    '',
  )
  return lines.join('\n')
}

const runLiveMode = async (
  config: CliConfig,
  inventory: StopInventory,
): Promise<void> => {
  const email = process.env['ONEMAP_USERNAME'] ?? ''
  const password = process.env['ONEMAP_PASSWORD'] ?? ''
  if (email.trim().length === 0 || password.length === 0) {
    throw new Error(
      'ONEMAP_USERNAME and ONEMAP_PASSWORD must be set in environment for --mode live',
    )
  }
  const account = await signInToOneMap(email, password)
  const { networkIndex, coldIndexMs, warmIndexMs } = await loadColdAndWarmIndex(
    inventory,
    config.cacheDir,
    config.gtfsTrainDir,
  )
  log(
    `Index ready: cold=${String(coldIndexMs)}ms, warm=${String(warmIndexMs)}ms, patterns=${String(networkIndex.patterns.length)}, transfers=${String(networkIndex.transfers.length)}, covered=${String(networkIndex.coveredStopIds.length)}/${String(inventory.stops.length)}`,
  )

  const cases = await buildBenchmarkCases(inventory, account)
  const ctx: LiveRunnerContext = {
    inventory,
    networkIndex,
    account,
    config,
    coldIndexMs,
    warmIndexMs,
  }
  const fullIsland = config.skipFullIsland
    ? []
    : await runFullIslandLive(ctx, cases)
  const { comparisons: cohorts, replayCases } = await runLiveCohorts(ctx, cases)

  const replayFixture: ReplayFixture = {
    version: 1,
    inventoryDate: inventory.inventoryDate,
    searchDate: SEARCH_DATE,
    cases: replayCases,
  }
  const sections: string[] = []
  if (fullIsland.length > 0) {
    sections.push(
      formatBenchmarkMarkdown(
        fullIsland,
        'Full-Island Live Benchmark (5,426 stops, time-bounded where noted)',
      ),
    )
  }
  sections.push(
    formatBenchmarkMarkdown(
      cohorts,
      'Completed Paired Multi-Region Live Cohorts (identical provider pacing)',
    ),
    buildDecisionGateSection(fullIsland, cohorts),
  )
  const reportMd = sections.join('\n')

  await mkdir(config.cacheDir, { recursive: true })
  await Promise.all([
    writeFile(
      resolve(config.cacheDir, 'replay-fixture.json'),
      JSON.stringify(replayFixture),
      'utf8',
    ),
    writeFile(
      resolve(config.outDir, 'benchmark-results.json'),
      JSON.stringify({ fullIsland, cohorts }, null, 2),
      'utf8',
    ),
    writeFile(resolve(config.outDir, 'benchmark-report.md'), reportMd, 'utf8'),
  ])
  log(
    `Wrote benchmark report to ${resolve(config.outDir, 'benchmark-report.md')}`,
  )
}

const main = async (): Promise<void> => {
  const config = parseArgs(process.argv.slice(2))
  const inventory = parseStopInventory(await readFile(INVENTORY_PATH, 'utf8'))
  await mkdir(config.outDir, { recursive: true })

  if (config.mode === 'replay') {
    const idx = await loadWarmOrFetchIndex(
      inventory,
      config.cacheDir,
      config.gtfsTrainDir,
    )
    await runReplayMode(
      config,
      inventory,
      idx.networkIndex,
      idx.coldIndexMs,
      idx.warmIndexMs,
    )
    return
  }

  await runLiveMode(config, inventory)
}

await main()
