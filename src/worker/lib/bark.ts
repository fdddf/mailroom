import type { Env } from '../env'

// Push to the owner's phone via Bark (optional: BARK_SERVER_URL and
// BARK_DEVICE_KEY). Returns whether Bark accepted it.
export const sendBark = async (
  env: Env,
  { title, body, url, group = 'Mail' }: { title: string; body: string; url?: string; group?: string },
) => {
  if (!env.BARK_SERVER_URL || !env.BARK_DEVICE_KEY) return false
  try {
    const res = await fetch(`${env.BARK_SERVER_URL.replace(/\/$/, '')}/${env.BARK_DEVICE_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, body, url, group, isArchive: 1 }),
    })
    return res.ok
  } catch {
    return false
  }
}
