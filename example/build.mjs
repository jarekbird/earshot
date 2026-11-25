import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { build, context } from 'esbuild'
import { relayAddress } from './address.mjs'

const here = (...path) => join(import.meta.dirname, ...path)
const relay = relayAddress(process.env.EARSHOT_RELAY)
const options = {
  entryPoints: [here('main.ts')],
  bundle: true,
  format: 'esm',
  minify: true,
  define: { EARSHOT_RELAY: JSON.stringify(relay), EARSHOT_TRACE: 'false' },
  outfile: here('dist/main.js'),
  logLevel: 'error',
}
rmSync(here('dist'), { recursive: true, force: true })
mkdirSync(here('dist'), { recursive: true })
mkdirSync(here('build'), { recursive: true })
cpSync(here('index.html'), here('dist/index.html'))
const manifest = JSON.parse(readFileSync(here('app.json'), 'utf8'))
manifest.version = JSON.parse(readFileSync(here('package.json'), 'utf8')).version
if (relay) {
  manifest.permissions.unshift({
    name: 'network',
    desc: "Sends your voice commands, and what the Listen screen hears, to this app's server, which turns them into words and actions.",
    whitelist: [new URL(relay).origin, new URL(relay).origin.replace(/^http/, 'ws')],
  })
}
writeFileSync(here('build/app.json'), `${JSON.stringify(manifest, null, 2)}\n`)
if (process.argv.includes('--serve')) {
  const rebuilt = await context(options)
  await rebuilt.watch()
  const { port } = await rebuilt.serve({ servedir: here('dist'), host: '127.0.0.1', port: 5173 })
  console.log(`http://127.0.0.1:${port} serves the app and rebuilds it when you save. Ctrl+C stops it.`)
} else await build(options)
