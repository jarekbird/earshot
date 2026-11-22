import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { include: ['sim/**/*.sim.test.ts'], testTimeout: 180_000, hookTimeout: 60_000, setupFiles: ['./vitest.sim.setup.ts'] },
})
