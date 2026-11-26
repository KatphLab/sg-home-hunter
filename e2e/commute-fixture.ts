import {
  type BrowserContext,
  expect,
  type Page,
  type Route,
} from '@playwright/test'

export const INVENTORY_DATE = '2026-11-20'

const TEST_INVENTORY_TSV = [
  `inventoryDate\t${INVENTORY_DATE}`,
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
  `networkDate\t${INVENTORY_DATE}`,
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

export const fulfillJson = (route: Route, status: number, json: unknown) =>
  route.fulfill({ status, json })

// Service Worker requests must be intercepted on the context, not the page.
export const stubCommute = async (context: BrowserContext): Promise<void> => {
  await context.route('**/maps/tiles/**', (route) =>
    route.fulfill({ contentType: 'image/png', body: EMPTY_PNG }),
  )
  for (const [name, body] of [
    ['stops', TEST_INVENTORY_TSV],
    ['bus-network', TEST_NETWORK_TSV],
  ] as const) {
    await context.route(`**/data/${name}.tsv`, (route) =>
      route.fulfill({
        contentType: 'text/tab-separated-values; charset=utf-8',
        body,
      }),
    )
  }
  await context.route('**/api/auth/post/getToken', (route) =>
    fulfillJson(route, 200, {
      access_token: 'mock-jwt',
      expiry_timestamp: 1_900_000_000,
    }),
  )
  await context.route('**/api/common/elastic/search*', (route) => {
    const postal = new URL(route.request().url()).searchParams.get('searchVal')
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
}

export const submitOneMapCredentials = async (page: Page): Promise<void> => {
  await page.fill('#onemap-email', 'commuter@example.com')
  await page.fill('#onemap-password', 'test-pass')
  await page.click('#signin-btn')
}

export const signInViaUi = async (page: Page): Promise<void> => {
  await page.click('#start-search-btn')
  await submitOneMapCredentials(page)
  await expect(page.locator('#signed-in-email')).toHaveText(
    'commuter@example.com',
  )
}

export const selectArea = async (page: Page, stopId: string): Promise<void> => {
  const filter = page.locator('#area-stop-filter')
  if (!(await filter.isVisible()))
    await page.locator('#area-picker summary').click()
  await filter.fill(stopId)
  await page.selectOption('#area-stop-select', stopId)
}

export const preview = async (page: Page): Promise<void> => {
  await page.click('#start-search-btn')
  await expect(page.locator('#result-status-tag')).toHaveText(
    'Estimated preview',
  )
}
