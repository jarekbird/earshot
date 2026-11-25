import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest'
import { Simulator } from './simulator.js'

const SDK = join(dirname(createRequire(import.meta.url).resolve('@evenrealities/even_hub_sdk')), 'index.js')
const PAGE = `<!doctype html><meta charset="utf-8"><title>Earshot simulator test</title>
<script type="module">
import { waitForEvenAppBridge, CreateStartUpPageContainer, TextContainerProperty } from '/sdk.js'
const bridge = await waitForEvenAppBridge()
bridge.onEvenHubEvent(event => console.log('event ' + JSON.stringify(event)))
const text = new TextContainerProperty({ xPosition: 0, yPosition: 0, width: 576, height: 288, containerID: 1, containerName: 'main', isEventCapture: 1, content: 'Earshot' })
await bridge.createStartUpPageContainer(new CreateStartUpPageContainer({ containerTotalNum: 1, textObject: [text] }))
console.log('earshot page ready')
</script>`
const MIC_PAGE = PAGE.replace(
  "console.log('earshot page ready')",
  `const answer = async (on) => { try { return await (on ? bridge.audioControl(true, 'glasses') : bridge.audioControl(false)) } catch (error) { return 'threw ' + error } }
const answers = [await answer(true), await answer(true), await answer(false), await answer(false)]
console.log('mic answers ' + JSON.stringify(answers))
console.log('earshot page ready')`,
)
const PNG = [0x89, 0x50, 0x4e, 0x47]

describe('the driver on the real Even Hub simulator', () => {
  let server: Server
  let url: string
  beforeAll(async () => {
    server = createServer((request, response) => {
      const script = request.url === '/sdk.js'
      response.setHeader('content-type', script ? 'text/javascript' : 'text/html')
      response.end(script ? readFileSync(SDK) : request.url === '/mic' ? MIC_PAGE : PAGE)
    })
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
  })
  afterAll(() => void server.close())

  const start = async () => {
    const sim = await Simulator.start({ url, limitSeconds: 300 })
    onTestFinished(() => sim.stop())
    await sim.logged('earshot page ready', 60_000)
    return sim
  }

  it('runs a page, hears its console and takes pictures of the glasses and the phone', async () => {
    const sim = await start()
    const glasses = Buffer.from(await sim.screenshot('glasses'))
    expect([...glasses.subarray(0, 4)]).toEqual(PNG)
    expect([glasses.readUInt32BE(16), glasses.readUInt32BE(20)]).toEqual([576, 288])
    expect([...(await sim.screenshot('phone')).subarray(0, 4)]).toEqual(PNG)
  })

  it('sends touchpad input to the app', async () => {
    const sim = await start()
    await sim.input('tap')
    expect((await sim.logged(/^event /)).message).toContain('event {')
  })

  it.runIf(process.platform === 'linux')(
    'answers a first and a second open, and a first and a second close, of the microphone',
    async () => {
      const sim = await Simulator.start({ url: `${url}mic`, limitSeconds: 300, mic: true })
      onTestFinished(() => sim.stop())
      const said = await sim.logged(/^mic answers /, 60_000)
      expect(said.message).toBe('mic answers [true,true,false,false]')
    },
  )

  it('leaves no process behind', async () => {
    const sim = await start()
    const port = new URL(sim.api).port
    const found = () => {
      try {
        const listed = `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*automation-port ${port}*' } | ForEach-Object { $_.ProcessId }`
        return process.platform === 'win32'
          ? execFileSync('powershell', ['-NoProfile', '-Command', listed], { encoding: 'utf8' }).trim()
          : execFileSync('pgrep', ['-f', `automation-port ${port}`], { encoding: 'utf8' }).trim()
      } catch {
        return ''
      }
    }
    expect(found()).not.toBe('')
    await sim.stop()
    expect(found()).toBe('')
  })
})
