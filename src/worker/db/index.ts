import type { D1Database } from '@cloudflare/workers-types'
import { sql, type SQLWrapper } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from './schema'

export const getDb = (d1: D1Database) => drizzle(d1, { schema })
export type Db = ReturnType<typeof getDb>

// Current time in the format the schema's defaults use.
export const nowIso = () => new Date().toISOString()

// Whether a value contains some text, ignoring ASCII case like LIKE does.
// Not LIKE '%…%': D1 rejects a LIKE pattern over 50 bytes ("LIKE or GLOB
// pattern too complex"), which a long address or search easily is.
export const contains = (value: SQLWrapper, needle: string) => sql`instr(lower(${value}), ${needle.toLowerCase()}) > 0`
