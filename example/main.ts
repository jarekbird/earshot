import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk'
import {
  action,
  boxes,
  Glasses,
  Lifetime,
  LINE_HEIGHT,
  list,
  Rolling,
  Router,
  SCREEN_WIDTH,
  Shell,
  text,
  type Agent,
} from '../src/index.js'

interface Note {
  id: string
  title: string
  body: string
}

const notes: Note[] = [
  {
    id: 'welcome',
    title: 'Welcome',
    body: 'Earshot draws this list from one action and its targets. Swipe to move, tap to open, double tap to go back.',
  },
  { id: 'voice', title: 'Voice', body: 'Hold to talk comes in the next slice. Everything you will be able to say is already in the menu.' },
  { id: 'long', title: 'A long note', body: Array.from({ length: 40 }, (_, n) => `Line ${n + 1} of a long note.`).join('\n') },
]
const targets = () => notes.map(note => ({ id: note.id, say: note.title, value: note }))
let taps = 0

const flags = new URLSearchParams(location.hash.slice(1))
const scripted = flags.get('say')?.split('|')

const life = new Lifetime()
const glasses = new Glasses(life, await waitForEvenAppBridge(), { trace: flags.has('trace') })

const open = action({
  id: 'open',
  say: 'Open note',
  hint: 'Shows one note to read',
  targets,
  run: note => router.open({ id: 'note', view: () => text({ title: note.title, body: note.body }) }),
})

const remove = action({
  id: 'delete',
  say: 'Delete note',
  risk: 'confirm',
  targets,
  run: note => void notes.splice(notes.indexOf(note), 1),
})

const send = action({ id: 'send', say: 'Send', blocked: () => 'Nothing to send', run: () => {} })

const counter = action({
  id: 'counter',
  say: 'Tap counter',
  run: () =>
    router.open({
      id: 'counter',
      view: () =>
        boxes(
          [
            { id: 'title', x: 0, y: 0, w: SCREEN_WIDTH, h: LINE_HEIGHT, text: 'Tap counter', brightness: 2 },
            { id: 'count', x: 0, y: 2 * LINE_HEIGHT, w: SCREEN_WIDTH, h: LINE_HEIGHT, text: `Taps: ${taps}` },
          ],
          input => {
            if (input.kind !== 'tap') return
            taps++
            shell.redraw()
          },
        ),
    }),
})

const router: Router = new Router({
  home: {
    id: 'notes',
    actions: () => [open, remove, counter, send],
    context: () => `A list of ${notes.length} notes`,
    view: () => list({ title: 'Earshot example', action: open, empty: 'No notes' }),
  },
})

const rolling = new Rolling(life)
for (const note of notes) rolling.add(open, note.id, note.body)
const takeNote: Agent = heard => {
  const [, body] = /^remember (.+)/i.exec(heard.words) ?? []
  if (!body) return { kind: 'notMine' }
  const note = { id: `said${notes.length}`, title: body, body }
  notes.push(note)
  rolling.add(open, note.id, note.body)
  return { kind: 'handled', say: 'Saved' }
}

const shell: Shell = new Shell(life, glasses, router, {
  voice: scripted && {
    transcribe: async () => scripted.shift() ?? '',
    agents: [takeNote],
    otherwise: 'Something to remember as a new note',
    rolling,
  },
})
