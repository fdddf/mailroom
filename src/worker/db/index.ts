import type { D1Database } from '@cloudflare/workers-types'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from './schema'

export const getDb = (d1: D1Database) => drizzle(d1, { schema })
export type Db = ReturnType<typeof getDb>

// Current time in the format the schema's defaults use.
export const nowIso = () => new Date().toISOString()
