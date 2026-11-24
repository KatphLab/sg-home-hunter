import type {
  Coordinates,
  OneMapAccount,
  Workplace,
} from '@lib/commute-types.js'
import {
  isNonEmptyString,
  isRecord,
  normalizeError,
  parseJsonUnknown,
} from '@utils/guards.js'

const ONEMAP_BASE_URL = 'https://www.onemap.gov.sg'

const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([
  429, 500, 502, 503, 504,
])
const NO_ROUTE_MESSAGES: ReadonlySet<string> = new Set([
  'No route found between the specified locations',
  'No bus route found between the specified locations',
])
const MAX_RETRIES = 3

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

export type DelayLike = (ms: number, signal?: AbortSignal) => Promise<void>

export class OneMapAuthError extends Error {
  constructor(message = 'Your OneMap session expired. Sign in again.') {
    super(message)
    this.name = 'OneMapAuthError'
  }
}

export const defaultDelay: DelayLike = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Search aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('Search aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })

const readJsonSafely = async (response: Response): Promise<unknown> => {
  try {
    const text = await response.text()
    if (text.trim().length === 0) {
      return null
    }
    return parseJsonUnknown(text)
  } catch {
    return null
  }
}

const isExplicitCredentialError = (
  status: number,
  payload: unknown,
): boolean => {
  if (status !== 400 && status !== 401) {
    return false
  }
  if (!isRecord(payload)) {
    return false
  }
  const rawErr = payload['error'] ?? payload['message']
  if (typeof rawErr !== 'string') {
    return false
  }
  const lower = rawErr.toLowerCase()
  return (
    lower.includes('invalid') ||
    lower.includes('password') ||
    lower.includes('credential') ||
    lower.includes('email')
  )
}

export const signInToOneMap = async (
  email: string,
  password: string,
  fetchFn: FetchLike = globalThis.fetch,
  signal?: AbortSignal,
): Promise<OneMapAccount> => {
  const trimmedEmail = email.trim()
  if (trimmedEmail.length === 0 || password.length === 0) {
    throw new Error('Enter your OneMap email and password.')
  }

  let response: Response
  try {
    response = await fetchFn(`${ONEMAP_BASE_URL}/api/auth/post/getToken`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ email: trimmedEmail, password }),
      signal: signal ?? null,
    })
  } catch {
    throw new Error('Couldn’t sign in to OneMap.')
  }

  const payload = await readJsonSafely(response)
  if (!response.ok) {
    if (isExplicitCredentialError(response.status, payload)) {
      throw new Error('Invalid email or password for OneMap.')
    }
    throw new Error('Couldn’t sign in to OneMap.')
  }

  if (
    !isRecord(payload) ||
    !isNonEmptyString(payload['access_token']) ||
    (typeof payload['expiry_timestamp'] !== 'number' &&
      typeof payload['expiry_timestamp'] !== 'string')
  ) {
    throw new Error('Couldn’t sign in to OneMap.')
  }

  const expiry = Number(payload['expiry_timestamp'])
  return {
    email: trimmedEmail,
    accessToken: payload['access_token'],
    expiryTimestamp: Number.isFinite(expiry) ? expiry : 0,
  }
}

export const resolvePostalWorkplace = async (
  postalCode: string,
  accessToken: string,
  fetchFn: FetchLike = globalThis.fetch,
  signal?: AbortSignal,
): Promise<Workplace> => {
  const params = new URLSearchParams({
    searchVal: postalCode,
    returnGeom: 'Y',
    getAddrDetails: 'Y',
    pageNum: '1',
  })
  const response = await fetchFn(
    `${ONEMAP_BASE_URL}/api/common/elastic/search?${params.toString()}`,
    {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: accessToken,
      },
      signal: signal ?? null,
    },
  )

  if (response.status === 401) {
    throw new OneMapAuthError()
  }
  if (!response.ok) {
    throw new Error(
      `OneMap postal lookup failed (HTTP ${String(response.status)}).`,
    )
  }

  const payload = await readJsonSafely(response)
  if (!isRecord(payload) || !Array.isArray(payload['results'])) {
    throw new Error('OneMap returned an unexpected postal lookup response.')
  }

  for (const row of payload['results']) {
    if (!isRecord(row) || row['POSTAL'] !== postalCode) {
      continue
    }
    const latitude = Number(row['LATITUDE'])
    const longitude = Number(row['LONGITUDE'])
    const address = row['ADDRESS']
    if (
      Number.isFinite(latitude) &&
      Number.isFinite(longitude) &&
      isNonEmptyString(address)
    ) {
      return {
        kind: 'postal',
        postalCode,
        label: address.trim(),
        point: { latitude, longitude },
      }
    }
  }

  throw new Error(`No Singapore building matched postal code ${postalCode}.`)
}

