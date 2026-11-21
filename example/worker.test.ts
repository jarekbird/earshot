import { expect, it } from 'vitest'
import worker from './worker.js'

const env = { OPENROUTER_KEY: 'sk-developer', UPSTREAM: 'https://upstream.example' }

it("is the relay: it answers a browser's first check and refuses a call it does not forward", async () => {
  const check = await worker.fetch(new Request('https://relay.example/api/alpha/decisions', { method: 'OPTIONS' }), env)
  expect(check.status).toBe(204)
  expect(check.headers.get('access-control-allow-origin')).toBe('*')
  const other = await worker.fetch(new Request('https://relay.example/api/v1/keys', { method: 'POST', body: '{}' }), env)
  expect(other.status).toBe(404)
})
