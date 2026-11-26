import { expect, type Page, type Route, test } from '@playwright/test'

const TEST_INVENTORY_TSV = [
  'inventoryDate\t2026-11-20',
  'id\tkind\tname\tlatitude\tlongitude',
  '03218\tbus\tMarina Gardens Opp\t1.279100\t103.854000',
  '44009\tbus\tBukit Panjang Ring\t1.382000\t103.760000',
  '44011\tbus\tBlk 418 Fajar\t1.388000\t103.765000',
  '65009\tbus\tPunggol Temp Int\t1.403600\t103.902200',
  '88888\tbus\tChangi Village\t1.389000\t103.988000',
  '88889\tbus\tChangi Ferry\t1.390000\t103.990000',
  'CC15\trail\tBishan\t1.351400\t103.848200',
  'CC16\trail\tMarymount\t1.348700\t103.839400',
  'NS17\trail\tBishan\t1.351400\t103.848200',
].join('\n')

const TEST_NETWORK_TSV = [
  'networkDate\t2026-11-20',
  'service\tdirection\tvisits',
  '972\t1\t44009 0530 2330 0530 2330 0530 2330|03218 0552 2352 0552 2352 0552 2352',
  '922\t1\t44011 0530 2330 0530 2330 0530 2330|03218 0552 2352 0552 2352 0552 2352',
  '116\t1\t65009 0530 2330 0530 2330 0530 2330|03218 0552 2352 0552 2352 0552 2352',
  '50\t1\t65009 0530 2330 0530 2330 0530 2330|NS17 0545 2345 0545 2345 0545 2345',
  '999\t1\t88888 0530 2330 0530 2330 0530 2330|88889 0535 2335 0535 2335 0535 2335',
].join('\n')

const EMPTY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)

const sgtIsoMs = (clock: string): number =>
  Date.parse(`2026-06-02T${clock}:00+08:00`)

const makeItinerary = (
  boardStopCode: string,
  boardClock: string,
  arriveClock: string,
  services: readonly {
    readonly mode: string
    readonly routeShortName: string
    readonly boardMs: number
    readonly endMs: number
  }[],
  finalWalkMs = 0,
) => {
  const startTime = sgtIsoMs(boardClock)
  const endTime = sgtIsoMs(arriveClock)
  const legs: unknown[] = services.map((svc, idx) => ({
    mode: svc.mode,
    startTime: svc.boardMs,
    endTime: svc.endMs,
    from: { stopCode: idx === 0 ? boardStopCode : 'NS17' },
    routeShortName: svc.routeShortName,
    routeId: svc.routeShortName,
  }))
  if (finalWalkMs > 0 && services.length > 0) {
    const lastEnd = services.at(-1)?.endMs ?? endTime - finalWalkMs
    legs.push({
      mode: 'WALK',
      startTime: lastEnd,
      endTime,
    })
  }
  return {
    startTime,
    endTime,
    walkLimitExceeded: false,
    legs,
  }
}

const fulfillJson = (route: Route, status: number, body: unknown) =>
  route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })

// Service Worker (`sw.js`) fetches bypass `page.route(...)`, so use `page.context().route(...)`.
const stubTilesAndInventory = async (page: Page): Promise<void> => {
  await page
    .context()
    .route('**/maps/tiles/**', (route) =>
      route.fulfill({ status: 200, contentType: 'image/png', body: EMPTY_PNG }),
    )
  await page.context().route('**/data/stops.tsv', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/tab-separated-values; charset=utf-8',
      body: TEST_INVENTORY_TSV,
    }),
  )
  await page.context().route('**/data/bus-network.tsv', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/tab-separated-values; charset=utf-8',
      body: TEST_NETWORK_TSV,
    }),
  )
}

