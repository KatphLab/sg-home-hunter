import { expect, type Page, type Route, test } from '@playwright/test'

const TEST_INVENTORY_TSV = [
  'inventoryDate\t2026-11-20',
  'id\tkind\tname\tlatitude\tlongitude',
  '03218\tbus\tMarina Gardens Opp\t1.279100\t103.854000',
  '11111\tbus\tRiver Homes\t1.300000\t103.850000',
  '11112\tbus\tRiver Gardens\t1.300500\t103.850000',
  '11113\tbus\tOver Cap Homes\t1.310000\t103.850000',
  '11114\tbus\tUncovered Homes\t1.320000\t103.850000',
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
  '11\t1\t11111 0530 2330 0530 2330 0530 2330|03218 0542 2342 0542 2342 0542 2342',
  '12\t1\t11112 0530 2330 0530 2330 0530 2330|03218 0556 2356 0556 2356 0556 2356',
  '13\t1\t11113 0530 2330 0530 2330 0530 2330|03218 0558 2358 0558 2358 0558 2358',
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

  test('previews without routing and selects the same area by keyboard and map', async ({
    page, context,
  }) => {
    let routingCalls = 0
    let postalLookups = 0
    await context.route('**/api/public/routingsvc/route*', (route) => {
      routingCalls += 1
      return fulfillJson(route, 500, {})
    })
    page.on('request', (request) => {
      if (request.url().includes('/api/common/elastic/search')) postalLookups += 1
    })
    await page.clock.install({ time: new Date('2026-05-29T09:00:00+08:00') })
    await page.goto('/')
    await expect(page.locator('#section-preview')).toBeHidden()
    await expect(page.locator('#signed-in-bar')).toBeHidden()
    await expect(page.locator('#station-field-group')).toBeHidden()
    await expect(page.locator('#stop-search-btn')).toBeHidden()
    await expect(page.locator('#selected-stop-card')).toBeHidden()
    await expect(page.locator('#planned-search-date')).toHaveText('2026-06-02')
    await signInViaUi(page)
    await page.fill('#postal-input', '018989')
    await page.click('#start-search-btn')
    await expect(page.locator('#result-status-tag')).toHaveText('Estimated preview')
    await expect(page.locator('#preview-summary')).toContainText('2 estimated stops')
    await expect(page.locator('#preview-summary')).toContainText('1 at least 10 min below cap; 1 less than 10 min below')
    await expect(page.locator('#preview-summary')).toContainText('No routing requests')
    await expect(page.locator('#section-preview')).toContainText('not confidence scores')
    await expect(page.locator('#stops-matched-value')).toHaveText('0')
    await expect(page.locator('.stop-row-btn')).toHaveCount(0)
    await expect(page.locator('#selected-stop-card')).toBeHidden()
    await page.getByLabel('Find an area centre by stop name or ID').fill('11111')
    await page.getByLabel('Centre the 500 m area on a stop').focus()
    await page.keyboard.press('ArrowDown')
    await expect(page.locator('#area-summary')).toContainText('11111 River Homes: 2 estimated candidates')
    await expect(page.locator('#area-summary')).toContainText('Not a walking route')
    const map = page.locator('#map')
    const box = await map.boundingBox()
    if (!box) throw new Error('Map is not visible')
    await map.click({ position: { x: box.width / 2, y: box.height / 2 } })
    await expect(page.locator('#area-summary')).toContainText('Map point')
    await expect(page.locator('#area-summary')).toContainText('2 estimated candidates')
    await expect(page.locator('.leaflet-selection-pane path')).toHaveCount(1)
    await expect(page.locator('.leaflet-commuteZone-pane path')).toHaveCount(0)
    await page.fill('#area-stop-filter', 'Changi Village')
    await page.selectOption('#area-stop-select', '88888')
    await expect(page.locator('#area-summary')).toContainText('0 estimated candidates')
    for (const stopId of ['11113', '11114', '44009']) {
      await page.fill('#area-stop-filter', stopId)
      await page.selectOption('#area-stop-select', stopId)
      await expect(page.locator('#area-summary')).toContainText('0 estimated candidates')
    }
    expect(postalLookups).toBe(1)
    expect(routingCalls).toBe(0)
  })

  test('keeps the stop picker and area count usable without a map on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/')
    await signInViaUi(page)
    await page.fill('#postal-input', '018989')
    await page.click('#start-search-btn')
    await expect(page.locator('#section-preview')).toBeVisible()
    await expect(page.locator('#map')).toBeHidden()
    await page.fill('#area-stop-filter', 'River Homes')
    await page.locator('#area-stop-select').focus()
    await page.keyboard.press('ArrowDown')
    await expect(page.locator('#area-summary')).toContainText('2 estimated candidates')
    await page.click('[data-mobile-tab="stops"]')
    await expect(page.locator('#area-summary')).toBeVisible()
  })

  test('preserves only the exact destination station zero-ride exception', async ({ page, context }) => {
    let routingCalls = 0
    await context.route('**/api/public/routingsvc/route*', (route) => {
      routingCalls += 1
      return fulfillJson(route, 500, {})
    })
    await page.goto('/')
    await signInViaUi(page)
    await page.click('input[name="workplace-kind"][value="station"]')
    await page.selectOption('#station-select', 'NS17')
    await page.click('#start-search-btn')
    await expect(page.locator('#result-status-tag')).toHaveText('Estimated preview')
    await expect(page.locator('#stops-matched-value')).toHaveText('1')
    await expect(page.locator('.stop-row-btn[data-stop-id="CC15"]')).toHaveCount(0)
    await page.click('.stop-row-btn[data-stop-id="NS17"]')
    await expect(page.locator('#selected-ride-duration')).toHaveText('0 min')
    await expect(page.locator('#selected-arrival-time')).toHaveText('09:00')
    await expect(page.locator('.leaflet-commuteZone-pane')).toHaveCSS('opacity', '0.34')
    await expect(page.locator('.leaflet-commuteZone-pane path')).toHaveCount(1)
    expect(routingCalls).toBe(0)
    await page.fill('#ride-cap-input', '15')
    await expect(page.locator('#section-preview')).toBeHidden()
    await expect(page.locator('#selected-stop-card')).toBeHidden()
    await expect(page.locator('.stop-row-btn')).toHaveCount(0)
    await expect(page.locator('.leaflet-commuteZone-pane path')).toHaveCount(0)
  })

  test('invalidates in-flight lookup on edits, stop, and disconnect', async ({ page, context }) => {
    const lookupGate = Promise.withResolvers<void>()
    let lookups = 0
    await context.route('**/api/common/elastic/search*', async (route) => {
      lookups += 1
      await lookupGate.promise
      await fulfillJson(route, 200, { results: [{
        POSTAL: '018989', LATITUDE: '1.2789', LONGITUDE: '103.8536', ADDRESS: 'Marina Gardens',
      }] })
    })
    await page.goto('/')
    await signInViaUi(page)
    await page.fill('#postal-input', '018989')
    await page.click('#start-search-btn')
    await expect.poll(() => lookups).toBe(1)
    await page.fill('#office-start-input', '08:30')
    await expect(page.locator('#stop-search-btn')).toBeHidden()
    await expect(page.locator('#start-search-btn')).toBeEnabled()
    await page.click('#start-search-btn')
    await expect.poll(() => lookups).toBe(2)
    await page.click('#stop-search-btn')
    await page.click('#start-search-btn')
    await expect.poll(() => lookups).toBe(3)
    await page.click('#signout-btn')
    lookupGate.resolve()
    await expect(page.locator('#section-preview')).toBeHidden()
    await expect(page.locator('#start-search-btn')).toBeDisabled()
    await expect(page.locator('#result-status-tag')).not.toHaveText('Estimated preview')
  })

  test('retains an existing completed offline map through previews and interrupted lookup', async ({
    page, context,
  }) => {
    // A previously completed result uses the unchanged v1 storage contract.
    const saved = {
      version: 1, completedAtIso: '2026-06-02T01:00:00Z', inventoryDate: '2026-11-20',
      workplace: { kind: 'postal', postalCode: '018989', label: '18 MARINA GARDENS DR',
        point: { latitude: 1.2789, longitude: 103.8536 } },
      constraints: { searchDate: '2026-06-02', officeStart: '09:00', rideCapMinutes: 40 },
      triedCount: 9, totalCount: 9,
      matches: [{
        stop: { id: '65009', kind: 'bus', name: 'Punggol Temp Int',
          point: { latitude: 1.4036, longitude: 103.9022 } },
        journey: { stopId: '65009', searchDate: '2026-06-02',
          boardingAtMs: Date.parse('2026-06-02T08:25:00+08:00'),
          arrivalAtMs: Date.parse('2026-06-02T08:52:00+08:00'),
          rideMs: 27 * 60_000, services: [{ id: '116', name: '116', mode: 'BUS' }],
          isAtDestination: false },
      }],
    }
    await page.goto('/')
    await page.evaluate(async (snapshot) => {
      await navigator.serviceWorker.ready
      localStorage.setItem('house-hunter:last-completed-result:v1', JSON.stringify(snapshot))
    }, saved)
    await page.reload()
    await expect(page.locator('#result-status-tag')).toHaveText('Saved offline result')
    await signInViaUi(page)
    await page.fill('#postal-input', '018989')
    await page.click('#start-search-btn')
    await expect(page.locator('#result-status-tag')).toHaveText('Estimated preview')
    await expect(page.locator('.stop-row-btn')).toHaveCount(0)
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('house-hunter:last-completed-result:v1') ?? 'null'))).toEqual(saved)
    const lookupGate = Promise.withResolvers<void>()
    let pending = false
    await context.route('**/api/common/elastic/search*', async (route) => {
      pending = true
      await lookupGate.promise
      await fulfillJson(route, 503, {})
    })
    await page.fill('#office-start-input', '08:30')
    await page.click('#start-search-btn')
    await expect.poll(() => pending).toBe(true)
    await page.click('#stop-search-btn')
    lookupGate.resolve()
    await context.setOffline(true)
    await page.reload()
    await expect(page.locator('#offline-banner')).toBeVisible()
    await expect(page.locator('#start-search-btn')).toBeDisabled()
    await expect(page.locator('#account-status-pill')).toHaveText('Not connected')
    await expect(page.locator('#section-preview')).toBeHidden()
    await expect(page.locator('#result-status-tag')).toHaveText('Saved offline result')
    await expect(page.locator('#active-constraints-summary')).toContainText('Date 2026-06-02')
    await expect(page.locator('#active-constraints-summary')).toContainText('Ride cap 40 min')
    await page.click('.stop-plaque-marker[data-stop-id="65009"]')
    await expect(page.locator('#selected-stop-name')).toHaveText('Punggol Temp Int')
    await expect(page.locator('#selected-services')).toHaveText('Bus 116')
    await expect(page.locator('.stop-row-btn[data-stop-id="65009"]')).toBeVisible()
  })
})
