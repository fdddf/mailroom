// Contacts and segments of a domain, as the dashboard, the /v1 API and the
// MCP server change them.

import { and, eq, inArray, sql } from 'drizzle-orm'
import type { Db } from '../db'
import { contact, contactSegment, segment } from '../db/schema'
import { newToken } from './broadcast'

// D1 allows 100 bound parameters per statement; a contact row takes 5.
const INSERT_CHUNK = 18

export type NewContact = { email: string; firstName?: string; lastName?: string }

// Add (or find) a contact on a domain. Adding someone again only fills in
// their name; it never resubscribes them.
export const upsertContact = async (db: Db, domainId: number, b: NewContact) => {
  await db
    .insert(contact)
    .values({ domainId, email: b.email, firstName: b.firstName ?? '', lastName: b.lastName ?? '', token: newToken() })
    .onConflictDoUpdate({
      target: [contact.domainId, contact.email],
      set: { ...(b.firstName && { firstName: b.firstName }), ...(b.lastName && { lastName: b.lastName }), email: b.email },
    })
  return (await db.query.contact.findFirst({ where: and(eq(contact.domainId, domainId), eq(contact.email, b.email)) }))!
}

// The ids of the domain's segments by these names; missing ones are made.
export const ensureSegments = async (db: Db, domainId: number, names: string[]) => {
  const unique = [...new Set(names)]
  if (!unique.length) return []
  await db.insert(segment).values(unique.map((name) => ({ domainId, name }))).onConflictDoNothing()
  return (await db.select({ id: segment.id }).from(segment).where(and(eq(segment.domainId, domainId), inArray(segment.name, unique)))).map((s) => s.id)
}

export const addToSegments = async (db: Db, contactId: number, segmentIds: number[]) => {
  if (segmentIds.length) await db.insert(contactSegment).values(segmentIds.map((segmentId) => ({ contactId, segmentId }))).onConflictDoNothing()
}

export const segmentNamesOf = async (db: Db, contactId: number) =>
  (
    await db
      .select({ name: segment.name })
      .from(contactSegment)
      .innerJoin(segment, eq(segment.id, contactSegment.segmentId))
      .where(eq(contactSegment.contactId, contactId))
  ).map((s) => s.name)

// Many at once, deduplicated by address (names given twice: the later one), and all of them
// put in `segmentIds` (segments of the domain). Existing contacts stay
// subscribed or unsubscribed as they were; with `fillNames`, the names given
// replace theirs, else they are left as they are.
export const importContacts = async (db: Db, domainId: number, people: NewContact[], segmentIds: number[] = [], { fillNames = false } = {}) => {
  const rows = new Map<string, { domainId: number; email: string; firstName: string; lastName: string; token: string }>()
  for (const p of people) {
    const seen = rows.get(p.email)
    const firstName = (p.firstName || seen?.firstName || '').slice(0, 100)
    const lastName = (p.lastName || seen?.lastName || '').slice(0, 100)
    rows.set(p.email, { domainId, email: p.email, firstName, lastName, token: seen?.token ?? newToken() })
  }
  const list = [...rows.values()]
  const before = await db.$count(contact, eq(contact.domainId, domainId))
  for (let i = 0; i < list.length; i += INSERT_CHUNK) {
    const chunk = list.slice(i, i + INSERT_CHUNK)
    const insert = db.insert(contact).values(chunk)
    await (fillNames
      ? insert.onConflictDoUpdate({
          target: [contact.domainId, contact.email],
          set: {
            firstName: sql`CASE WHEN excluded.first_name <> '' THEN excluded.first_name ELSE ${contact.firstName} END`,
            lastName: sql`CASE WHEN excluded.last_name <> '' THEN excluded.last_name ELSE ${contact.lastName} END`,
          },
        })
      : insert.onConflictDoNothing({ target: [contact.domainId, contact.email] }))
    for (const segmentId of segmentIds) {
      await db.run(sql`
        INSERT OR IGNORE INTO contact_segment (contact_id, segment_id)
        SELECT id, ${segmentId} FROM contact WHERE domain_id = ${domainId} AND email IN (${sql.join(chunk.map((r) => sql`${r.email}`), sql`, `)})`)
    }
  }
  const added = (await db.$count(contact, eq(contact.domainId, domainId))) - before
  return { added, existing: list.length - added }
}

