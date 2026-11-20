import { describe, expect, it } from 'vitest'
import { manifestProblems, whitelistOf, type ProjectFacts } from './manifest.js'

const good = () => ({
  package_id: 'com.example.weather',
  edition: '202601',
  name: 'Weather',
  version: '1.2.3',
  min_sdk_version: '0.0.16',
  entrypoint: 'index.html',
  permissions: [
    {
      name: 'network',
      desc: 'Reads the forecast from the weather service.',
      whitelist: ['https://api.example.com', 'wss://*.example.net'],
    },
    { name: 'g2-microphone', desc: 'Hears what you say while you hold the touchpad.' },
  ],
})
const facts: ProjectFacts = { packageVersion: '1.2.3', sdkVersion: '0.0.16', hasFile: path => path === 'index.html' }
const problems = (change: object, withFacts = facts) => manifestProblems({ ...good(), ...change }, withFacts)

describe('a manifest the store accepts', () => {
  it('has no problems', () => {
    expect(manifestProblems(good(), facts)).toEqual([])
  })

  it('has no problems when the project facts are unknown', () => {
    expect(manifestProblems(good())).toEqual([])
  })

  it('gives its network whitelist', () => {
    expect(whitelistOf(good())).toEqual(['https://api.example.com', 'wss://*.example.net'])
    expect(whitelistOf({ ...good(), permissions: [] })).toEqual([])
    expect(whitelistOf('not a manifest')).toEqual([])
  })
})

describe('store rules', () => {
  it('wants an object', () => {
    expect(manifestProblems(null)).toEqual(['The manifest is not a JSON object.'])
  })

  it.each(['weather', 'com.my-app.weather', 'com.my_app.weather', 'Com.Example.Weather', 'com.9lives.app', 'com..weather'])(
    'rejects the package id %s',
    package_id => {
      expect(problems({ package_id })).toEqual([
        `package_id "${package_id}" must be reverse-domain: two or more parts, each lowercase letters and digits starting with a letter.`,
      ])
    },
  )

  it('rejects another edition', () => {
    expect(problems({ edition: '202501' })).toEqual(['edition "202501" must be "202601".'])
  })

  it('rejects a name over 20 characters', () => {
    expect(problems({ name: 'A weather app for G2!' })).toEqual(['name "A weather app for G2!" is 21 characters; the limit is 20.'])
  })

  it.each(['Even Weather', 'EvenWeather', 'Seven Days', 'uneven'])('rejects the name %s, which contains "Even"', name => {
    expect(problems({ name })).toEqual([`name "${name}" contains "Even", which the store rejects.`])
  })

  it.each(['1.2', 'v1.2.3', '1.2.3-beta', '1.2.3.4'])('rejects the version %s', version => {
    expect(problems({ version }, {})).toEqual([`version "${version}" must be three numbers, x.y.z.`])
  })

  it('rejects a version that differs from package.json', () => {
    expect(problems({ version: '1.2.4' })).toEqual(['version "1.2.4" differs from package.json, which says "1.2.3".'])
  })

  it('rejects a missing SDK floor, and one that differs from the installed SDK', () => {
    expect(problems({ min_sdk_version: undefined })).toEqual(['min_sdk_version is missing.'])
    expect(problems({ min_sdk_version: '0.0.14' })).toEqual(['min_sdk_version "0.0.14" differs from the installed SDK, "0.0.16".'])
  })

  it('rejects an entry point that is not in the build', () => {
    expect(problems({ entrypoint: 'main.html' })).toEqual(['entrypoint "main.html" is not a file in the build.'])
    expect(problems({ entrypoint: undefined })).toEqual(['entrypoint is missing.'])
  })
})

describe('permissions', () => {
  it('must be a list of objects, not a map', () => {
    expect(problems({ permissions: { network: 'yes' } })).toEqual(['permissions must be a list of { name, desc }.'])
  })

  it('each need a name and a description of 1 to 300 characters', () => {
    expect(problems({ permissions: [{ desc: 'Something.' }] })).toEqual(['A permission has no name.'])
    expect(problems({ permissions: [{ name: 'camera', desc: '' }] })).toEqual([
      'Permission "camera" needs a description of 1 to 300 characters; it has 0.',
    ])
    expect(problems({ permissions: [{ name: 'camera', desc: 'x'.repeat(301) }] })).toEqual([
      'Permission "camera" needs a description of 1 to 300 characters; it has 301.',
    ])
  })

  it('network needs a whitelist of origins', () => {
    const network = (whitelist: unknown) => ({ permissions: [{ name: 'network', desc: 'Talks to the service.', whitelist }] })
    expect(problems(network(undefined))).toEqual(['Permission "network" needs a whitelist with at least one origin.'])
    expect(problems(network([]))).toEqual(['Permission "network" needs a whitelist with at least one origin.'])
    expect(problems(network(['api.example.com', 'https://api.example.com/v1', 'https://api.example.com']))).toEqual([
      'Whitelist entry "api.example.com" must be an origin, such as "https://api.example.com" or "wss://*.example.com".',
      'Whitelist entry "https://api.example.com/v1" must be an origin, such as "https://api.example.com" or "wss://*.example.com".',
    ])
  })
})

it('reports every problem at once', () => {
  expect(problems({ name: 'Even', version: 'one', package_id: 'x' })).toHaveLength(3)
})
