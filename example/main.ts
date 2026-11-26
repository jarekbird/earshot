import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk'
import {
  action,
  boxes,
  fluxLive,
  Glasses,
  Lifetime,
  LINE_HEIGHT,
  list,
  LIST_ROW_WIDTH,
  oneLine,
  openRouter,
  Rolling,
  Router,
  SAMPLE_RATE,
  scriptedLive,
  scriptedSpeech,
  SCREEN_WIDTH,
  Shell,
  text,
  wrapText,
  type Agent,
  type Audio,
  type LiveState,
  type Question,
  type Speaker,
} from 'earshot'

declare const EARSHOT_RELAY: string
declare const EARSHOT_TRACE: boolean

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
  { id: 'voice', title: 'Voice', body: 'Hold the touchpad and say what you want. Everything you can say is in the menu too.' },
  { id: 'long', title: 'A long note', body: Array.from({ length: 40 }, (_, n) => `Line ${n + 1} of a long note.`).join('\n') },
]
const targets = () => notes.map(note => ({ id: note.id, say: note.title, value: note }))
let taps = 0

const flags = new URLSearchParams(location.hash.slice(1))
const scripted = flags.get('say')?.split('|')
const secret = document.getElementById('secret') as HTMLInputElement
const STALE_MS = 3_000
const speech = () => {
  if (flags.has('live')) return scriptedLive(flags.get('live')!.split('|'))
  return EARSHOT_RELAY && secret.value ? fluxLive({ host: EARSHOT_RELAY, secret: secret.value, staleMs: STALE_MS }) : undefined
}

const life = new Lifetime()
const bridge = await waitForEvenAppBridge()
const glasses = new Glasses(life, bridge, { trace: EARSHOT_TRACE })
const calls = (host: string, said: string) => ({ said, service: openRouter({ host, ...(said ? { secret: said } : {}) }) })
const relayed = EARSHOT_RELAY ? { host: EARSHOT_RELAY, made: calls(EARSHOT_RELAY, secret.value) } : undefined
const service = (from: NonNullable<typeof relayed>) => {
  if (from.made.said !== secret.value) from.made = calls(from.host, secret.value)
  return from.made.service
}

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

const count = action({
  id: 'count',
  say: 'Count a tap',
  run: () => {
    taps++
    shell.redraw()
  },
})

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
          { on: { tap: count } },
        ),
    }),
})

const heard: Record<Speaker, number> = { self: 0, other: 0, unknown: 0 }
const seconds = (bytes: number) => `${Math.floor(bytes / (SAMPLE_RATE * 2))} s`
let breaks = 0
const said = new Map<number, string>()
let words: LiveState = 'on'
const WHO: Record<Speaker, string> = { self: 'You', other: 'They', unknown: 'Someone' }
const WORDS: Record<LiveState, string> = { on: '', down: '\nNo words for now', refused: '\nWords are off' }
const listened = () =>
  `You: ${seconds(heard.self)}\nOthers: ${seconds(heard.other)}\nUnknown: ${seconds(heard.unknown)}\nBreaks: ${breaks}${[...said.values()].map(line => `\n${line}`).join('')}${glasses.micOpen ? WORDS[words] : '\nNot hearing'}`

const listen = action({
  id: 'listen',
  say: 'Listen',
  hint: 'Shows how long each speaker has been heard',
  run: () =>
    router.open({
      id: 'listen',
      view: () => text({ title: 'Listening', body: listened(), end: true }),
      enter: life => {
        heard.self = heard.other = heard.unknown = 0
        breaks = -1
        said.clear()
        words = 'on'
        let shown = listened()
        const say = speech()?.start(
          life,
          turn => {
            said.set(turn.id, `${WHO[turn.speaker]}: ${turn.words}${turn.final ? (turn.cut ? ' (cut)' : '') : ' ...'}`)
            show()
          },
          state => {
            words = state
            show()
          },
        )
        const show = () => {
          if (shown === listened()) return
          shown = listened()
          shell.redraw()
        }
        life.own(
          glasses.listen(sound => {
            heard[sound.speaker] += sound.pcm.length
            if (sound.gap) breaks++
            say?.(sound)
            show()
          }),
        )
        life.own(glasses.onMic(show))
        life.own(() => said.clear())
      },
    }),
})

const router: Router = new Router({
  home: {
    id: 'notes',
    actions: () => [open, remove, counter, listen, send],
    context: () => `A list of ${notes.length} notes`,
    view: () => list({ title: 'Earshot example', action: open, empty: 'No notes' }),
  },
})

life.own(
  glasses.onInput(input => {
    if (input.kind !== 'exit') return
    router.close()
    life.end()
  }),
)

const rolling = new Rolling(life, relayed ? { compact: (words, limit) => service(relayed).compact(words, limit) } : {})
for (const note of notes) rolling.add(open, note.id, note.body)
const takeNote: Agent = heard => {
  const [, body] = /^remember (.+)/i.exec(heard.words) ?? []
  if (!body) return { kind: 'notMine' }
  const note = { id: `said${notes.length}`, title: wrapText(oneLine(body), LIST_ROW_WIDTH)[0].trimEnd() || body, body }
  notes.push(note)
  rolling.add(open, note.id, note.body)
  return { kind: 'handled', say: 'Saved' }
}

const hears = scripted
  ? { transcribe: scriptedSpeech(scripted) }
  : relayed && {
      transcribe: (audio: Audio, turn?: Lifetime) => service(relayed).transcribe(audio, turn),
      model: { choose: (question: Question, turn?: Lifetime) => service(relayed).model.choose(question, turn) },
    }
const shell: Shell = new Shell(
  life,
  glasses,
  router,
  hears
    ? { voice: { ...hears, agents: [takeNote], otherwise: 'Something to remember as a new note', instead: 'Keep as a note', rolling } }
    : {},
)

document.getElementById('status')!.textContent = hears
  ? 'Hold the touchpad and say what you want.'
  : 'This build has no voice: it was packed without a relay.'
