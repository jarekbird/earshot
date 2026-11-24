import { existsSync } from 'node:fs'
import { join } from 'node:path'

if (!existsSync(join(import.meta.dirname, 'node_modules', 'miniflare'))) {
  console.error(
    "The tests run the relay's Worker host in Cloudflare's runtime. It is installed apart from the rest, so that an app installing Earshot never needs it. Run: npm ci --prefix workerd",
  )
  process.exit(1)
}
