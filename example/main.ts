import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk'
import { Glasses, Lifetime, LINE_HEIGHT, SCREEN_WIDTH } from '../src/index.js'

const life = new Lifetime()
const glasses = new Glasses(life, await waitForEvenAppBridge(), { trace: location.hash === '#trace' })
let taps = 0
let low = false

const draw = () =>
  glasses.draw({
    boxes: [
      { id: 'title', x: 0, y: 0, w: SCREEN_WIDTH, h: LINE_HEIGHT, text: 'Earshot example' },
      { id: 'count', x: 0, y: (low ? 4 : 2) * LINE_HEIGHT, w: SCREEN_WIDTH, h: LINE_HEIGHT, text: `Taps: ${taps}`, brightness: 2 },
    ],
  })

glasses.onInput(input => {
  if (input.kind === 'double') return void glasses.leave()
  if (input.kind === 'tap') taps++
  else if (input.kind === 'down') low = true
  else if (input.kind === 'up') low = false
  else return
  draw()
})
draw()
