import type { Env } from '../env'

// Push to the owner's phone via Bark (optional: BARK_SERVER_URL and
// BARK_DEVICE_KEY). Returns whether Bark accepted it. Never throws; the outcome
// goes to the Worker's logs, without the device key.
export const sendBark = async (
  env: Env,
  { title, body, url, group = 'Mail' }: { title: string; body: string; url?: string; group?: string },
) => {
  const key = env.BARK_DEVICE_KEY
  if (!env.BARK_SERVER_URL || !key) {
    console.warn('bark skipped: not set:', [!env.BARK_SERVER_URL && 'BARK_SERVER_URL', !key && 'BARK_DEVICE_KEY'].filter(Boolean).join(', '))
    return false
  }
  const clean = (text: string) => text.replaceAll(key, '<device key>').slice(0, 300)
  try {
    const res = await fetch(`${env.BARK_SERVER_URL.replace(/\/$/, '')}/${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, body, url, group, isArchive: 1 }),
    })
    if (res.ok) console.log('bark accepted', res.status)
    else console.error('bark refused', res.status, clean(await res.text().catch(() => '')))
    return res.ok
  } catch (err) {
    console.error('bark failed', clean(String(err)))
    return false
  }
}
