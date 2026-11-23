import { CreateStartUpPageContainer, RebuildPageContainer, TextContainerProperty, TextContainerUpgrade } from '@evenrealities/even_hub_sdk'
import { describe, expect, it } from 'vitest'
import { fakeBridge } from './fake.js'

const text = (id: number, content = 'x', more: Partial<TextContainerProperty> = {}) =>
  new TextContainerProperty({ containerID: id, containerName: `box${id}`, content, isEventCapture: 0, zOrderIndex: id, ...more })
const page = (...boxes: TextContainerProperty[]) => ({ containerTotalNum: boxes.length, textObject: boxes })
const create = (fake: ReturnType<typeof fakeBridge>, ...boxes: TextContainerProperty[]) =>
  fake.bridge.createStartUpPageContainer(new CreateStartUpPageContainer(page(...boxes)))
const rebuild = (fake: ReturnType<typeof fakeBridge>, ...boxes: TextContainerProperty[]) =>
  fake.bridge.rebuildPageContainer(new RebuildPageContainer(page(...boxes)))

// Each refusal below is one the Even Hub simulator 0.9.5 makes.
describe('the stand-in bridge refuses what the simulator refuses', () => {
  it('answers true to an open of the microphone and false to a close, also the second time', async () => {
    const fake = fakeBridge()
    const answers = [true, true, false, false].map(on => fake.bridge.audioControl(on))
    expect(await Promise.all(answers)).toEqual([true, true, false, false])
    expect(fake.mic).toBeNull()
  })

  it('a second page', async () => {
    const fake = fakeBridge()
    expect(await create(fake, text(1))).toBe(0)
    expect(await create(fake, text(1))).toBe(1)
  })

  it('a rebuild before any page', async () => {
    expect(await rebuild(fakeBridge(), text(1))).toBe(false)
    expect(await rebuild(fakeBridge({ owned: true }), text(1))).toBe(true)
  })

  it('more than eight text boxes', async () => {
    const boxes = (count: number) => Array.from({ length: count }, (_, index) => text(index + 1))
    expect(await create(fakeBridge(), ...boxes(8))).toBe(0)
    expect(await create(fakeBridge(), ...boxes(9))).toBe(1)
  })

  it('text of a thousand bytes or more, on a page and on an update', async () => {
    const fake = fakeBridge()
    expect(await create(fake, text(1, 'a'.repeat(999)))).toBe(0)
    expect(await rebuild(fake, text(1, 'a'.repeat(1_000)))).toBe(false)
    expect(await rebuild(fake, text(1, '日'.repeat(333)))).toBe(true)
    expect(await rebuild(fake, text(1, '日'.repeat(334)))).toBe(false)
    const update = (content: string) =>
      fake.bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: 1, containerName: 'box1', content }))
    expect(await update('a'.repeat(999))).toBe(true)
    expect(await update('a'.repeat(1_000))).toBe(false)
  })

  it('two boxes that take the input, but not a page with none', async () => {
    expect(await create(fakeBridge(), text(1, 'x', { isEventCapture: 1 }), text(2, 'y', { isEventCapture: 1 }))).toBe(1)
    expect(await create(fakeBridge(), text(1), text(2))).toBe(0)
  })

  it('an update of a box that is not on the page', async () => {
    const fake = fakeBridge()
    await create(fake, text(1))
    expect(await fake.bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: 9, containerName: 'nope', content: 'x' }))).toBe(
      false,
    )
  })

  it('boxes whose front-to-back order is given for some and not all, or twice', async () => {
    expect(await create(fakeBridge(), text(1), text(2, 'y', { zOrderIndex: undefined }))).toBe(1)
    expect(await create(fakeBridge(), text(1), text(2, 'y', { zOrderIndex: 1 }))).toBe(1)
  })
})

describe('the stand-in bridge', () => {
  it('shows the boxes from back to front and the lines from the top', async () => {
    const fake = fakeBridge()
    await create(fake, text(1, 'low', { yPosition: 100, zOrderIndex: 2 }), text(2, 'high\n\nsecond', { yPosition: 0, zOrderIndex: 1 }))
    expect(fake.boxes().map(box => box.text)).toEqual(['high\n\nsecond', 'low'])
    expect(fake.lines()).toEqual(['high', 'second', 'low'])
  })

  it('refuses or throws on request, then works again', async () => {
    const fake = fakeBridge()
    fake.refuse('create', 1)
    expect(await create(fake, text(1))).toBe(1)
    fake.refuse('create', 1, true)
    await expect(create(fake, text(1))).rejects.toThrow()
    expect(await create(fake, text(1))).toBe(0)
  })
})
