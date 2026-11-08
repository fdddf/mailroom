// Block rules (the block_rule table) against one received email.

import type { BlockKind } from '../db/schema'
import { bareAddress, domainOf } from './text'

export type Rule = { id: number; kind: BlockKind; value: string }

// The first rule that catches the email, or null.
//   address   the sender's address, exactly
//   domain    the sender's domain, or any subdomain of it
//   keyword   a word or phrase anywhere in the subject or text, any case
export const findBlockRule = <R extends Rule>(rules: R[], mail: { from: string; subject: string; text: string }): R | null => {
  const address = bareAddress(mail.from)
  const host = domainOf(mail.from)
  const haystack = `${mail.subject}\n${mail.text}`.toLowerCase()
  return (
    rules.find((r) => {
      if (r.kind === 'address') return address === r.value
      if (r.kind === 'domain') return host === r.value || host.endsWith(`.${r.value}`)
      return haystack.includes(r.value)
    }) ?? null
  )
}
