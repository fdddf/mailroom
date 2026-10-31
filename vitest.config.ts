import { defineConfig } from 'vitest/config'

// Unit tests of the plain helpers run in Node, without the Workers runtime
// that vite.config.ts brings in.
export default defineConfig({
  test: { include: ['test/**/*.test.ts'], environment: 'node' },
})
