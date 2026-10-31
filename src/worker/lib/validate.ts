import { zValidator } from '@hono/zod-validator'
import type { ValidationTargets } from 'hono'
import { z } from 'zod'

// zValidator that answers with { error: <code> }, where the code is the
// failing rule's message. Schemas use error codes as messages
// (e.g. `.min(1, 'invalid_subject')`), which the dashboard maps to text.
export const validate = <T extends z.ZodType, Target extends keyof ValidationTargets>(target: Target, schema: T) =>
  zValidator(target, schema, (result, c) => {
    if (!result.success) return c.json({ error: result.error.issues[0]?.message ?? 'invalid_request' }, 400)
  })


// POST routes without a body still take `{}`: the admin guard only accepts
// JSON writes, and this lets the typed client send it.
export const emptyBody = () => validate('json', z.object({}))
