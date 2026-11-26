import { describe, expect, it } from 'bun:test'
import {
  defaultDelay,
  fetchTransitPlan,
  OneMapAuthError,
  resolvePostalWorkplace,
  signInToOneMap,
} from '@lib/onemap-client.js'

const noopDelay = (): Promise<void> => Promise.resolve()

describe('onemap-client', () => {
  it('signs in with JSON credentials and never blames password on unreadable responses', async () => {
    await expect(signInToOneMap('', 'pass')).rejects.toThrow(
      'Enter your OneMap email and password.',
    )

    const okFetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: 'tok-1',
            expiry_timestamp: 1_900_000_000,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
    const account = await signInToOneMap('u@example.com', 'pass', okFetch)
    expect(account).toEqual({
      accessToken: 'tok-1',
      expiryTimestamp: 1_900_000_000,
    })

    const networkErrFetch = (): Promise<Response> =>
      Promise.reject(new TypeError('Failed to fetch'))
    await expect(
      signInToOneMap('u@example.com', 'pass', networkErrFetch),
    ).rejects.toThrow('Couldn’t sign in to OneMap.')

    const unreadableHtmlFetch = () =>
      Promise.resolve(
        new Response('<html>502 Bad Gateway</html>', { status: 502 }),
      )
    await expect(
      signInToOneMap('u@example.com', 'pass', unreadableHtmlFetch),
    ).rejects.toThrow('Couldn’t sign in to OneMap.')

    const missingTokenFetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      )
    await expect(
      signInToOneMap('u@example.com', 'pass', missingTokenFetch),
    ).rejects.toThrow('Couldn’t sign in to OneMap.')

    const badCredsFetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ error: 'Invalid credentials' }), {
          status: 401,
        }),
      )
    await expect(
      signInToOneMap('u@example.com', 'wrong', badCredsFetch),
    ).rejects.toThrow('Invalid email or password for OneMap.')
  })

  it('resolves exact postal code preserving leading zeros and rejects missing matches', async () => {
    let seenAuth = ''
    let seenUrl = ''
    const postalFetch = (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      seenUrl = String(input)
      seenAuth = new Headers(init?.headers).get('Authorization') ?? ''
      return Promise.resolve(
        new Response(
          JSON.stringify({
            results: [
              {
                POSTAL: '118989',
                LATITUDE: '1.2800',
                LONGITUDE: '103.8500',
                ADDRESS: 'WRONG ONE',
              },
              {
                POSTAL: '018989',
                LATITUDE: '1.2789',
                LONGITUDE: '103.8536',
                ADDRESS: '18 MARINA GARDENS DR',
              },
            ],
          }),
          { status: 200 },
        ),
      )
    }

    const wp = await resolvePostalWorkplace('018989', 'tok-1', postalFetch)
    expect(seenAuth).toBe('tok-1')
    expect(seenUrl).toContain('searchVal=018989')
    expect(wp.kind).toBe('postal')
    if (wp.kind === 'postal') {
      expect(wp.postalCode).toBe('018989')
      expect(wp.point.latitude).toBeCloseTo(1.2789, 4)
    }

    const notFoundFetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ results: [] }), { status: 200 }),
      )
    await expect(
      resolvePostalWorkplace('018989', 'tok-1', notFoundFetch),
    ).rejects.toThrow('No Singapore building matched postal code 018989.')

    const unauthFetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ error: 'Expired' }), { status: 401 }),
      )
    await expect(
      resolvePostalWorkplace('018989', 'tok-1', unauthFetch),
    ).rejects.toBeInstanceOf(OneMapAuthError)
  })

  it('handles routing 404, 401, Retry-After, network retries, and abortable delay', async () => {
    const baseOpts = {
      start: { latitude: 1.38, longitude: 103.89 },
      end: { latitude: 1.28, longitude: 103.85 },
      searchDate: '2026-06-02',
      departureTimeHHMMSS: '08:20:00',
      accessToken: 'tok-1',
      delayFn: noopDelay,
    }

    const emptyPlan = await fetchTransitPlan({
      ...baseOpts,
      fetchFn: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              error: 'No route found between the specified locations',
            }),
            { status: 404 },
          ),
        ),
    })
    expect(emptyPlan.itineraries).toEqual([])

    await expect(
      fetchTransitPlan({
        ...baseOpts,
        fetchFn: () =>
          Promise.resolve(
            new Response(JSON.stringify({ error: 'Unable to get MRT route' }), {
              status: 404,
            }),
          ),
      }),
    ).rejects.toThrow('OneMap routing returned 404')

    await expect(
      fetchTransitPlan({
        ...baseOpts,
        fetchFn: () =>
          Promise.resolve(
            new Response(JSON.stringify({ error: 'Unauthorized' }), {
              status: 401,
            }),
          ),
      }),
    ).rejects.toBeInstanceOf(OneMapAuthError)

    let attempts = 0
    const retried = await fetchTransitPlan({
      ...baseOpts,
      fetchFn: () => {
        attempts += 1
        if (attempts === 1) {
          return Promise.resolve(
            new Response(JSON.stringify({ error: 'Rate limited' }), {
              status: 429,
              headers: { 'Retry-After': '1' },
            }),
          )
        }
        if (attempts === 2) {
          return Promise.reject(new Error('Transient socket reset'))
        }
        return Promise.resolve(
          new Response(JSON.stringify({ plan: { itineraries: [{ id: 1 }] } }), {
            status: 200,
          }),
        )
      },
    })
    expect(attempts).toBe(3)
    expect(retried.itineraries).toHaveLength(1)

    const aborted = new AbortController()
    aborted.abort()
    await expect(defaultDelay(10, aborted.signal)).rejects.toThrow(
      'Search aborted',
    )
    await defaultDelay(1)
  })
})
