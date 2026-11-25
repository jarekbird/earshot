import { fileURLToPath } from 'node:url'
import { configDefaults, defineConfig } from 'vitest/config'

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url))

export default defineConfig({
  resolve: {
    alias: [
      { find: /^earshot\/relay$/, replacement: source('./relay/relay.ts') },
      { find: /^earshot$/, replacement: source('./src/index.ts') },
    ],
  },
  test: { exclude: [...configDefaults.exclude, '**/*.sim.test.ts'], setupFiles: ['./vitest.setup.ts'] },
})