const handlePostalSearchRoute = async (
  route: Route,
  pass2Gate: Promise<void>,
  attemptsByStart: Map<string, number>,
): Promise<void> => {
  const url = new URL(route.request().url())
  const start = url.searchParams.get('start') ?? ''
  const attempt = (attemptsByStart.get(start) ?? 0) + 1
  attemptsByStart.set(start, attempt)

  if (attempt === 1 && start.startsWith('1.382')) {
    await fulfillJson(route, 200, {
      plan: {
        itineraries: [
          makeItinerary('44009', '08:25', '08:52', [
            {
              mode: 'BUS',
              routeShortName: '972',
              boardMs: sgtIsoMs('08:25'),
              endMs: sgtIsoMs('08:52'),
            },
          ]),
        ],
      },
    })
    return
  }

  if (attempt === 1 && start.startsWith('1.388')) {
    await fulfillJson(route, 200, {
      plan: {
        itineraries: [
          makeItinerary('44011', '08:27', '08:55', [
            {
              mode: 'BUS',
              routeShortName: '922',
              boardMs: sgtIsoMs('08:27'),
              endMs: sgtIsoMs('08:55'),
            },
          ]),
        ],
      },
    })
    return
  }

  if (attempt === 2 && start.startsWith('1.4036')) {
    await pass2Gate
    await fulfillJson(route, 200, {
      plan: {
        itineraries: [
          makeItinerary(
            '65009',
            '08:25',
            '08:58',
            [
              {
                mode: 'BUS',
                routeShortName: '116',
                boardMs: sgtIsoMs('08:25'),
                endMs: sgtIsoMs('08:38'),
              },
              {
                mode: 'SUBWAY',
                routeShortName: 'NS',
                boardMs: sgtIsoMs('08:42'),
                endMs: sgtIsoMs('08:54'),
              },
            ],
            4 * 60_000,
          ),
        ],
      },
    })
    return
  }

  await fulfillJson(route, 200, { plan: { itineraries: [] } })
}

const signInViaUi = async (page: Page): Promise<void> => {
  await page.fill('#onemap-email', 'commuter@example.com')
  await page.fill('#onemap-password', 'test-pass')
  await page.click('#signin-btn')
  await expect(page.locator('#signed-in-email')).toHaveText(
    'commuter@example.com',
  )
}

