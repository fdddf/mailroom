// The domain the dashboard is looking at: one domain's id, or null for all of
// them. Kept per browser, sent with every API request (X-Mailroom-Domain),
// and changing it refetches everything.
import { useSyncExternalStore } from 'react'

const STORAGE_KEY = 'mailroom_domain'

const read = (): number | null => {
  try {
    const id = Number(localStorage.getItem(STORAGE_KEY))
    return id > 0 ? id : null
  } catch {
    return null
  }
}

let current = read()
const listeners = new Set<() => void>()

export const domainHeaders = (): Record<string, string> => (current ? { 'X-Mailroom-Domain': String(current) } : {})

export const setDomain = (id: number | null) => {
  if (id === current) return
  current = id
  try {
    if (id) localStorage.setItem(STORAGE_KEY, String(id))
    else localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Private mode: the choice just does not survive a reload.
  }
  listeners.forEach((l) => l())
}

export const useDomainId = () =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => current,
  )
