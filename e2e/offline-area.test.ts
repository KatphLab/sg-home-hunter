import { expect, type Page, type Route, test } from '@playwright/test'

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })

const chooseArea = async (page: Page, id = '11111') => {
  await page.fill('#area-stop-filter', id)
  await page.selectOption('#area-stop-select', id)
}

const preview = async (page: Page) => {
  await page.fill('#postal-input', '018989')
  await page.fill('#office-start-input', '09:00')
  await page.click('#start-search-btn')
  await expect(page.locator('#result-status-tag')).toHaveText('Estimated preview')
}

const journey = (date: string) => {
  const at = (time: string) => Date.parse(`${date}T${time}:00+08:00`)
  return { plan: { itineraries: [{
    startTime: at('08:25'), endTime: at('08:45'), legs: [
      { mode: 'BUS', from: { stopCode: '11111' }, routeShortName: '11',
        startTime: at('08:25'), endTime: at('08:44') },
      { mode: 'WALK', startTime: at('08:44'), endTime: at('08:45') },
    ],
  }] } }
}

const savedVisible = async (page: Page, date: string) => {
  await expect(page.locator('#offline-banner')).toBeVisible()
  await expect(page.locator('#account-status-pill')).toHaveText('Not connected')
  await expect(page.locator('#start-search-btn')).toBeDisabled()
  await expect(page.locator('#section-preview')).toBeHidden()
  await expect(page.locator('#result-status-tag')).toHaveText('Saved offline area check')
  const summary = page.locator('#active-constraints-summary')
  await expect(summary).toContainText(`Date ${date}`)
  await expect(summary).toContainText('09:00')
  await expect(summary).toContainText('Ride cap 30 min')
  await expect(summary).toContainText('18 MARINA GARDENS DR')
  await expect(summary).toContainText('within 500 m of 1.30000, 103.85000')
  await expect(summary).toContainText('not a walking route')
  await expect(summary).toContainText('not an island-wide scan')
  await expect(page.locator('.stop-row-btn')).toHaveCount(1)
  await expect(page.locator('.leaflet-commuteZone-pane')).toHaveCSS('opacity', '0.34')
  await expect(page.locator('.leaflet-commuteZone-pane path')).toHaveCount(1)
  await expect(page.locator('.leaflet-selection-pane path')).toHaveCount(1)
  await expect(page.locator('#selected-stop-name')).toHaveText('River Homes')
  await page.click('#close-journey-card')
  await page.click('.stop-plaque-marker[data-stop-id="11111"]')
  await expect(page.locator('#selected-stop-name')).toHaveText('River Homes')
  await page.click('.stop-row-btn[data-stop-id="11111"]')
  await expect(page.locator('#selected-boarding-time')).toHaveText('08:25')
  await expect(page.locator('#selected-arrival-time')).toHaveText('08:45')
  await expect(page.locator('#selected-ride-duration')).toHaveText('19 min')
  await expect(page.locator('#selected-services')).toHaveText('Bus 11')
}