test.describe('House Hunter PWA acceptance', () => {
  test.beforeEach(async ({ page, context }) => {
    await stubTilesAndInventory(page)
    await context.route('**/api/auth/post/getToken', (route) =>
      fulfillJson(route, 200, {
        access_token: 'mock-jwt',
        expiry_timestamp: 1_900_000_000,
      }),
    )
    await context.route('**/api/common/elastic/search*', (route) => {
      const postal = new URL(route.request().url()).searchParams.get(
        'searchVal',
      )
      const address = {
        POSTAL: '018989',
        LATITUDE: '1.2789',
        LONGITUDE: '103.8536',
        ADDRESS: '18 MARINA GARDENS DR',
      }
      return fulfillJson(route, 200, {
        results: postal === address.POSTAL ? [address] : [],
      })
    })
  })

  test('reports unreadable sign-in response without blaming password', async ({
    page,
  }) => {
    await page
      .context()
      .route('**/api/auth/post/getToken', (route) => route.abort('failed'))

    await page.goto('/')
    await page.fill('#onemap-email', 'commuter@example.com')
    await page.fill('#onemap-password', 'test-pass')
    await page.click('#signin-btn')

    const alert = page.locator('#auth-error')
    await expect(alert).toBeVisible()
    await expect(alert).toContainText('Couldn’t sign in to OneMap.')
    await expect(alert).not.toContainText('Wrong password')
  })

  test('blocks duplicate postal submission during lookup and unlocks after lookup failure', async ({
    page,
  }) => {
    const lookupGate = Promise.withResolvers<void>()
    let lookupAttempts = 0
    await page
      .context()
      .route('**/api/common/elastic/search*', async (route) => {
        lookupAttempts += 1
        await lookupGate.promise
        await fulfillJson(route, 503, { error: 'lookup unavailable' })
      })

    await page.goto('/')
    await signInViaUi(page)
    await page.fill('#postal-input', '018989')
    const startButton = page.locator('#start-search-btn')
    await startButton.click()
    await expect.poll(() => lookupAttempts).toBe(1)
    try {
      await expect(startButton).toBeDisabled()
      // Native form submission must also respect the in-flight lookup.
      await page.locator('#search-form').evaluate((form: HTMLFormElement) => {
        form.requestSubmit()
      })
    } finally {
      lookupGate.resolve()
    }

    await expect(page.locator('#search-error')).toHaveText(
      'OneMap postal lookup failed (HTTP 503).',
    )
    await expect(startButton).toBeEnabled()
    expect(lookupAttempts).toBe(1)

    await startButton.click()
    await expect.poll(() => lookupAttempts).toBe(2)
  })

  test('streams distant-before-nearby patches, supports overlap/disconnected selection, and verifies station identity', async ({
    page,
    context,
  }) => {
    test.setTimeout(60_000)
    await page.clock.install({ time: new Date('2026-05-29T09:00:00+08:00') })

    const pass2Gate = Promise.withResolvers<void>()
    const postalAttempts = new Map<string, number>()

    await context.route('**/api/public/routingsvc/route*', (route) =>
      handlePostalSearchRoute(route, pass2Gate.promise, postalAttempts),
    )

    await page.goto('/')

    await expect(page.locator('#signed-in-bar')).toBeHidden()
    await expect(page.locator('#station-field-group')).toBeHidden()
    await expect(page.locator('#stop-search-btn')).toBeHidden()
    await expect(page.locator('#offline-banner')).toBeHidden()
    await expect(page.locator('#selected-stop-card')).toBeHidden()

    // Verify pre-search Singapore date (Friday 2026-05-29 -> skips Sun/Mon Vesak holiday -> 2026-06-02),
    // inventory date, and keep-open notice.
    await expect(page.locator('#planned-search-date')).toHaveText('2026-06-02')
    await expect(page.locator('#planned-inventory-date')).toContainText(
      '2026-11-20',
    )
    await expect(page.locator('.keep-open-notice')).toContainText(
      'Keep the app open while searching. Closing it stops the search.',
    )
    await expect(page.locator('.map-legend')).toContainText(
      'Within 500 m of a qualifying stop.',
    )
    await expect(page.locator('.map-legend')).toContainText(
      'Straight-line proximity',
    )

    await signInViaUi(page)
    await page.fill('#postal-input', '018989')
    await page.fill('#office-start-input', '09:00')
    await page.fill('#ride-cap-input', '40')
    await page.click('#start-search-btn')

    // Mid-search assertions: pass 1 finished (3 reachable candidate stops tried, 88888 pruned),
    // 2 distant overlapping stops matched, search is STILL running while pass 2 waits on 65009!
    await expect(page.locator('#stops-tried-value')).toHaveText('3 / 9')
    await expect(page.locator('#stops-matched-value')).toHaveText('2')
    await expect(page.locator('#result-status-tag')).toContainText(
      'Searching — Pass 2',
    )
    expect(postalAttempts.get('1.389,103.988')).toBeUndefined()
    await expect(
      page.locator('.stop-plaque-marker[data-stop-id="44009"]'),
    ).toBeVisible()
    await expect(
      page.locator('.stop-plaque-marker[data-stop-id="44011"]'),
    ).toBeVisible()

    const zonePaneOpacity = await page
      .locator('.leaflet-commuteZone-pane')
      .evaluate((el) => getComputedStyle(el).opacity)
    expect(zonePaneOpacity).toBe('0.34')
    expect(
      await page.locator('.leaflet-commuteZone-pane svg path').count(),
    ).toBeGreaterThanOrEqual(2)

    // Release pass 2 so 65009 (disconnected patch) qualifies and search completes.
    pass2Gate.resolve()
    await expect(page.locator('#result-status-tag')).toHaveText('Completed', {
      timeout: 25_000,
    })
    await expect(page.locator('#stops-matched-value')).toHaveText('4')

    // Select overlapping stop 44011 on the map and verify its journey card.
    await page.click('.stop-plaque-marker[data-stop-id="44011"]')
    await expect(page.locator('#selected-stop-card')).toBeVisible()
    await expect(page.locator('#selected-stop-id')).toHaveText('44011')
    await expect(page.locator('#selected-boarding-time')).toHaveText('08:27')
    await expect(page.locator('#selected-arrival-time')).toHaveText('08:55')
    await expect(page.locator('#selected-services')).toContainText('Bus 922')

    // Select overlapping peer 44009 on the map.
    await page.click('.stop-plaque-marker[data-stop-id="44009"]')
    await expect(page.locator('#selected-stop-id')).toHaveText('44009')
    await expect(page.locator('#selected-services')).toContainText('Bus 972')

    // Select disconnected patch stop 65009 from the accessible list.
    await page.click('.stop-row-btn[data-stop-id="65009"]')
    await expect(page.locator('#selected-stop-id')).toHaveText('65009')
    await expect(page.locator('#selected-boarding-time')).toHaveText('08:25')
    await expect(page.locator('#selected-arrival-time')).toHaveText('08:58')
    await expect(page.locator('#selected-services')).toContainText(
      'Bus 116 → MRT NS',
    )

    // The same itinerary proves boarding at the transfer station after the bus.
    await page.click('.stop-plaque-marker[data-stop-id="NS17"]')
    await expect(page.locator('#selected-boarding-time')).toHaveText('08:42')
    await expect(page.locator('#selected-arrival-time')).toHaveText('08:58')
    await expect(page.locator('#selected-services')).toHaveText('MRT NS')

    // Station workplace test: choose NS17, verify NS17 qualifies at 09:00 with 0 min ride & 0 routing calls,
    // CC15 at the same point does NOT auto-qualify, and 65009 qualifies via bus+walk.
    const routeRequestsToStationCoords: string[] = []
    await context.unroute('**/api/public/routingsvc/route*')
    await context.route('**/api/public/routingsvc/route*', (route) => {
      const url = new URL(route.request().url())
      const start = url.searchParams.get('start') ?? ''
      const time = url.searchParams.get('time') ?? ''
      if (start.startsWith('1.3514')) {
        routeRequestsToStationCoords.push(`${start}@${time}`)
      }
      if (start.startsWith('1.4036')) {
        return fulfillJson(route, 200, {
          plan: {
            itineraries: [
              makeItinerary(
                '65009',
                '08:25',
                '08:50',
                [
                  {
                    mode: 'BUS',
                    routeShortName: '50',
                    boardMs: sgtIsoMs('08:25'),
                    endMs: sgtIsoMs('08:45'),
                  },
                ],
                5 * 60_000,
              ),
            ],
          },
        })
      }
      return fulfillJson(route, 200, { plan: { itineraries: [] } })
    })

    await page.click('input[name="workplace-kind"][value="station"]')
    await page.selectOption('#station-select', 'NS17')
    await page.click('#start-search-btn')

    await expect(page.locator('#result-status-tag')).toHaveText('Completed', {
      timeout: 25_000,
    })
    // Only CC15 queried once per candidate departure; NS17 made 0 routing requests.
    const passCount = await page.locator('#stops-matched-value').textContent()
    expect(passCount).toBe('2')
    await expect(
      page.locator('.stop-row-btn[data-stop-id="NS17"]'),
    ).toBeVisible()
    await expect(
      page.locator('.stop-row-btn[data-stop-id="CC15"]'),
    ).toHaveCount(0)
    await expect(
      page.locator('.stop-row-btn[data-stop-id="65009"]'),
    ).toBeVisible()

    // Select NS17 in accessible list and verify zero-ride identity evidence.
    await page.click('.stop-row-btn[data-stop-id="NS17"]')
    await expect(page.locator('#selected-ride-duration')).toHaveText('0 min')
    await expect(page.locator('#selected-boarding-time')).toHaveText('09:00')
    await expect(page.locator('#selected-arrival-time')).toHaveText('09:00')
    // CC15 was queried while NS17 was never queried (every start@time at 1.3514 is unique).
    expect(routeRequestsToStationCoords.length).toBeGreaterThanOrEqual(1)
    expect(new Set(routeRequestsToStationCoords).size).toBe(
      routeRequestsToStationCoords.length,
    )
  })

  test('preserves last completed search across partial stop, close, and offline reload without sign-in', async ({
    page,
    context,
  }) => {
    test.setTimeout(60_000)
    await page.clock.install({ time: new Date('2026-05-29T09:00:00+08:00') })
    let failedFirstPunggolProbe = false
    await context.route('**/api/public/routingsvc/route*', (route) => {
      const url = new URL(route.request().url())
      const start = url.searchParams.get('start') ?? ''
      if (start.startsWith('1.4036')) {
        if (!failedFirstPunggolProbe) {
          failedFirstPunggolProbe = true
          return fulfillJson(route, 400, { error: 'routing request failed' })
        }
        return fulfillJson(route, 200, {
          plan: {
            itineraries: [
              makeItinerary('65009', '08:25', '08:52', [
                {
                  mode: 'BUS',
                  routeShortName: '116',
                  boardMs: sgtIsoMs('08:25'),
                  endMs: sgtIsoMs('08:52'),
                },
              ]),
            ],
          },
        })
      }
      return fulfillJson(route, 200, { plan: { itineraries: [] } })
    })

    await page.goto('/')
    // Wait until the Service Worker has installed and controls the page for offline reload.
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready
    })
    await page.reload()

    // The 40-minute search radius includes the Punggol boarding in this saved result.
    await signInViaUi(page)
    await page.fill('#postal-input', '018989')
    await page.fill('#office-start-input', '09:00')
    await page.fill('#ride-cap-input', '40')
    await page.click('#start-search-btn')
    await expect(page.locator('#result-status-tag')).toHaveText('Completed', {
      timeout: 25_000,
    })
    await expect(page.locator('#search-error')).toBeHidden()

    // Search B: start station search with a held request, then click Stop search -> Partial result.
    await context.unroute('**/api/public/routingsvc/route*')
    await context.route('**/api/public/routingsvc/route*', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 250))
      await fulfillJson(route, 200, { plan: { itineraries: [] } })
    })
    await page.click('input[name="workplace-kind"][value="station"]')
    await page.selectOption('#station-select', 'NS17')
    await page.fill('#office-start-input', '08:30')
    await page.fill('#ride-cap-input', '15')
    await page.click('#start-search-btn')
    await expect(page.locator('#stop-search-btn')).toBeVisible()
    await page.click('#stop-search-btn')
    await expect(page.locator('#result-status-tag')).toHaveText(
      'Partial result',
    )

    // Go offline and reopen without signing in: Search A must be intact!
    await context.setOffline(true)
    await page.reload()

    await expect(page.locator('#offline-banner')).toBeVisible()
    await expect(page.locator('#start-search-btn')).toBeDisabled()
    await expect(page.locator('#account-status-pill')).toHaveText(
      'Not connected',
    )
    await expect(page.locator('#result-status-tag')).toHaveText(
      'Saved offline result',
    )
    await expect(page.locator('#active-constraints-summary')).toContainText(
      'Postal 018989',
    )
    await expect(page.locator('#active-constraints-summary')).toContainText(
      'Date 2026-06-02',
    )
    await expect(page.locator('#active-constraints-summary')).toContainText(
      'Start 09:00',
    )
    await expect(page.locator('#active-constraints-summary')).toContainText(
      'Ride cap 40 min',
    )

    // Verify map stop and accessible list both work offline without tiles or sign-in.
    await page.click('.stop-plaque-marker[data-stop-id="65009"]')
    await expect(page.locator('#selected-stop-name')).toHaveText(
      'Punggol Temp Int',
    )
    await expect(page.locator('#selected-services')).toContainText('Bus 116')
    await expect(
      page.locator('.stop-row-btn[data-stop-id="65009"]'),
    ).toBeVisible()

    // Neither closing a running search nor failed OneMap requests may replace Search A.
    for (const interruption of ['reload', 'routing failure']) {
      await context.setOffline(false)
      await page.reload()
      await signInViaUi(page)
      if (interruption === 'routing failure') {
        await context.route('**/api/public/routingsvc/route*', (route) =>
          fulfillJson(route, 400, { error: 'upstream outage' }),
        )
      }
      await page.click('input[name="workplace-kind"][value="station"]')
      await page.selectOption('#station-select', 'NS17')
      await page.click('#start-search-btn')
      if (interruption === 'reload') {
        await expect(page.locator('#stop-search-btn')).toBeVisible()
      } else {
        await expect(page.locator('#result-status-tag')).toHaveText(
          'Partial result',
          { timeout: 25_000 },
        )
        await expect(page.locator('#search-error')).toContainText(
          'was not saved offline',
        )
      }
      await context.setOffline(true)
      await page.reload()
      await expect(page.locator('#result-status-tag')).toHaveText(
        'Saved offline result',
      )
      await expect(page.locator('#active-constraints-summary')).toContainText(
        'Postal 018989',
      )
      await expect(
        page.locator('.stop-row-btn[data-stop-id="65009"]'),
      ).toBeVisible()
    }
  })
})
