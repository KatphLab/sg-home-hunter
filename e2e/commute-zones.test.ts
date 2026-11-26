import {
  type BrowserContext,
  expect,
  type Page,
  type Route,
  test,
} from '@playwright/test'

const TEST_INVENTORY_TSV = [
  'inventoryDate\t2026-11-20',
  'id\tkind\tname\tlatitude\tlongitude',
  '03218\tbus\tMarina Gardens Opp\t1.279100\t103.854000',
  '11111\tbus\tRiver Homes\t1.300000\t103.850000',
  '11112\tbus\tRiver Gardens\t1.300500\t103.850000',
  '11113\tbus\tOver Cap Homes\t1.310000\t103.850000',
  '11114\tbus\tUncovered Homes\t1.320000\t103.850000',
  '11115\tbus\tRiver Transfer\t1.300800\t103.850000',
  '11116\tbus\tRiver Edge\t1.305100\t103.850000',
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

const selectArea = async (page: Page, stopId: string): Promise<void> => {
  await page.fill('#area-stop-filter', stopId)
  await page.selectOption('#area-stop-select', stopId)
}

const expectInterrupted = async (page: Page, change: string): Promise<void> => {
  if (change === 'stop') {
    await expect(page.locator('#area-result')).toContainText('Stopped')
    await expect(page.locator('#area-result')).toContainText('1 check')
  } else if (change === 'selection') {
    await expect(page.locator('#area-result')).toBeHidden()
    await expect(page.locator('#check-area-btn')).toBeEnabled()
  } else if (change === 'sign out') {
    await expect(page.locator('#check-area-btn')).toBeDisabled()
  } else {
    await expect(page.locator('#section-preview')).toBeHidden()
  }
}

const previewRiver = async (page: Page): Promise<string> => {
  await page.goto('/')
  await signInViaUi(page)
  await page.fill('#postal-input', '018989')
  await page.fill('#office-start-input', '09:00')
  await page.click('#start-search-btn')
  await expect(page.locator('#result-status-tag')).toHaveText(
    'Estimated preview',
  )
  await expect(page.locator('#check-area-btn')).toBeDisabled()
  await expect(page.locator('#area-result')).toBeHidden()
  await expect(page.locator('#area-journey')).toBeHidden()
  await selectArea(page, '11111')
  await expect(page.locator('#area-summary')).toContainText(
    '2 estimated candidates',
  )
  await expect(page.locator('#check-area-btn')).toBeEnabled()
  const date = await page.locator('#planned-search-date').textContent()
  if (date === null) throw new Error('Search date missing')
  return date.trim()
}

const actualJourney = (
  searchDate: string,
  inArea: boolean,
  arrival = '08:45',
) => {
  const at = (clock: string) => Date.parse(`${searchDate}T${clock}:00+08:00`)
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
    await page.clock.setFixedTime(new Date('2026-05-29T09:00:00+08:00'))
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
    await expect(page.locator('#result-status-tag')).toHaveText(
      'Estimated preview',
    )
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
    await page
      .getByLabel('Find an area centre by stop name or ID')
      .fill('11111')
    await page.getByLabel('Centre the 500 m area on a stop').focus()
    await page.keyboard.press('ArrowDown')
    await expect(page.locator('#area-summary')).toContainText(
      '11111 River Homes: 2 estimated candidates',
    )
    await expect(page.locator('#area-summary')).toContainText(
      'Not a walking route',
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

  test('keeps the stop picker and area count usable without a map on mobile', async ({
    page,
  }) => {
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
    await expect(page.locator('#area-summary')).toContainText(
      '2 estimated candidates',
    )
    await page.click('[data-mobile-tab="stops"]')
    await expect(page.locator('#area-summary')).toBeVisible()
  })

  test('spends three logical probes in ride-sorted round-robin order, retaining tried departures', async ({
    page,
    context,
  }) => {
    const probes: RequestedProbe[] = []
    await context.route('**/api/public/routingsvc/route*', (route) => {
      probes.push(requestedProbe(route))
      return fulfillJson(route, 200, { plan: { itineraries: [] } })
    })
    const searchDate = await previewRiver(page)
    await page.click('#check-area-btn')
    const outcome = page.locator('#area-result')
    await expect(outcome).toHaveAttribute('role', 'status')
    await expect(outcome).toContainText('Not confirmed')
    await expect(outcome).toContainText('3 checks')
    await expect(outcome).not.toContainText('unreachable')
    await expect(page.locator('#check-area-btn')).toBeDisabled()
    await expect(page.locator('#stop-area-btn')).toBeHidden()
    expect(probes.map((probe) => probe.start)).toEqual([
      '1.3,103.85',
      '1.3005,103.85',
      '1.3,103.85',
    ])
    expect(probes[0]?.time).not.toBe(probes[2]?.time)
    const [year, month, day] = searchDate.split('-')
    expect(
      probes.every((probe) => probe.date === `${month}-${day}-${year}`),
    ).toBe(true)
    await selectArea(page, '11112')
    await expect(outcome).toBeHidden()
    await page.click('#check-area-btn')
    await expect(outcome).toContainText('Not confirmed')
    await expect(outcome).toContainText('3 checks')
    expect(probes).toHaveLength(6)
    expect(
      new Set(probes.map((probe) => `${probe.start}@${probe.time}`)).size,
    ).toBe(6)
  })

  test('continues only new departures in bounded batches until planned probes are exhausted', async ({
    page,
    context,
  }) => {
    const probes: RequestedProbe[] = []
    await context.route('**/api/public/routingsvc/route*', (route) => {
      probes.push(requestedProbe(route))
      return fulfillJson(route, 200, { plan: { itineraries: [] } })
    })
    await previewRiver(page)
    const more = page.getByRole('button', { name: 'Check more departures' })
    const outcome = page.locator('#area-result')
    await expect(more).toBeHidden()
    await page.click('#check-area-btn')
    await expect(outcome).toContainText('3 checks')
    await expect(more).toBeVisible()
    await more.click()
    await expect(outcome).toContainText('Not confirmed')
    await expect(outcome).toContainText('3 checks')
    await expect(more).toBeVisible()
    expect(probes.map((probe) => probe.start)).toEqual([
      '1.3,103.85',
      '1.3005,103.85',
      '1.3,103.85',
      '1.3005,103.85',
      '1.3,103.85',
      '1.3005,103.85',
    ])
    await more.click()
    await expect(outcome).toContainText(
      'All planned departures for this area have been checked',
    )
    await expect(outcome).toContainText('2 checks')
    await expect(outcome).not.toContainText('unreachable')
    await expect(more).toBeHidden()
    expect(probes).toHaveLength(8)
    expect(
      new Set(probes.map((probe) => `${probe.start}@${probe.time}`)).size,
    ).toBe(8)
    await selectArea(page, '11112')
    await page.click('#check-area-btn')
    await expect(outcome).toContainText('All planned departures')
    await expect(outcome).toContainText('0 checks')
    await expect(more).toBeHidden()
    expect(probes).toHaveLength(8)
  })

  test('a later batch stops on actual in-area proof and overlapping selection reuses unchanged evidence', async ({
    page,
    context,
  }) => {
    let searchDate = ''
    const probes: RequestedProbe[] = []
    await context.route('**/api/public/routingsvc/route*', (route) => {
      probes.push(requestedProbe(route))
      return fulfillJson(route, 200, {
        plan: { itineraries: [actualJourney(searchDate, probes.length === 5)] },
      })
    })
    searchDate = await previewRiver(page)
    await page.click('#check-area-btn')
    await expect(page.locator('#area-result')).toContainText('Not confirmed')
    await expect(page.locator('#area-result')).toContainText('3 checks')
    await page.getByRole('button', { name: 'Check more departures' }).click()
    await expect(page.locator('#area-result')).toContainText('Confirmed')
    await expect(page.locator('#area-result')).toContainText('2 checks')
    expect(probes.map((probe) => probe.start)).toEqual([
      '1.3,103.85',
      '1.3005,103.85',
      '1.3,103.85',
      '1.3005,103.85',
      '1.3,103.85',
    ])
    expect(
      new Set(probes.map((probe) => `${probe.start}@${probe.time}`)).size,
    ).toBe(5)
    await expect(page.locator('#check-more-btn')).toBeHidden()
    const evidence = await page.locator('#area-journey').textContent()
    if (evidence === null) throw new Error('Confirmed journey missing')
    expect(evidence).toContain(searchDate)
    expect(evidence).toContain('11115 River Transfer')
    await selectArea(page, '11116')
    await page.click('#check-area-btn')
    await expect(page.locator('#area-result')).toContainText('Confirmed')
    await expect(page.locator('#area-result')).toContainText('0 checks')
    await expect(page.locator('#area-journey')).toHaveText(evidence)
    expect(probes).toHaveLength(5)
  })

  for (const change of [
    'workplace',
    'search date',
    'office start',
    'ride cap',
  ] as const) {
    test(`starts fresh verification after changing ${change}, without reusing old proof`, async ({
      page,
      context,
    }) => {
      await page.clock.setFixedTime(new Date('2026-11-25T12:00:00+08:00'))
      let searchDate = ''
      let confirmed = false
      const probes: RequestedProbe[] = []
      await context.route('**/api/public/routingsvc/route*', (route) => {
        probes.push(requestedProbe(route))
        return fulfillJson(route, 200, {
          plan: {
            itineraries: confirmed ? [] : [actualJourney(searchDate, true)],
          },
        })
      })
      searchDate = await previewRiver(page)
      await page.click('#check-area-btn')
      await expect(page.locator('#area-result')).toContainText('Confirmed')
      confirmed = true
      const changeSearch = {
        'office start': () => page.fill('#office-start-input', '08:55'),
        'ride cap': () => page.fill('#ride-cap-input', '25'),
        'search date': () =>
          page.clock.setFixedTime(new Date('2026-11-26T12:00:00+08:00')),
        workplace: async () => {
          await context.route('**/api/common/elastic/search*', (route) =>
            fulfillJson(route, 200, {
              results: [
                {
                  POSTAL: '018988',
                  LATITUDE: '1.2790',
                  LONGITUDE: '103.8536',
                  ADDRESS: 'Other workplace',
                },
              ],
            }),
          )
          await page.fill('#postal-input', '018988')
        },
      }
      await changeSearch[change]()
      await page.click('#start-search-btn')
      await expect(page.locator('#result-status-tag')).toHaveText(
        'Estimated preview',
      )
      await expect(page.locator('#area-journey')).toBeHidden()
      await expect(
        page.locator('.stop-row-btn[data-stop-id="11115"]'),
      ).toHaveCount(0)
      if (change === 'search date') {
        await expect(page.locator('#planned-search-date')).not.toHaveText(
          searchDate,
        )
      }
      await selectArea(page, '11111')
      await page.click('#check-area-btn')
      await expect(page.locator('#area-result')).toContainText('Not confirmed')
      await expect(page.locator('#area-result')).toContainText('3 checks')
      await expect(page.locator('#area-journey')).toBeHidden()
      expect(probes).toHaveLength(4)
      if (change === 'ride cap') expect(probes[1]).toEqual(probes[0])
    })
  }

  for (const arrival of ['08:45', '09:00']) {
    test(`retains outside proof then stops on an unestimated transfer, including final walk to ${arrival}`, async ({
      page,
      context,
    }) => {
      await page.setViewportSize({ width: 390, height: 844 })
      let searchDate = ''
      const probes: RequestedProbe[] = []
      await context.route('**/api/public/routingsvc/route*', (route) => {
        probes.push(requestedProbe(route))
        return fulfillJson(route, 200, {
          plan: {
            itineraries: [
              actualJourney(searchDate, probes.length > 1, arrival),
            ],
          },
        })
      })
      searchDate = await previewRiver(page)
      await page.click('[data-mobile-tab="stops"]')
      await page.click('#check-area-btn')
      await expect(page.locator('#area-result')).toContainText('Confirmed')
      await expect(page.locator('#area-result')).toContainText('2 checks')
      expect(probes.map((probe) => probe.start)).toEqual([
        '1.3,103.85',
        '1.3005,103.85',
      ])
      const journey = page.locator('#section-preview #area-journey')
      await expect(journey).toBeVisible()
      for (const detail of [
        '11115',
        'River Transfer',
        searchDate,
        '08:25',
        '14 min',
        arrival,
        'Bus 22 → Bus 33',
      ]) {
        await expect(journey).toContainText(detail)
      }
      await expect(journey).not.toContainText('Bus 11')
      await expect(page.locator('#map')).toBeHidden()
      await expect(page.locator('#check-area-btn')).toBeDisabled()
      await expect(page.locator('#stop-area-btn')).toBeHidden()
      await expect(
        page.locator('.stop-row-btn[data-stop-id="88888"]'),
      ).toHaveCount(1)
      await expect(
        page.locator('.stop-row-btn[data-stop-id="11115"]'),
      ).toHaveCount(1)
      // An overlapping circle has no estimates but contains the proven transfer.
      await selectArea(page, '11116')
      await expect(page.locator('#area-summary')).toContainText(
        '0 estimated candidates',
      )
      await expect(page.locator('#area-result')).toBeHidden()
      await page.click('#check-area-btn')
      await expect(page.locator('#area-result')).toContainText('Confirmed')
      await expect(page.locator('#area-result')).toContainText('0 checks')
      await expect(journey).toContainText('11115')
      expect(probes).toHaveLength(2)
      // The outside boarding retained from the first response answers an empty preview circle.
      await selectArea(page, '88888')
      await expect(page.locator('#area-summary')).toContainText(
        '0 estimated candidates',
      )
      await expect(page.locator('#area-result')).toBeHidden()
      await expect(journey).toBeHidden()
      await page.click('#check-area-btn')
      await expect(page.locator('#area-result')).toContainText('Confirmed')
      await expect(page.locator('#area-result')).toContainText('0 checks')
      await expect(journey).toContainText('88888')
      expect(probes).toHaveLength(2)
    })
  }

  test('an empty circle makes no requests and is not called unreachable', async ({
    page,
    context,
  }: {
    page: Page
    context: BrowserContext
  }) => {
    let calls = 0
    await context.route('**/api/public/routingsvc/route*', (route) => {
      calls += 1
      return fulfillJson(route, 200, { plan: { itineraries: [] } })
    })
    await previewRiver(page)
    await selectArea(page, '88888')
    await page.click('#check-area-btn')
    await expect(page.locator('#area-result')).toContainText(
      'No estimated candidates',
    )
    await expect(page.locator('#area-result')).toContainText('0 checks')
    await expect(page.locator('#area-result')).not.toContainText('unreachable')
    expect(calls).toBe(0)
  })

  for (const arrival of ['08:44', '09:01']) {
    test(`does not confirm a journey arriving outside the window at ${arrival}`, async ({
      page,
      context,
    }) => {
      let searchDate = ''
      let calls = 0
      await context.route('**/api/public/routingsvc/route*', (route) => {
        calls += 1
        return fulfillJson(route, 200, {
          plan: { itineraries: [actualJourney(searchDate, true, arrival)] },
        })
      })
      searchDate = await previewRiver(page)
      await page.click('#check-area-btn')
      await expect(page.locator('#area-result')).toContainText('Not confirmed')
      await expect(page.locator('#area-result')).toContainText('3 checks')
      await expect(page.locator('#area-journey')).toBeHidden()
      await expect(page.locator('.stop-row-btn')).toHaveCount(0)
      expect(calls).toBe(3)
    })
  }

  for (const failure of ['auth', 'network'] as const) {
    test(`reports ${failure} separately from negative journey evidence`, async ({
      page,
      context,
    }) => {
      const probes: RequestedProbe[] = []
      await context.route('**/api/public/routingsvc/route*', (route) => {
        probes.push(requestedProbe(route))
        return failure === 'auth'
          ? fulfillJson(route, 401, { error: 'expired' })
          : route.abort('failed')
      })
      await previewRiver(page)
      await page.click('#check-area-btn')
      const outcome = page.locator('#area-result')
      await expect(outcome).toContainText(
        failure === 'auth' ? 'Sign-in expired' : 'Routing failed',
        { timeout: 20_000 },
      )
      await expect(outcome).toContainText('1 check')
      await expect(outcome).not.toContainText('Not confirmed')
      await expect(page.locator('#area-journey')).toBeHidden()
      await expect(page.locator('#stop-area-btn')).toBeHidden()
      await expect(page.locator('#check-area-btn')).toBeDisabled()
      expect(probes).toHaveLength(failure === 'auth' ? 1 : 4)
      expect(
        new Set(probes.map((probe) => `${probe.start}@${probe.time}`)).size,
      ).toBe(1)
    })
  }

  for (const change of [
    'stop',
    'selection',
    'workplace',
    'office start',
    'ride cap',
    'sign out',
  ] as const) {
    test(`discards an in-flight response after ${change}`, async ({
      page,
      context,
    }) => {
      const responseGate = Promise.withResolvers<void>()
      const responseSent = Promise.withResolvers<void>()
      let calls = 0
      let searchDate = ''
      await context.route('**/api/public/routingsvc/route*', async (route) => {
        calls += 1
        await responseGate.promise
        try {
          await fulfillJson(route, 200, {
            plan: { itineraries: [actualJourney(searchDate, true)] },
          })
        } finally {
          responseSent.resolve()
        }
      })
      searchDate = await previewRiver(page)
      await page.click('#check-area-btn')
      await expect.poll(() => calls).toBe(1)
      await expect(page.locator('#check-area-btn')).toBeDisabled()
      await expect(page.locator('#stop-area-btn')).toBeVisible()
      try {
        const interrupt = {
          stop: () => page.click('#stop-area-btn'),
          selection: () => selectArea(page, '88888'),
          workplace: () => page.fill('#postal-input', '018988'),
          'office start': () => page.fill('#office-start-input', '08:30'),
          'ride cap': () => page.fill('#ride-cap-input', '15'),
          'sign out': () => page.click('#signout-btn'),
        }
        await interrupt[change]()
        await expect(page.locator('#stop-area-btn')).toBeHidden()
      } finally {
        responseGate.resolve()
      }
      await responseSent.promise
      await expect(page.locator('#area-journey')).toBeHidden()
      await expect(page.locator('#area-result')).not.toContainText('Confirmed')
      expect(calls).toBe(1)
      await expectInterrupted(page, change)
      await expect(
        page.locator('.stop-row-btn[data-stop-id="11115"]'),
      ).toHaveCount(0)
    })
  }

  test('preserves only the exact destination station zero-ride exception', async ({
    page,
    context,
  }) => {
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
    await expect(page.locator('#result-status-tag')).toHaveText(
      'Estimated preview',
    )
    await expect(page.locator('#stops-matched-value')).toHaveText('1')
    await expect(
      page.locator('.stop-row-btn[data-stop-id="CC15"]'),
    ).toHaveCount(0)
    await page.click('.stop-row-btn[data-stop-id="NS17"]')
    await expect(page.locator('#selected-ride-duration')).toHaveText('0 min')
    await expect(page.locator('#selected-arrival-time')).toHaveText('09:00')
    await expect(page.locator('.leaflet-commuteZone-pane')).toHaveCSS(
      'opacity',
      '0.34',
    )
    await expect(page.locator('.leaflet-commuteZone-pane path')).toHaveCount(1)
    expect(routingCalls).toBe(0)
    await selectArea(page, 'CC15')
    await page.click('#check-area-btn')
    await expect(page.locator('#area-result')).toContainText('Confirmed')
    await expect(page.locator('#area-result')).toContainText('0 checks')
    await expect(page.locator('#area-journey')).toContainText('NS17')
    await expect(page.locator('#area-journey')).toContainText('0 min')
    await expect(page.locator('#area-journey')).toContainText('09:00')
    expect(routingCalls).toBe(0)
    await page.fill('#ride-cap-input', '15')
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
    await expect(page.locator('#result-status-tag')).not.toHaveText(
      'Estimated preview',
    )
  })

  test('retains an existing completed offline map through previews and interrupted lookup', async ({
    page,
    context,
  }) => {
    // A previously completed result uses the unchanged v1 storage contract.
    const saved = {
      version: 1,
      completedAtIso: '2026-06-02T01:00:00Z',
      inventoryDate: '2026-11-20',
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
    await expect(page.locator('#result-status-tag')).toHaveText(
      'Saved offline result',
    )
    await signInViaUi(page)
    await page.fill('#postal-input', '018989')
    await page.click('#start-search-btn')
    await expect(page.locator('#result-status-tag')).toHaveText(
      'Estimated preview',
    )
    await expect(page.locator('.stop-row-btn')).toHaveCount(0)
    expect(
      await page.evaluate(() =>
        JSON.parse(
          localStorage.getItem('house-hunter:last-completed-result:v1') ??
            'null',
        ),
      ),
    ).toEqual(saved)
    await context.route('**/api/public/routingsvc/route*', (route) =>
      fulfillJson(route, 200, { plan: { itineraries: [] } }),
    )
    await selectArea(page, '11111')
    await page.click('#check-area-btn')
    await expect(page.locator('#area-result')).toContainText('Not confirmed')
    expect(
      await page.evaluate(() =>
        JSON.parse(
          localStorage.getItem('house-hunter:last-completed-result:v1') ??
            'null',
        ),
      ),
    ).toEqual(saved)
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
    await expect(page.locator('#account-status-pill')).toHaveText(
      'Not connected',
    )
    await expect(page.locator('#section-preview')).toBeHidden()
    await expect(page.locator('#result-status-tag')).toHaveText(
      'Saved offline result',
    )
    await expect(page.locator('#active-constraints-summary')).toContainText(
      'Date 2026-06-02',
    )
    await expect(page.locator('#active-constraints-summary')).toContainText(
      'Ride cap 40 min',
    )
    await page.click('.stop-plaque-marker[data-stop-id="65009"]')
    await expect(page.locator('#selected-stop-name')).toHaveText(
      'Punggol Temp Int',
    )
    await expect(page.locator('#selected-services')).toHaveText('Bus 116')
    await expect(
      page.locator('.stop-row-btn[data-stop-id="65009"]'),
    ).toBeVisible()
  })
  for (const interruption of ['failure', 'stop'] as const) {
    test(`keeps ${interruption} distinct after exhausting and reselecting an overlapping area`, async ({
      page,
      context,
    }) => {
      const probes: RequestedProbe[] = []
      const gate = Promise.withResolvers<void>()
      await context.route('**/api/public/routingsvc/route*', async (route) => {
        probes.push(requestedProbe(route))
        if (probes.length === 1) {
          if (interruption === 'failure') return fulfillJson(route, 400, {})
          await gate.promise
        }
        return fulfillJson(route, 200, { plan: { itineraries: [] } })
      })
      await previewRiver(page)
      await page.click('#check-area-btn')
      if (interruption === 'stop') {
        await expect.poll(() => probes.length).toBe(1)
        await page.click('#stop-area-btn')
        gate.resolve()
      } else {
        await expect(page.locator('#area-result')).toContainText(
          'Routing failed',
        )
      }
      const more = page.getByRole('button', { name: 'Check more departures' })
      await more.click()
      await expect(page.locator('#area-result')).toContainText('3 checks')
      await more.click()
      await expect(page.locator('#area-result')).toContainText('3 checks')
      await more.click()
      await expect(page.locator('#area-result')).toContainText(
        '1 attempted checks failed or were interrupted',
      )
      await expect(page.locator('#area-result')).not.toContainText(
        'All planned departures',
      )
      await expect(page.locator('#stops-tried-value')).toHaveText('2 / 2')
      await selectArea(page, '11112')
      await page.click('#check-area-btn')
      await expect(page.locator('#area-result')).toContainText(
        '1 attempted checks failed or were interrupted',
      )
      await expect(page.locator('#area-result')).toContainText('0 checks')
      expect(probes).toHaveLength(8)
      expect(
        new Set(probes.map((probe) => `${probe.start}@${probe.time}`)).size,
      ).toBe(8)
    })
  }

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
    await signInViaUi(page)
    await page.fill('#postal-input', '018989')
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

  test('station name filtering preserves exact workplace proof and checked departures', async ({
    page,
    context,
  }: {
    page: Page
    context: BrowserContext
  }) => {
    let calls = 0
    await context.route('**/api/public/routingsvc/route*', (route) => {
      calls += 1
      return fulfillJson(route, 200, { plan: { itineraries: [] } })
    })
    await page.goto('/')
    await signInViaUi(page)
    await page.click('input[name="workplace-kind"][value="station"]')
    await page.selectOption('#station-select', 'NS17')
    await page.click('#start-search-btn')
    await expect(page.locator('#result-status-tag')).toHaveText(
      'Estimated preview',
    )
    await selectArea(page, '65009')
    await page.click('#check-area-btn')
    await expect(page.locator('#area-result')).toContainText('3 checks')
    await page.fill('#station-filter-input', 'Bishan')
    await expect(page.locator('#station-select')).toHaveValue('NS17')
    await expect(page.locator('#section-preview')).toBeVisible()
    await expect(
      page.locator('.stop-row-btn[data-stop-id="NS17"]'),
    ).toHaveCount(1)
    await page.click('#check-more-btn')
    await expect(page.locator('#area-result')).toContainText('1 checks')
    expect(calls).toBe(4)
    await page.selectOption('#station-select', 'CC15')
    await expect(page.locator('#section-preview')).toBeHidden()
    await expect(page.locator('.stop-row-btn')).toHaveCount(0)
  })
})
