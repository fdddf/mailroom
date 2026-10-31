import { defineConfig } from 'drizzle-kit'

// `npm run db:generate` writes SQL migrations from the schema into
// migrations/, which `wrangler d1 migrations apply` runs in name order.
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/worker/db/schema.ts',
  out: './migrations',
  migrations: { prefix: 'timestamp' },
})
