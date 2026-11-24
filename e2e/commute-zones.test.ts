import { expect, type Page, type Route, test } from '@playwright/test'

const TEST_INVENTORY_TSV = [
  'inventoryDate\t2026-11-20',
  'id\tkind\tname\tlatitude\tlongitude',
  '44009\tbus\tBukit Panjang Ring\t1.382000\t103.760000',
  '44011\tbus\tBlk 418 Fajar\t1.388000\t103.765000',
  '65009\tbus\tPunggol Temp Int\t1.403600\t103.902200',
  '88888\tbus\tChangi Village\t1.389000\t103.988000',
  'CC15\trail\tBishan\t1.351400\t103.848200',
  'NS17\trail\tBishan\t1.351400\t103.848200',
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
    from: { stopCode: idx === 0 ? boardStopCode : 'NE17' },
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
}

const handlePostalSearchRoute = async (
  route: Route,
  pass2Gate: Promise<void>,
): Promise<void> => {
  const url = new URL(route.request().url())
  const start = url.searchParams.get('start') ?? ''
  const time = url.searchParams.get('time') ?? ''

  if (time === '08:10:00' && start.startsWith('1.382')) {
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

  if (time === '08:10:00' && start.startsWith('1.388')) {
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

  if (time === '08:20:00' && start.startsWith('1.4036')) {
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
                routeShortName: 'NE',
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
  test('reports unreadable sign-in response without blaming password', async ({
    page,
  }) => {
    await stubTilesAndInventory(page)
    await page.route('**/api/auth/post/getToken', (route) =>
      route.abort('failed'),
    )

    await page.goto('/')
    await page.fill('#onemap-email', 'commuter@example.com')
    await page.fill('#onemap-password', 'test-pass')
    await page.click('#signin-btn')

    const alert = page.locator('#auth-error')
    await expect(alert).toBeVisible()
    await expect(alert).toContainText('Couldn’t sign in to OneMap.')
    await expect(alert).not.toContainText('Wrong password')
  })

  test('streams distant-before-nearby patches, supports overlap/disconnected selection, and verifies station identity', async ({
    page,
  }) => {
    test.setTimeout(60_000)
    await page.clock.install({ time: new Date('2026-05-29T09:00:00+08:00') })
    await stubTilesAndInventory(page)

    await page.route('**/api/auth/post/getToken', (route) =>
      fulfillJson(route, 200, {
        access_token: 'mock-jwt',
        expiry_timestamp: 1_900_000_000,
      }),
    )

    await page.route('**/api/common/elastic/search*', (route) => {
      const url = new URL(route.request().url())
      const postal = url.searchParams.get('searchVal')
      return fulfillJson(route, 200, {
        results:
          postal === '018989'
            ? [
                {
                  POSTAL: '018989',
                  LATITUDE: '1.2789',
                  LONGITUDE: '103.8536',
                  ADDRESS: '18 MARINA GARDENS DR',
                },
              ]
            : [],
      })
    })

    const pass2Gate = Promise.withResolvers<void>()

    await page.route('**/api/public/routingsvc/route*', (route) =>
      handlePostalSearchRoute(route, pass2Gate.promise),
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
    await page.fill('#ride-cap-input', '30')
    await page.click('#start-search-btn')

    // Mid-search assertions: pass 1 finished (all 6 stops tried), only 2 distant overlapping stops matched,
    // search is STILL running while pass 2 waits on 65009!
    await expect(page.locator('#stops-tried-value')).toHaveText('6 / 6')
    await expect(page.locator('#stops-matched-value')).toHaveText('2')
    await expect(page.locator('#result-status-tag')).toContainText(
      'Searching — Pass 2',
    )
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
    await expect(page.locator('#stops-matched-value')).toHaveText('3')

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
      'Bus 116 → MRT NE',
    )

    // Station workplace test: choose NS17, verify NS17 qualifies at 09:00 with 0 min ride & 0 routing calls,
    // CC15 at the same point does NOT auto-qualify, and 65009 qualifies via bus+walk.
    const routeRequestsToStationCoords: string[] = []
    await page.unroute('**/api/public/routingsvc/route*')
    await page.route('**/api/public/routingsvc/route*', (route) => {
      const url = new URL(route.request().url())
      const start = url.searchParams.get('start') ?? ''
      const time = url.searchParams.get('time') ?? ''
      if (start.startsWith('1.3514')) {
        routeRequestsToStationCoords.push(`${start}@${time}`)
      }
      if (time === '08:10:00' && start.startsWith('1.4036')) {
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
    // Only CC15 queried once per pass; NS17 made 0 routing requests.
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
    // CC15 was queried across the schedule, NS17 was never queried (only 1 stop per pass at 1.3514)
    expect(
      routeRequestsToStationCoords.filter((r) => r.endsWith('@08:10:00'))
        .length,
    ).toBe(1)
  })

  test('preserves last completed search across partial stop, close, and offline reload without sign-in', async ({
    page,
    context,
  }) => {
    test.setTimeout(60_000)
    await page.clock.install({ time: new Date('2026-05-29T09:00:00+08:00') })
    await stubTilesAndInventory(page)

    await page.route('**/api/auth/post/getToken', (route) =>
      fulfillJson(route, 200, {
        access_token: 'mock-jwt',
        expiry_timestamp: 1_900_000_000,
      }),
    )
    await page.route('**/api/common/elastic/search*', (route) =>
      fulfillJson(route, 200, {
        results: [
          {
            POSTAL: '018989',
            LATITUDE: '1.2789',
            LONGITUDE: '103.8536',
            ADDRESS: '18 MARINA GARDENS DR',
          },
        ],
      }),
    )
    await page.route('**/api/public/routingsvc/route*', (route) => {
      const url = new URL(route.request().url())
      const start = url.searchParams.get('start') ?? ''
      const time = url.searchParams.get('time') ?? ''
      if (time === '08:10:00' && start.startsWith('1.4036')) {
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

    // Search A: complete search for 018989 / 09:00 / 30 min.
    await signInViaUi(page)
    await page.fill('#postal-input', '018989')
    await page.fill('#office-start-input', '09:00')
    await page.fill('#ride-cap-input', '30')
    await page.click('#start-search-btn')
    await expect(page.locator('#result-status-tag')).toHaveText('Completed', {
      timeout: 25_000,
    })

    // Search B: start station search with a held request, then click Stop search -> Partial result.
    await page.unroute('**/api/public/routingsvc/route*')
    await page.route('**/api/public/routingsvc/route*', async (route) => {
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
      'Ride cap 30 min',
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

    // Go back online, start Search B again, and simulate closing/reloading mid-search -> Search A still survives offline!
    await context.setOffline(false)
    await page.reload()
    await signInViaUi(page)
    await page.click('input[name="workplace-kind"][value="station"]')
    await page.selectOption('#station-select', 'NS17')
    await page.click('#start-search-btn')
    await expect(page.locator('#stop-search-btn')).toBeVisible()

    await context.setOffline(true)
    await page.reload()
    await expect(page.locator('#active-constraints-summary')).toContainText(
      'Postal 018989',
    )
    await expect(
      page.locator('.stop-row-btn[data-stop-id="65009"]'),
    ).toBeVisible()
  })
})
