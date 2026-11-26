import {
  type BrowserContext,
  expect,
  type Page,
  type Route,
  test,
} from '@playwright/test'

import {
  fulfillJson,
  preview,
  selectArea,
  signInViaUi,
  stubCommute,
} from './commute-fixture.js'

const ROUTING_URL = '**/api/public/routingsvc/route*'
const EMPTY_PLAN = { plan: { itineraries: [] } }

const expectOriginalCheckedDate = async (page: Page) => {
  const date = page.locator('#selected-journey-date')
  await expect(date).toBeVisible()
  await expect(date).toHaveText('Checked for Thursday, 26 November')
  await expect(date).toHaveAttribute('datetime', '2026-11-26')
}

const journey = (route: Route, stopCode = '11111') => {
  const date = new URL(route.request().url()).searchParams.get('date')
  if (date === null) throw new Error('Routing date missing')
  const [month, day, year] = date.split('-')
  const at = (time: string) =>
    Date.parse(`${year}-${month}-${day}T${time}:00+08:00`)
  return {
    plan: {
      itineraries: [
        {
          startTime: at('08:25'),
          endTime: at('08:45'),
          legs: [
            {
              mode: 'BUS',
              from: { stopCode },
              routeShortName: '11',
              startTime: at('08:25'),
              endTime: at('08:44'),
            },
            { mode: 'WALK', startTime: at('08:44'), endTime: at('08:45') },
          ],
        },
      ],
    },
  }
}

const reopenSavedArea = async (page: Page, context: BrowserContext) => {
  await context.setOffline(true)
  await page.goto('/')
  await expect(page.locator('#result-status-tag')).toHaveText(
    'Saved offline area check',
  )
  await expect(page.locator('#active-constraints-summary')).toContainText(
    'Ride cap 30 min',
  )
  await expectOriginalCheckedDate(page)
}

const checkSavedMap = async (page: Page) => {
  await expect(page.locator('#offline-banner')).toBeVisible()
  await expect(page.locator('#account-status-pill')).toHaveText('Not connected')
  await expect(page.locator('#start-search-btn')).toBeDisabled()
  await expect(page.locator('#section-preview')).toBeHidden()
  const summary = page.locator('#active-constraints-summary')
  await expect(summary).not.toContainText(/2026-11-26|26 November/)
  await expect(summary).toContainText('09:00')
  await expect(summary).toContainText('18 MARINA GARDENS DR')
  await expect(summary).toContainText('within 500 m of 1.30000, 103.85000')
  await expect(summary).toContainText('not a walking route')
  await expect(summary).toContainText('not an island-wide scan')
  await expect(page.locator('.stop-row-btn')).toHaveCount(1)
  await expect(page.locator('.leaflet-commuteZone-pane')).toHaveCSS(
    'opacity',
    '0.34',
  )
  await expect(page.locator('.leaflet-commuteZone-pane path')).toHaveCount(1)
  await expect(page.locator('.leaflet-selection-pane path')).toHaveCount(1)
  await expect(page.locator('#selected-stop-name')).toHaveText('River Homes')
  await page.click('#close-journey-card')
  await page.click('.stop-plaque-marker[data-stop-id="11111"]')
  await expect(page.locator('#selected-stop-name')).toHaveText('River Homes')
  await page.fill('#ride-cap-input', '25')
  await page.fill('#postal-input', '018988')
  await expect(page.locator('.leaflet-selection-pane path')).toHaveCount(1)
  await expect(page.locator('#result-status-tag')).toHaveText(
    'Saved offline area check',
  )
  await expect(page.locator('#active-constraints-summary')).toContainText(
    'Ride cap 30 min',
  )
  await page.click('.stop-row-btn[data-stop-id="11111"]')
  await expectOriginalCheckedDate(page)
  await expect(page.locator('#selected-boarding-time')).toHaveText('08:25')
  await expect(page.locator('#selected-arrival-time')).toHaveText('08:45')
  await expect(page.locator('#selected-ride-duration')).toHaveText('19 min')
  await expect(page.locator('#selected-services')).toHaveText('Bus 11')
}

test.beforeEach(async ({ page, context }) => {
  await stubCommute(context)
  await context.route(ROUTING_URL, (route) =>
    fulfillJson(route, 200, journey(route)),
  )
  await page.clock.setFixedTime(new Date('2026-11-25T12:00:00+08:00'))
  await page.goto('/')
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready
  })
  await page.reload()
  await expect
    .poll(() =>
      page.evaluate(() => navigator.serviceWorker.controller !== null),
    )
    .toBe(true)
  await page.fill('#postal-input', '018989')
  await signInViaUi(page)
})

