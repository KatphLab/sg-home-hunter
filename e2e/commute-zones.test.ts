import { expect, type Page, type Route, test } from '@playwright/test'
import {
  fulfillJson,
  INVENTORY_DATE,
  preview,
  selectArea,
  signInViaUi,
  stubCommute,
  submitOneMapCredentials,
} from './commute-fixture.js'

const SEARCH_DATE = '2026-06-02'
const ROUTING_DATE = '06-02-2026'
const SEARCH_DATE_LABEL = 'Tuesday, 2 June'
const CHECKED_FOR_DATE = `Checked for ${SEARCH_DATE_LABEL}`

const previewRiver = async (page: Page): Promise<void> => {
  await page.goto('/')
  await page.fill('#postal-input', '018989')
  await signInViaUi(page)
  await preview(page)
  await selectArea(page, '11111')
}

const actualJourney = (inArea: boolean, arrival = '08:45') => {
  const at = (clock: string) => Date.parse(`${SEARCH_DATE}T${clock}:00+08:00`)
  const bus = (
    stopCode: string,
    service: string,
    start: string,
    end: string,
  ) => ({
    mode: 'BUS',
    from: { stopCode },
    routeShortName: service,
    startTime: at(start),
    endTime: at(end),
  })
  const legs = inArea
    ? [
        bus('88888', '11', '08:10', '08:20'),
        bus('11115', '22', '08:25', '08:35'),
        bus('03218', '33', '08:40', '08:44'),
      ]
    : [bus('88888', '11', '08:25', '08:44')]
  return {
    startTime: legs[0]?.startTime,
    endTime: at(arrival),
    legs: [
      ...legs,
      { mode: 'WALK', startTime: at('08:44'), endTime: at(arrival) },
    ],
  }
}

interface RequestedProbe {
  start: string | null
  time: string | null
  date: string | null
}

const requestedProbe = (route: Route): RequestedProbe => {
  const params = new URL(route.request().url()).searchParams
  return {
    start: params.get('start'),
    time: params.get('time'),
    date: params.get('date'),
  }
}

