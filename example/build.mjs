import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { build } from 'esbuild'

rmSync('example/dist', { recursive: true, force: true })
mkdirSync('example/dist', { recursive: true })
mkdirSync('example/build', { recursive: true })
await build({
  entryPoints: ['example/main.ts'],
  bundle: true,
  format: 'esm',
  minify: true,
  outfile: 'example/dist/main.js',
  logLevel: 'error',
})
cpSync('example/index.html', 'example/dist/index.html')
const manifest = JSON.parse(readFileSync('example/app.json', 'utf8'))
manifest.version = JSON.parse(readFileSync('package.json', 'utf8')).version
writeFileSync('example/build/app.json', `${JSON.stringify(manifest, null, 2)}\n`)
