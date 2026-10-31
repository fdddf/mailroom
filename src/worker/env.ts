import type { D1Database, R2Bucket, SendEmail } from '@cloudflare/workers-types'
import type { Db } from './db'
import type { ApiKey, Domain } from './db/schema'

// Bindings and variables (wrangler.jsonc says what each does).
export type Env = {
  DB: D1Database
  // Sends from any address on a domain onboarded to Email Sending.
  EMAIL?: SendEmail
  // Attachments of received mail (mail/…) and images for HTML email (media/…).
  BUCKET?: R2Bucket
  // Where this Worker is reachable: unsubscribe links and images point here.
  PUBLIC_URL?: string
  ADMIN_PASSWORD?: string
  BARK_SERVER_URL?: string
  BARK_DEVICE_KEY?: string
}

export type AppEnv = {
  Bindings: Env
  Variables: {
    db: Db
    // Admin API: the domain picked in the dashboard (X-Mailroom-Domain), or
    // null for all of them. /v1: the API key's domain.
    domain: Domain | null
    // /v1 only.
    apiKey: ApiKey
  }
}
