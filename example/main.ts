import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk'
import {
  action,
  boxes,
  createStore,
  evenPlace,
  Glasses,
  Lifetime,
  LINE_HEIGHT,
  list,
  openRouter,
  Rolling,
  Router,
  SCREEN_WIDTH,
  Shell,
  text,
  webPlace,
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
const bridge = await waitForEvenAppBridge()
const glasses = new Glasses(life, bridge, { trace: flags.has('trace') })
const service = openRouter({ host: 'https://openrouter.ai', store: createStore([evenPlace(bridge), webPlace()]) })

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

const rolling = new Rolling(life, { compact: service.compact })
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
  voice: {
    ...(scripted ? { transcribe: async () => scripted.shift() ?? '' } : { transcribe: service.transcribe, model: service.model }),
    agents: [takeNote],
    otherwise: 'Something to remember as a new note',
    rolling,
  },
})

const part = (id: string) => document.getElementById(id) as HTMLInputElement
const showAccount = async () => {
  const signedIn = await service.signedIn()
  part('status').textContent = signedIn ? 'Voice is set up. Hold the touchpad and speak.' : 'Voice needs an OpenRouter account.'
  part('signout').hidden = !signedIn
}
if (new URLSearchParams(location.search).has('code')) {
  await service.finishSignIn(location.href)
  history.replaceState(null, '', location.pathname + location.hash)
}
part('signin').onclick = async () => {
  const back = location.protocol === 'https:' ? { callbackUrl: location.origin + location.pathname } : {}
  location.assign(await service.signInUrl({ label: 'Earshot example', ...back }))
}
part('use').onclick = async () => {
  part('status').textContent = (await service.finishSignIn(part('code').value)) ? 'Signed in.' : 'That code did not work.'
  await showAccount()
}
part('signout').onclick = async () => {
  await service.signOut()
  await showAccount()
}
await showAccount()
