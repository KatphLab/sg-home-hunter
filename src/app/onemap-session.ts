import type { OneMapAccount } from '@lib/commute-types.js'
import { isNonEmptyString, isRecord, parseJsonUnknown } from '@utils/guards.js'

const STORAGE_KEY = 'house-hunter:onemap-session'

export const loadOneMapAccount = (): OneMapAccount | null => {
  try {
    const saved = window.sessionStorage.getItem(STORAGE_KEY)
    if (saved === null) return null
    const account = parseJsonUnknown(saved)
    if (
      isRecord(account) &&
      isNonEmptyString(account['accessToken']) &&
      typeof account['expiryTimestamp'] === 'number' &&
      account['expiryTimestamp'] > Date.now() / 1000
    ) {
      return {
        accessToken: account['accessToken'],
        expiryTimestamp: account['expiryTimestamp'],
      }
    }
    window.sessionStorage.removeItem(STORAGE_KEY)
  } catch {
    // Sign-in remains available if browser storage is blocked.
  }
  return null
}

export const saveOneMapAccount = (account: OneMapAccount | null): void => {
  try {
    if (account) {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(account))
    } else {
      window.sessionStorage.removeItem(STORAGE_KEY)
    }
  } catch {
    // The current page can still use an in-memory account.
  }
}
