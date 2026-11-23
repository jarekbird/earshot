import type { AddressInfo } from 'node:net'
import { describe, expect, it, onTestFinished } from 'vitest'
import { serve, settings } from './node.js'

async function running(maxBytes?: number) {
  const sent: string[] = []
  const server = await serve({
    key: 'sk-developer',
    upstream: 'https://upstream.example',
    maxBytes,
    port: 0,
    hostname: '127.0.0.1',
    fetch: async (url, init) => {
      sent.push(`${String(url)} ${new Headers(init?.headers).get('authorization')}`)
      return new Response('{"text":"open voice"}', { status: 200 })
    },
  })
  onTestFinished(() => void server.close())
  return { sent, at: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
}

const call = (at: string, body: unknown) =>
  fetch(`${at}/api/v1/audio/transcriptions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

describe('the Node server', () => {
  it('answers a call over HTTP through the relay', async () => {
    const { sent, at } = await running()
    const answer = await call(at, { model: 'openai/whisper-large-v3-turbo', input_audio: { data: 'UklGRg==', format: 'wav' } })
    expect(answer.status).toBe(200)
    expect(answer.headers.get('access-control-allow-origin')).toBe('*')
    expect(await answer.json()).toEqual({ text: 'open voice' })
    expect(sent).toEqual(['https://upstream.example/api/v1/audio/transcriptions Bearer sk-developer'])
  })

  it('answers the check a browser makes first', async () => {
    const { at } = await running()
    const answer = await fetch(`${at}/api/alpha/decisions`, { method: 'OPTIONS' })
    expect(answer.status).toBe(204)
    expect(answer.headers.get('access-control-allow-headers')).toBe('content-type')
  })

  it('refuses a body over the limit', async () => {
    const { sent, at } = await running(500)
    const answer = await call(at, { model: 'openai/whisper-large-v3-turbo', input_audio: { data: 'x'.repeat(2_000), format: 'wav' } })
    expect(answer.status).toBe(413)
    expect(sent).toEqual([])
  })
})

describe('its settings', () => {
  it('come from the environment', () => {
    expect(
      settings({
        EARSHOT_RELAY_KEY: 'sk-developer',
        EARSHOT_RELAY_UPSTREAM: 'https://upstream.example',
        EARSHOT_RELAY_MODELS: 'a/one, b/two',
        PORT: '8123',
        HOST: '127.0.0.1',
      }),
    ).toEqual({ key: 'sk-developer', upstream: 'https://upstream.example', models: ['a/one', 'b/two'], port: 8123, hostname: '127.0.0.1' })
    expect(settings({ EARSHOT_RELAY_KEY: 'k', EARSHOT_RELAY_UPSTREAM: 'https://upstream.example' })).toEqual({
      key: 'k',
      upstream: 'https://upstream.example',
      port: 8787,
    })
  })

  it('are refused by the server when the upstream of its calls or the key is missing', () => {
    expect(() => serve(settings({ EARSHOT_RELAY_UPSTREAM: 'https://upstream.example' }))).toThrow('need the key')
    expect(() => serve(settings({ EARSHOT_RELAY_KEY: 'k' }))).toThrow('needs the address')
    expect(() => serve(settings({}))).toThrow('needs an upstream')
  })
})