test('reopens a saved mobile check before offering a new search', async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await preview(page)
  await selectArea(page, '11111')
  await page.getByRole('button', { name: 'Check within 500 m' }).click()
  await expect(
    page.getByRole('heading', { name: 'Board at River Homes' }),
  ).toBeVisible()
  await page.clock.setFixedTime(new Date('2026-11-26T12:00:00+08:00'))
  await page.reload()
  await expect(page.locator('#map')).toBeVisible()
  await expect(page.locator('#result-status-tag')).toHaveText(
    'Saved offline area check',
  )
  await expectOriginalCheckedDate(page)
  await expect(page.locator('#selected-journey-disclaimer')).toContainText(
    'One qualifying journey',
  )
  await expect(page.locator('#signin-form')).toBeHidden()
  await context.setOffline(true)
  await page.reload()
  await expect(
    page.getByRole('heading', { name: 'Board at River Homes' }),
  ).toBeVisible()
  await expectOriginalCheckedDate(page)
  await page.getByRole('button', { name: 'New search' }).click()
  await expect(page.locator('#heading-search')).toBeFocused()
  await expect(page.locator('#postal-input')).toBeVisible()
  await expect(page.locator('#map')).toBeHidden()
  await expect(page.locator('#start-search-btn')).toBeDisabled()
})

test('saves only the successful selected area, not unrelated proof from a missed area', async ({
  page,
  context,
}) => {
  let calls = 0
  await context.route(ROUTING_URL, (route) =>
    fulfillJson(route, 200, journey(route, ++calls <= 3 ? '88888' : '11111')),
  )
  await preview(page)
  await selectArea(page, '11111')
  await page.click('#check-area-btn')
  await expect(page.locator('#area-result')).toContainText(
    'No commute confirmed',
  )
  await expect(page.locator('.stop-row-btn[data-stop-id="88888"]')).toHaveCount(
    1,
  )
  await selectArea(page, '11112')
  await page.click('#check-area-btn')
  await expect(page.locator('#area-result')).toContainText('Confirmed')
  await expect(page.locator('#stops-tried-value')).toHaveText('2 / 2')
  await expect(page.locator('.stop-row-btn[data-stop-id="88888"]')).toHaveCount(
    1,
  )
  await context.setOffline(true)
  await page.goto('/')
  await expect(page.locator('#result-status-tag')).toHaveText(
    'Saved offline area check',
  )
  await expect(page.locator('.stop-row-btn')).toHaveCount(1)
  await expect(page.locator('.stop-row-btn[data-stop-id="11111"]')).toHaveCount(
    1,
  )
  await expect(page.locator('#stops-tried-value')).toHaveText('2 / 2')
  await expectOriginalCheckedDate(page)
})

test.describe('retaining the last saved area', () => {
  test.beforeEach(async ({ page }) => {
    await preview(page)
    await selectArea(page, '11111')
    await page.click('#check-area-btn')
    await expect(page.locator('#area-result')).toContainText('Confirmed')
    await page.clock.setFixedTime(new Date('2026-11-26T12:00:00+08:00'))
    await page.fill('#ride-cap-input', '25')
    await preview(page)
    await expect(page.locator('.stop-row-btn')).toHaveCount(0)
  })

  test('restores the previous map after empty, missed and failed checks', async ({
    page,
    context,
  }) => {
    let calls = 0
    await context.route(ROUTING_URL, (route) => {
      calls += 1
      if (calls <= 3) return fulfillJson(route, 200, EMPTY_PLAN)
      return fulfillJson(route, calls === 4 ? 400 : 401, {})
    })
    const outcome = page.locator('#area-result')
    for (const [stop, message, total] of [
      ['88888', 'No estimated candidates', 0],
      ['11112', 'No commute confirmed', 3],
      ['11111', 'Routing failed', 4],
    ] as const) {
      await selectArea(page, stop)
      await page.click('#check-area-btn')
      await expect(outcome).toContainText(message)
      expect(calls).toBe(total)
      if (total === 0) {
        await expect(outcome).toContainText('0 checks')
        await expect(outcome).not.toContainText('unreachable')
      }
    }
    // All departures in the overlapping circles are spent; start a fresh preview.
    await page.fill('#ride-cap-input', '26')
    await preview(page)
    await selectArea(page, '11112')
    await page.click('#check-area-btn')
    await expect(outcome).toContainText('Sign-in expired')
    expect(calls).toBe(5)
    await reopenSavedArea(page, context)
    await checkSavedMap(page)
  })

  test('keeps the save when the tab closes during a check', async ({
    page,
    context,
  }) => {
    const pending = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    await context.route(ROUTING_URL, async (route) => {
      pending.resolve()
      await release.promise
      await fulfillJson(route, 200, journey(route)).catch(() => {})
    })
    await selectArea(page, '11112')
    try {
      await page.click('#check-area-btn')
      await pending.promise
      await page.close()
    } finally {
      release.resolve()
    }
    await reopenSavedArea(await context.newPage(), context)
  })

  test('keeps the previous save when writing new proof fails', async ({
    page,
    context,
  }) => {
    const diagnostics: string[] = []
    page.on('console', (message) => {
      if (message.type() === 'error') diagnostics.push(message.text())
    })
    await page.evaluate(() => {
      Storage.prototype.setItem = () => {
        throw new DOMException('Storage full', 'QuotaExceededError')
      }
    })
    await selectArea(page, '11112')
    await page.click('#check-area-btn')
    const outcome = page.locator('#area-result')
    await expect(outcome).toContainText('Confirmed')
    await expect(outcome).toContainText('Could not save')
    await expect(outcome).not.toContainText('Routing failed')
    expect(diagnostics).toContain(
      'Could not save offline area result QuotaExceededError',
    )
    await reopenSavedArea(page, context)
  })
})
