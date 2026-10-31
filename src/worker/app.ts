// The Hono app behind every request the Worker answers itself; the
// dashboard's files are served as static assets (wrangler.jsonc).

import { Hono } from 'hono'
import type { AppEnv } from './env'
import { adminRoutes } from './routes/admin'
import { publicRoutes } from './routes/public'
import { v1Routes } from './routes/v1'

const app = new Hono<AppEnv>().route('/', publicRoutes).route('/api/admin', adminRoutes).route('/v1', v1Routes)

app.notFound((c) => c.json({ error: 'not_found' }, 404))
app.onError((err, c) => {
  console.error(err)
  return c.json({ error: 'internal_error' }, 500)
})

export default app

// For the dashboard's typed client: hc<AdminApi>('/api/admin').
export type AdminApi = typeof adminRoutes
