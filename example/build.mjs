import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { build } from 'esbuild'
import { relayAddress } from './address.mjs'

const relay = relayAddress(process.env.EARSHOT_RELAY)
rmSync('example/dist', { recursive: true, force: true })
mkdirSync('example/dist', { recursive: true })
mkdirSync('example/build', { recursive: true })
await build({
  entryPoints: ['example/main.ts'],
  bundle: true,
  format: 'esm',
  minify: true,
  define: { EARSHOT_RELAY: JSON.stringify(relay), EARSHOT_TRACE: 'false' },
  outfile: 'example/dist/main.js',
  logLevel: 'error',
})
cpSync('example/index.html', 'example/dist/index.html')
const manifest = JSON.parse(readFileSync('example/app.json', 'utf8'))
manifest.version = JSON.parse(readFileSync('package.json', 'utf8')).version
if (relay) {
  manifest.permissions.unshift({
    name: 'network',
    desc: "Sends your voice commands, and what the Listen screen hears, to this app's server, which turns them into words and actions.",
    whitelist: [new URL(relay).origin, new URL(relay).origin.replace(/^http/, 'ws')],
  })
}
writeFileSync('example/build/app.json', `${JSON.stringify(manifest, null, 2)}\n`)