const formatOneMapDate = (isoDate: string): string => {
  const [year = '', month = '', day = ''] = isoDate.split('-')
  return `${month}-${day}-${year}`
}

const getRetryWaitMs = (attempt: number, response?: Response): number => {
  const retryAfter = response?.headers.get('Retry-After')
  if (retryAfter) {
    const parsed = Number(retryAfter)
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.min(parsed * 1000, 15_000)
    }
  }
  return 1000 * 2 ** attempt
}

const buildRoutingUrl = (
  start: Coordinates,
  end: Coordinates,
  searchDate: string,
  departureTimeHHMMSS: string,
): string => {
  const params = new URLSearchParams({
    start: `${String(start.latitude)},${String(start.longitude)}`,
    end: `${String(end.latitude)},${String(end.longitude)}`,
    routeType: 'pt',
    mode: 'TRANSIT',
    date: formatOneMapDate(searchDate),
    time: departureTimeHHMMSS,
    numItineraries: '3',
  })
  return `${ONEMAP_BASE_URL}/api/public/routingsvc/route?${params.toString()}`
}

const extractRoutingErrorText = (payload: unknown): string | null => {
  if (!isRecord(payload)) {
    return null
  }
  const err = payload['error'] ?? payload['message']
  return typeof err === 'string' ? err.trim() : null
}

export interface TransitPlanResult {
  readonly itineraries: readonly unknown[]
}

const parsePlanPayload = (payload: unknown): TransitPlanResult => {
  if (!isRecord(payload) || !isRecord(payload['plan'])) {
    throw new Error('Malformed OneMap route response: missing plan')
  }
  const itineraries = payload['plan']['itineraries']
  if (!Array.isArray(itineraries)) {
    throw new Error('Malformed OneMap route response: missing itineraries')
  }
  return { itineraries }
}

export interface FetchTransitPlanOptions {
  readonly start: Coordinates
  readonly end: Coordinates
  readonly searchDate: string
  readonly departureTimeHHMMSS: string
  readonly accessToken: string
  readonly fetchFn?: FetchLike
  readonly signal?: AbortSignal
  readonly delayFn?: DelayLike
}

const attemptFetch = async (
  url: string,
  accessToken: string,
  fetchFn: FetchLike,
  signal: AbortSignal | undefined,
): Promise<{ readonly response?: Response; readonly error?: Error }> => {
  try {
    const response = await fetchFn(url, {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: accessToken },
      signal: signal ?? null,
    })
    return { response }
  } catch (error) {
    return {
      error: normalizeError(error, 'Network error while querying OneMap'),
    }
  }
}

const fetchWithRetry = async (
  url: string,
  accessToken: string,
  fetchFn: FetchLike,
  signal: AbortSignal | undefined,
  delayFn: DelayLike,
): Promise<Response> => {
  let lastError: Error = new Error('OneMap routing request failed')
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const outcome = await attemptFetch(url, accessToken, fetchFn, signal)
    if (outcome.response) {
      if (
        !RETRYABLE_STATUSES.has(outcome.response.status) ||
        attempt === MAX_RETRIES
      ) {
        return outcome.response
      }
      await delayFn(getRetryWaitMs(attempt, outcome.response), signal)
      continue
    }
    lastError = outcome.error ?? lastError
    if (signal?.aborted || attempt === MAX_RETRIES) {
      throw lastError
    }
    await delayFn(getRetryWaitMs(attempt), signal)
  }
  throw lastError
}

export const fetchTransitPlan = async (
  options: FetchTransitPlanOptions,
): Promise<TransitPlanResult> => {
  const {
    start,
    end,
    searchDate,
    departureTimeHHMMSS,
    accessToken,
    fetchFn = globalThis.fetch,
    signal,
    delayFn = defaultDelay,
  } = options
  const url = buildRoutingUrl(start, end, searchDate, departureTimeHHMMSS)
  const response = await fetchWithRetry(
    url,
    accessToken,
    fetchFn,
    signal,
    delayFn,
  )

  if (response.status === 401) {
    throw new OneMapAuthError()
  }

  const payload = await readJsonSafely(response)
  if (response.status === 404) {
    const errText = extractRoutingErrorText(payload)
    if (errText !== null && NO_ROUTE_MESSAGES.has(errText)) {
      return { itineraries: [] }
    }
    throw new Error('OneMap routing returned 404')
  }

  if (!response.ok) {
    throw new Error(`OneMap routing failed (HTTP ${String(response.status)})`)
  }

  return parsePlanPayload(payload)
}
