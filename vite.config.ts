import { cloudflare } from '@cloudflare/vite-plugin'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// `vite dev` runs the Worker (src/worker) and the dashboard (src/web)
// together; `vite build` writes both for `wrangler deploy`.
export default defineConfig({
  plugins: [react(), cloudflare()],
})