test.beforeEach(async ({ page, context }) => {
  await context.route('**/maps/tiles/**', (route) => route.abort())
  await context.route('**/data/stops.tsv', (route) => route.fulfill({ body: [
    'inventoryDate\t2026-11-20', 'id\tkind\tname\tlatitude\tlongitude',
    '03218\tbus\tMarina Gardens Opp\t1.279100\t103.854000',
    '11111\tbus\tRiver Homes\t1.300000\t103.850000',
    '11112\tbus\tRiver Gardens\t1.300500\t103.850000',
    '88888\tbus\tEmpty Circle\t1.389000\t103.988000',
  ].join('\n') }))
  await context.route('**/data/bus-network.tsv', (route) => route.fulfill({ body: [
    'networkDate\t2026-11-20', 'service\tdirection\tvisits',
    '11\t1\t11111 0530 2330 0530 2330 0530 2330|03218 0542 2342 0542 2342 0542 2342',
    '12\t1\t11112 0530 2330 0530 2330 0530 2330|03218 0556 2356 0556 2356 0556 2356',
  ].join('\n') }))
  await context.route('**/api/auth/post/getToken', (route) => json(route, {
    access_token: 'mock-jwt', expiry_timestamp: 1_900_000_000,
  }))
  await context.route('**/api/common/elastic/search*', (route) => json(route, { results: [{
    POSTAL: '018989', LATITUDE: '1.2789', LONGITUDE: '103.8536', ADDRESS: '18 MARINA GARDENS DR',
  }] }))
  await context.route('**/api/public/routingsvc/route*', (route) => {
    const [month, day, year] = (new URL(route.request().url()).searchParams.get('date') ?? '').split('-')
    return json(route, journey(`${year}-${month}-${day}`))
  })
  await page.goto('/')
  await page.evaluate(async () => { await navigator.serviceWorker.ready })
  await page.reload()
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true)
  await page.fill('#onemap-email', 'commuter@example.com')
  await page.fill('#onemap-password', 'test-pass')
  await page.click('#signin-btn')
  await expect(page.locator('#signed-in-email')).toHaveText('commuter@example.com')
})

for (const later of ['reload', 'preview', 'empty', 'miss', 'failure', 'routing failure', 'stop', 'close', 'storage failure'] as const) {
  test(`retains successful area offline after ${later}`, async ({ page, context }) => {
    await preview(page)
    const date = (await page.locator('#planned-search-date').innerText()).trim()
    await chooseArea(page)
    await page.click('#check-area-btn')
    await expect(page.locator('#area-result')).toContainText('Confirmed')
    await expect(page.locator('#area-journey')).toContainText(`${date}. Board 08:25`)
    await expect(page.locator('#area-journey')).toContainText('workplace arrival 08:45')
    await expect(page.locator('.stop-row-btn')).toHaveCount(1)

    if (later !== 'reload') {
      // A fresh search cannot reuse the saved boarding as current-date proof.
      await page.fill('#ride-cap-input', '25')
      await preview(page)
      await expect(page.locator('.stop-row-btn')).toHaveCount(0)
      await chooseArea(page, later === 'empty' ? '88888' : '11112')
      if (later === 'miss' || later === 'empty') {
        await context.route('**/api/public/routingsvc/route*', (route) => json(route, { plan: { itineraries: [] } }))
      } else if (later === 'failure') {
        await context.route('**/api/public/routingsvc/route*', (route) => json(route, {}, 401))
      } else if (later === 'routing failure') {
        await context.route('**/api/public/routingsvc/route*', (route) => json(route, {}, 400))
      } else if (later === 'storage failure') {
        await page.evaluate(() => {
          Storage.prototype.setItem = () => { throw new DOMException('Storage full', 'QuotaExceededError') }
        })
      }
      if (later === 'stop' || later === 'close') {
        const gate = Promise.withResolvers<void>()
        let requested = false
        await context.route('**/api/public/routingsvc/route*', async (route) => {
          requested = true
          await gate.promise
          await json(route, { plan: { itineraries: [] } }).catch(() => {})
        })
        await page.click('#check-area-btn')
        await expect.poll(() => requested).toBe(true)
        if (later === 'stop') {
          await page.click('#stop-area-btn')
          await expect(page.locator('#area-result')).toContainText('Stopped')
        } else {
          await page.close()
          page = await context.newPage()
        }
        gate.resolve()
      } else if (later !== 'preview') {
        await page.click('#check-area-btn')
        const expected = { empty: 'No estimated candidates', miss: 'Not confirmed', failure: 'Sign-in expired', 'routing failure': 'Routing failed', 'storage failure': 'Could not save' }[later]
        await expect(page.locator('#area-result')).toContainText(expected)
        if (later === 'storage failure') {
          await expect(page.locator('#area-result')).toContainText('Confirmed')
          await expect(page.locator('#area-result')).not.toContainText('Routing failed')
        }
      }
    }
    await context.setOffline(true)
    await page.goto('/')
    await savedVisible(page, date)
  })
}
