import { describe, expect, it } from 'vitest'
import { relayAddress } from './address.mjs'

describe("the relay's address, as the example's build takes it", () => {
  it.each([
    ['https://relay.example', 'https://relay.example'],
    ['https://relay.example/base/', 'https://relay.example/base'],
    ['http://localhost:8787/', 'http://localhost:8787'],
    ['', ''],
    [undefined, ''],
  ])('takes %j as %j', (given, taken) => {
    expect(relayAddress(given)).toBe(taken)
  })

  it.each([
    'https://relay.example/?token=build-marker',
    'https://relay.example/#build-marker',
    'https://build-marker@relay.example',
    'https://relay.example/?',
    'http://relay.example',
    'build-marker',
  ])('refuses %s before anything is written, and does not say it back', given => {
    expect(() => relayAddress(given)).toThrow('EARSHOT_RELAY is the address of your relay alone')
    expect(() => relayAddress(given)).not.toThrow(/build-marker/)
  })
})