test.describe('House Hunter PWA acceptance', () => {
  test.beforeEach(async ({ page, context }) => {
    // The next working day follows the observed Vesak Day holiday on Monday.
    await page.clock.setFixedTime(new Date('2026-05-29T09:00:00+08:00'))
    await stubCommute(context)
  })

  test('reports unreadable sign-in response without blaming password', async ({
    page,
  }) => {
    const pending = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    await page.context().route('**/api/auth/post/getToken', async (route) => {
      pending.resolve()
      await release.promise
      await route.abort('failed')
    })

    await page.goto('/')
    await page.fill('#postal-input', '018989')
    await page.click('#start-search-btn')
    await submitOneMapCredentials(page)
    try {
      await pending.promise
      await page.fill('#ride-cap-input', '31')
      await expect(page.locator('#signin-btn')).toBeDisabled()
    } finally {
      release.resolve()
    }

    const alert = page.locator('#auth-error')
    await expect(alert).toBeVisible()
    await expect(alert).toContainText('Couldn’t sign in to OneMap.')
    await expect(alert).not.toContainText('Wrong password')
    await expect(page.locator('#signin-btn')).toBeEnabled()
    await expect(page.locator('#postal-input')).toHaveValue('018989')
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
    await page.fill('#postal-input', '018989')
    await signInViaUi(page)
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
    page,
    context,
  }) => {
    let routingCalls = 0
    let postalLookups = 0
    await context.route('**/api/public/routingsvc/route*', (route) => {
      routingCalls += 1
      return fulfillJson(route, 500, {})
    })
    page.on('request', (request) => {
      if (request.url().includes('/api/common/elastic/search'))
        postalLookups += 1
    })
    await page.goto('/')
    await expect(page.locator('#section-preview')).toBeHidden()
    await expect(page.locator('#signin-form')).toBeHidden()
    await expect(page.locator('#signed-in-bar')).toBeHidden()
    await expect(page.locator('#station-field-group')).toBeHidden()
    await expect(page.locator('#stop-search-btn')).toBeHidden()
    await expect(page.locator('#selected-stop-card')).toBeHidden()
    await page.fill('#postal-input', '018989')
    await signInViaUi(page)
    expect(postalLookups).toBe(0)
    await preview(page)
    await expect(page.locator('#preview-summary')).toContainText(
      '2 estimated stops',
    )
    await expect(page.locator('#preview-summary')).toContainText(
      '1 at least 10 min below cap; 1 less than 10 min below',
    )
    await expect(page.locator('#preview-summary')).toContainText(
      'No routing requests',
    )
    await expect(page.locator('#section-preview')).toContainText(
      'not confidence scores',
    )
    await expect(page.getByText(SEARCH_DATE)).toHaveCount(0)
    await expect(page.getByText(SEARCH_DATE_LABEL)).toHaveCount(0)
    await expect(page.getByText(INVENTORY_DATE)).toHaveCount(0)
    await expect(page.locator('#edit-commute-btn')).toBeHidden()
    await expect(page.locator('#stops-matched-value')).toHaveText('0')
    await expect(page.locator('.stop-row-btn')).toHaveCount(0)
    await expect
      .poll(() =>
        page
          .locator('.leaflet-estimate-pane canvas')
          .evaluate((canvas: HTMLCanvasElement) => {
            const context = canvas.getContext('2d')
            if (!context) throw new Error('Estimate canvas unavailable')
            const pixels = context.getImageData(
              0,
              0,
              canvas.width,
              canvas.height,
            ).data
            const colors = new Uint32Array(pixels.buffer)
            return {
              blue: colors.some(
                (pixel) =>
                  pixel >>> 24 > 0 &&
                  ((pixel >>> 16) & 255) > (pixel & 255) * 1.5,
              ),
              amber: colors.some(
                (pixel) =>
                  pixel >>> 24 > 0 &&
                  (pixel & 255) > ((pixel >>> 16) & 255) * 1.5,
              ),
            }
          }),
      )
      .toEqual({ blue: true, amber: true })
    await expect(page.locator('#selected-stop-card')).toBeHidden()
    await expect(page.locator('#check-area-btn')).toBeDisabled()
    await expect(page.locator('#area-result')).toBeHidden()
    await page.locator('#area-picker summary').press('Enter')
    await page.getByLabel('Filter stops by name or ID').fill('11111')
    await page.getByLabel('Centre the 500 m area on a stop').focus()
    await page.keyboard.press('ArrowDown')
    await expect(page.locator('#area-summary')).toContainText(
      '11111 River Homes: 2 estimated candidates',
    )
    await expect(page.locator('#area-summary')).toContainText(
      'not a walking route',
    )
    const map = page.locator('#map')
    const box = await map.boundingBox()
    if (!box) throw new Error('Map is not visible')
    await map.click({ position: { x: box.width / 2, y: box.height / 2 } })
    await expect(page.locator('#area-summary')).toContainText('Map point')
    await expect(page.locator('#area-summary')).toContainText(
      '2 estimated candidates',
    )
    await expect(page.locator('.leaflet-selection-pane path')).toHaveCount(1)
    await expect(page.locator('.leaflet-commuteZone-pane path')).toHaveCount(0)
    await page.locator('#area-picker summary').press('Enter')
    await page.getByLabel('Centre the 500 m area on a stop').focus()
    await page.keyboard.press('ArrowDown')
    await expect(page.locator('#area-summary')).toContainText(
      '11111 River Homes: 2 estimated candidates',
    )
    await page.fill('#area-stop-filter', 'Changi Village')
    await page.selectOption('#area-stop-select', '88888')
    await expect(page.locator('#area-summary')).toContainText(
      '0 estimated candidates',
    )
    for (const stopId of ['11113', '11114', '44009']) {
      await page.fill('#area-stop-filter', stopId)
      await page.selectOption('#area-stop-select', stopId)
      await expect(page.locator('#area-summary')).toContainText(
        '0 estimated candidates',
      )
    }
    expect(postalLookups).toBe(1)
    expect(routingCalls).toBe(0)
  })

  test('opens the mobile map with the check dock and a keyboard stop picker', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/')
    await page.fill('#postal-input', '018989')
    await signInViaUi(page)
    await page.click('#start-search-btn')
    await expect(page.locator('#section-preview')).toBeVisible()
    await expect(page.locator('#map')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Map' })).toHaveAttribute(
      'aria-current',
      'true',
    )
    await expect(page.locator('#heading-preview')).toBeFocused()
    await expect(page.locator('#area-stop-filter')).toBeHidden()
    await page.locator('#area-picker summary').press('Enter')
    await page.fill('#area-stop-filter', 'River Homes')
    await page.locator('#area-stop-select').focus()
    await page.keyboard.press('ArrowDown')
    await expect(page.locator('#area-summary')).toContainText(
      '2 estimated candidates',
    )
    await page.click('[data-mobile-tab="stops"]')
    await expect(page.locator('#area-summary')).toBeVisible()
    await expect(page.locator('#map')).toBeHidden()
  })

  test('keeps the setup through OneMap connection and editing an empty mobile preview', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/')
    const postal = page.locator('#postal-input')
    const officeStart = page.locator('#office-start-input')
    const rideCap = page.locator('#ride-cap-input')
    const commuteHint = page.locator('#commute-hint')
    const start = page.locator('#start-search-btn')
    const signin = page.locator('#signin-form')
    await expect(signin).toBeHidden()
    await expect(start).toHaveText('Connect OneMap to preview')
    await expect(commuteHint).toHaveAttribute('aria-live', 'polite')
    await expect(commuteHint).toContainText('Arrive 08:45–09:00.')
    await postal.fill('018989')
    await officeStart.fill('08:30')
    await rideCap.fill('1')
    await expect(commuteHint).toContainText('Arrive 08:15–08:30.')
    await expect(commuteHint).toContainText(
      'Your 1-minute ride cap excludes walking and waiting.',
    )
    await start.click()
    await expect(signin).toBeVisible()
    await expect(page.locator('#onemap-email')).toBeFocused()
    await expect(postal).toHaveValue('018989')
    await expect(officeStart).toHaveValue('08:30')
    await expect(rideCap).toHaveValue('1')
    await submitOneMapCredentials(page)
    await expect(signin).toBeHidden()
    await expect(start).toHaveText('Preview estimated stops')
    await expect(page.locator('#section-preview')).toBeHidden()
    await start.click()
    await expect(page.locator('#preview-summary')).toContainText(
      'No estimated stops for this commute. Qualifying journeys may still exist.',
    )
    await page.getByRole('button', { name: 'Edit commute' }).click()
    await expect(postal).toBeFocused()
    await expect(postal).toHaveValue('018989')
    await expect(officeStart).toHaveValue('08:30')
    await expect(rideCap).toHaveValue('1')
    await rideCap.fill('30')
    await start.click()
    await expect(page.locator('#preview-summary')).toContainText(
      '2 estimated stops',
    )
  })

  test('checks ride-sorted departures in bounded batches without repeating overlapping probes', async ({
    page,
    context,
  }) => {
    const probes: RequestedProbe[] = []
    await context.route('**/api/public/routingsvc/route*', (route) => {
      probes.push(requestedProbe(route))
      return fulfillJson(route, 200, { plan: { itineraries: [] } })
    })
    await previewRiver(page)
    const check = page.locator('#check-area-btn')
    const more = page.getByRole('button', { name: 'Check more departures' })
    const outcome = page.locator('#area-result')
    await expect(more).toBeHidden()
    await check.click()
    await expect(outcome).toHaveAttribute('role', 'status')
    await expect(outcome).toContainText('No commute confirmed')
    await expect(outcome).toContainText('3 checks')
    await expect(more).toBeVisible()
    expect(probes).toHaveLength(3)

    await selectArea(page, '11112')
    await expect(outcome).toBeHidden()
    await check.click()
    await expect(outcome).toContainText('3 checks')
    await expect(more).toBeVisible()
    expect(probes).toHaveLength(6)
    await more.click()
    await expect(outcome).toContainText(
      'All planned departures for this area have been checked',
    )
    await expect(outcome).toContainText('2 checks')
    await expect(outcome).not.toContainText('unreachable')
    await expect(more).toBeHidden()
    expect(probes.map(({ start }) => start)).toEqual(
      Array.from({ length: 8 }, (_, index) =>
        index % 2 === 0 ? '1.3,103.85' : '1.3005,103.85',
      ),
    )
    expect(new Set(probes.map(({ date }) => date))).toEqual(
      new Set([ROUTING_DATE]),
    )
    expect(
      new Set(probes.map(({ start, time }) => `${start}@${time}`)).size,
    ).toBe(8)

    await selectArea(page, '11111')
    await check.click()
    await expect(outcome).toContainText('All planned departures')
    await expect(outcome).toContainText('0 checks')
    await expect(more).toBeHidden()
    expect(probes).toHaveLength(8)
  })

  test('restarts probes after constraint edits and rejects proof for a previous search date', async ({
    page,
    context,
  }) => {
    const probes: RequestedProbe[] = []
    await context.route('**/api/public/routingsvc/route*', (route) => {
      probes.push(requestedProbe(route))
      return fulfillJson(route, 200, {
        plan: { itineraries: [actualJourney(true)] },
      })
    })
    await previewRiver(page)
    const outcome = page.locator('#area-result')
    const check = page.locator('#check-area-btn')
    await check.click()
    await expect(outcome).toContainText('Confirmed')

    await page.fill('#ride-cap-input', '25')
    await expect(page.locator('#section-preview')).toBeHidden()
    await preview(page)
    await expect(page.locator('.stop-row-btn')).toHaveCount(0)
    await selectArea(page, '11111')
    await check.click()
    await expect(outcome).toContainText('Confirmed')
    expect(probes[1]).toEqual(probes[0])

    await page.clock.setFixedTime(new Date('2026-06-02T12:00:00+08:00'))
    await preview(page)
    await selectArea(page, '11111')
    await check.click()
    await expect(outcome).toContainText('No commute confirmed')
    await expect(outcome).toContainText('3 checks')
    await expect(page.locator('.stop-row-btn')).toHaveCount(0)
    expect(probes.slice(2).map(({ date }) => date)).toEqual(
      Array(3).fill('06-03-2026'),
    )
  })

  test('confirms an unestimated mobile transfer on continuation and reuses both boardings', async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    let calls = 0
    await context.route('**/api/public/routingsvc/route*', (route) =>
      fulfillJson(route, 200, {
        plan: { itineraries: [actualJourney(++calls === 5, '09:00')] },
      }),
    )
    await previewRiver(page)
    const map = page.locator('#map')
    const box = await map.boundingBox()
    if (!box) throw new Error('Map is not visible')
    await map.click({ position: { x: box.width / 2, y: box.height / 2 } })
    await expect(page.locator('#area-summary')).toContainText('Map point')
    expect(calls).toBe(0)
    const check = page.locator('#check-area-btn')
    const outcome = page.locator('#area-result')
    await check.click()
    await expect(outcome).toContainText('No commute confirmed')
    await expect(outcome).toContainText('3 checks')
    await page.getByRole('button', { name: 'Check more departures' }).click()
    await expect(outcome).toContainText('Confirmed')
    await expect(outcome).toContainText('2 checks')
    const another = page.getByRole('button', {
      name: 'Look for another stop here',
    })
    await expect(another).toBeVisible()
    await expect(check).toBeDisabled()
    await expect(page.locator('#stop-area-btn')).toBeHidden()
    await expect(map).toBeVisible()

    const journey = page.locator('#selected-stop-card')
    await expect(journey).toBeVisible()
    for (const detail of [
      '11115',
      'River Transfer',
      '08:25',
      '14 min',
      '09:00',
      'Bus 22 → Bus 33',
    ]) {
      await expect(journey).toContainText(detail)
    }
    await expect(journey).not.toContainText('Bus 11')
    const checkedFor = page.locator('#selected-journey-date')
    await expect(checkedFor).toHaveText(CHECKED_FOR_DATE)
    await expect(checkedFor).toHaveAttribute('datetime', SEARCH_DATE)
    await expect(page.getByText(SEARCH_DATE_LABEL)).toHaveCount(1)
    await expect(page.getByText(SEARCH_DATE)).toHaveCount(0)
    await expect(page.getByText(INVENTORY_DATE)).toHaveCount(0)

    await another.click()
    await expect(outcome).toContainText('No additional stop confirmed.')
    await expect(outcome).toContainText('No more planned departures')
    await expect(another).toBeHidden()
    await expect(journey).toContainText('11115')

    // Reuse both the transfer in an overlapping circle and the outside boarding.
    for (const [centre, boarding] of [
      ['11116', '11115'],
      ['88888', '88888'],
    ] as const) {
      await expect(
        page.locator(`.stop-row-btn[data-stop-id="${boarding}"]`),
      ).toHaveCount(1)
      await selectArea(page, centre)
      await expect(page.locator('#area-summary')).toContainText(
        '0 estimated candidates',
      )
      await expect(outcome).toBeHidden()
      await expect(journey).toBeHidden()
      await check.click()
      await expect(outcome).toContainText('Confirmed')
      await expect(outcome).toContainText('0 checks')
      await expect(journey).toContainText(boarding)
      expect(calls).toBe(8)
    }
  })

  test('does not confirm when the final walk ends after the arrival window', async ({
    page,
    context,
  }) => {
    await context.route('**/api/public/routingsvc/route*', (route) =>
      fulfillJson(route, 200, {
        plan: { itineraries: [actualJourney(true, '09:01')] },
      }),
    )
    await previewRiver(page)
    await page.click('#check-area-btn')
    const outcome = page.locator('#area-result')
    await expect(outcome).toContainText('No commute confirmed')
    await expect(outcome).toContainText('3 checks')
    await expect(page.locator('#selected-stop-card')).toBeHidden()
    await expect(page.locator('.stop-row-btn')).toHaveCount(0)
  })

  test('discarding a pending check when the circle moves prevents stale proof', async ({
    page,
    context,
  }) => {
    const pending = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const sent = Promise.withResolvers<void>()
    await context.route('**/api/public/routingsvc/route*', async (route) => {
      pending.resolve()
      await release.promise
      try {
        await fulfillJson(route, 200, {
          plan: { itineraries: [actualJourney(true)] },
        })
      } finally {
        sent.resolve()
      }
    })
    await previewRiver(page)
    const check = page.locator('#check-area-btn')
    const stop = page.locator('#stop-area-btn')
    try {
      await check.click()
      await pending.promise
      await expect(check).toBeDisabled()
      await expect(stop).toBeVisible()
      await selectArea(page, '88888')
      await expect(stop).toBeHidden()
    } finally {
      release.resolve()
    }
    await sent.promise
    await expect(check).toBeEnabled()
    await expect(page.locator('#area-result')).toBeHidden()
    await expect(page.locator('#selected-stop-card')).toBeHidden()
    await expect(page.locator('.stop-row-btn')).toHaveCount(0)
  })

  test('station filtering preserves the exact zero-ride proof and checked departures', async ({
    page,
    context,
  }) => {
    let routingCalls = 0
    await context.route('**/api/public/routingsvc/route*', (route) => {
      routingCalls += 1
      return fulfillJson(route, 200, { plan: { itineraries: [] } })
    })
    await page.goto('/')
    await page.click('input[name="workplace-kind"][value="station"]')
    await page.selectOption('#station-select', 'NS17')
    await signInViaUi(page)
    await preview(page)
    await expect(page.locator('#stops-matched-value')).toHaveText('1')
    await expect(
      page.locator('.stop-row-btn[data-stop-id="CC15"]'),
    ).toHaveCount(0)
    await expect(page.locator('.leaflet-commuteZone-pane')).toHaveCSS(
      'opacity',
      '0.34',
    )
    await expect(page.locator('.leaflet-commuteZone-pane path')).toHaveCount(1)
    await selectArea(page, 'CC15')
    await page.click('#check-area-btn')
    await expect(page.locator('#area-result')).toContainText('Confirmed')
    await expect(page.locator('#area-result')).toContainText('0 checks')
    await expect(page.locator('#selected-stop-id')).toHaveText('NS17')
    await expect(page.locator('#selected-ride-duration')).toHaveText('0 min')
    await expect(page.locator('#selected-arrival-time')).toHaveText('09:00')
    expect(routingCalls).toBe(0)
    await selectArea(page, '65009')
    await page.click('#check-area-btn')
    await expect(page.locator('#area-result')).toContainText('3 checks')
    await page.fill('#station-filter-input', 'Marymount')
    await expect(page.locator('#station-select')).toHaveValue('NS17')
    await expect(
      page.locator('.stop-row-btn[data-stop-id="NS17"]'),
    ).toHaveCount(1)
    await page.click('#check-more-btn')
    await expect(page.locator('#area-result')).toContainText(
      '1 check performed',
    )
    expect(routingCalls).toBe(4)
    await page.selectOption('#station-select', 'CC16')
    await expect(page.locator('#section-preview')).toBeHidden()
    await expect(page.locator('#selected-stop-card')).toBeHidden()
    await expect(page.locator('.stop-row-btn')).toHaveCount(0)
    await expect(page.locator('.leaflet-commuteZone-pane path')).toHaveCount(0)
  })

  test('invalidates in-flight lookup on edits, stop, and disconnect', async ({
    page,
    context,
  }) => {
    const lookupGate = Promise.withResolvers<void>()
    let lookups = 0
    await context.route('**/api/common/elastic/search*', async (route) => {
      lookups += 1
      await lookupGate.promise
      await fulfillJson(route, 200, {
        results: [
          {
            POSTAL: '018989',
            LATITUDE: '1.2789',
            LONGITUDE: '103.8536',
            ADDRESS: 'Marina Gardens',
          },
        ],
      })
    })
    await page.goto('/')
    await page.fill('#postal-input', '018989')
    await signInViaUi(page)
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
    await expect(page.locator('#start-search-btn')).toBeEnabled()
    await expect(page.locator('#start-search-btn')).toHaveText(
      'Connect OneMap to preview',
    )
    await expect(page.locator('#result-status-tag')).not.toHaveText(
      'Estimated preview',
    )
  })

  test('restores a previously completed map offline after an interrupted lookup', async ({
    page,
    context,
  }) => {
    // A previously completed result uses the unchanged v1 storage contract.
    const saved = {
      version: 1,
      completedAtIso: '2026-06-02T01:00:00Z',
      inventoryDate: INVENTORY_DATE,
      workplace: {
        kind: 'postal',
        postalCode: '018989',
        label: '18 MARINA GARDENS DR',
        point: { latitude: 1.2789, longitude: 103.8536 },
      },
      constraints: {
        searchDate: '2026-06-02',
        officeStart: '09:00',
        rideCapMinutes: 40,
      },
      triedCount: 9,
      totalCount: 9,
      matches: [
        {
          stop: {
            id: '65009',
            kind: 'bus',
            name: 'Punggol Temp Int',
            point: { latitude: 1.4036, longitude: 103.9022 },
          },
          journey: {
            stopId: '65009',
            searchDate: '2026-06-02',
            boardingAtMs: Date.parse('2026-06-02T08:25:00+08:00'),
            arrivalAtMs: Date.parse('2026-06-02T08:52:00+08:00'),
            rideMs: 27 * 60_000,
            services: [{ id: '116', name: '116', mode: 'BUS' }],
            isAtDestination: false,
          },
        },
      ],
    }
    await page.goto('/')
    await page.evaluate(async (snapshot) => {
      await navigator.serviceWorker.ready
      localStorage.setItem(
        'house-hunter:last-completed-result:v1',
        JSON.stringify(snapshot),
      )
    }, saved)
    await page.reload()
    await signInViaUi(page)
    await page.fill('#postal-input', '123')
    await page.click('#start-search-btn')
    await expect(page.locator('#search-error')).toContainText('6-digit')
    await expect(page.locator('#result-status-tag')).toHaveText(
      'Saved offline result',
    )
    await expect(page.locator('.stop-row-btn')).toBeVisible()
    await page.fill('#postal-input', '018989')

    await preview(page)
    await expect(page.locator('.stop-row-btn')).toHaveCount(0)
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
    await page.clock.setFixedTime(new Date('2026-06-03T12:00:00+08:00'))
    await page.reload()
    await expect(page.locator('#result-status-tag')).toHaveText(
      'Saved offline result',
    )
    await expect(page.locator('#active-constraints-summary')).toContainText(
      'Ride cap 40 min',
    )
    await page.click('.stop-plaque-marker[data-stop-id="65009"]')
    await expect(page.locator('#selected-stop-name')).toHaveText(
      'Punggol Temp Int',
    )
    await expect(page.locator('#selected-services')).toHaveText('Bus 116')
    const checkedFor = page.locator('#selected-journey-date')
    await expect(checkedFor).toHaveText(CHECKED_FOR_DATE)
    await expect(checkedFor).toHaveAttribute('datetime', SEARCH_DATE)
    await expect(
      page.locator('.stop-row-btn[data-stop-id="65009"]'),
    ).toBeVisible()
  })

  test('exhaustion keeps failed and stopped probes distinct from completed checks', async ({
    page,
    context,
  }) => {
    const probes: RequestedProbe[] = []
    const pending = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    await context.route('**/api/public/routingsvc/route*', async (route) => {
      probes.push(requestedProbe(route))
      if (probes.length === 1) return fulfillJson(route, 400, {})
      if (probes.length === 2) {
        pending.resolve()
        await release.promise
        return fulfillJson(route, 200, {
          plan: { itineraries: [actualJourney(true)] },
        })
      }
      return fulfillJson(route, 200, { plan: { itineraries: [] } })
    })
    await previewRiver(page)
    const check = page.locator('#check-area-btn')
    const more = page.getByRole('button', { name: 'Check more departures' })
    const outcome = page.locator('#area-result')
    await check.click()
    await expect(outcome).toContainText('Routing failed')
    await expect(outcome).not.toContainText('No commute confirmed')
    await expect(outcome).toContainText('1 check performed')
    try {
      await more.click()
      await pending.promise
      await page.click('#stop-area-btn')
      await expect(outcome).toContainText('Stopped')
      await expect(outcome).toContainText('1 check performed')
    } finally {
      release.resolve()
    }
    for (let batch = 0; batch < 2; batch += 1) {
      await more.click()
      await expect(outcome).toContainText('3 checks')
    }
    const incomplete = '2 attempted checks failed or were interrupted'
    await expect(outcome).toContainText(incomplete)
    await expect(outcome).not.toContainText('All planned departures')
    await expect(page.locator('#selected-stop-card')).toBeHidden()
    await expect(page.locator('#stops-tried-value')).toHaveText('2 / 2')
    await selectArea(page, '11112')
    await check.click()
    await expect(outcome).toContainText(incomplete)
    await expect(outcome).toContainText('0 checks')
    expect(probes).toHaveLength(8)
    expect(
      new Set(probes.map(({ start, time }) => `${start}@${time}`)).size,
    ).toBe(8)
  })

  test('ends planning and announces worker failure', async ({
    page,
    context,
  }) => {
    await context.route('**/planner-worker.js', (route) =>
      route.fulfill({
        contentType: 'text/javascript',
        body: 'throw new Error("Fixture planner failure")',
      }),
    )
    await page.goto('/')
    await page.fill('#postal-input', '018989')
    await signInViaUi(page)
    await page.click('#start-search-btn')
    await expect(page.locator('#search-error')).toContainText(
      'Fixture planner failure',
    )
    await expect(page.locator('#result-status-tag')).not.toContainText(
      'Planning',
    )
    await expect(page.locator('#live-status-region')).toHaveText(
      'Unable to prepare preview.',
    )
    await expect(page.locator('#stop-search-btn')).toBeHidden()
  })
})
