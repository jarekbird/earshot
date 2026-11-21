# Earshot

A voice-first app framework for [Even Realities G2](https://www.evenrealities.com) glasses.

An Earshot app declares what it can do as **actions**. The menu, the touchpad and your voice all run those same actions. Hold the touchpad, say what you want, and a navigator picks the action and its target. Because the app's abilities are data, an agent can pilot it.

**Status: early.** Only the first slice exists. The API will change until two apps run on it.

| Slice | What                                                                                                                                   | State |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| 1     | Actions, the router, lifetimes, text, storage, the store check and the simulator driver                                                | here  |
| 2     | Glasses renderer and touch input; the brightness of the voice overlay is still to be tried on real glasses                             | here  |
| 3     | Hold to talk, and the agent stack with an offline navigator                                                                            | here  |
| 4     | Navigation by [Jev](https://typesafe.ai), with speech-to-text and compaction through OpenRouter, paid by the developer through a relay | here  |

The design is in [`docs/design.md`](docs/design.md).

## Install

Not on npm yet. Pin a tag from GitHub:

```sh
npm install github:jarekbird/earshot#v0.0.12
```

## Actions

An action says what it does, when it does not apply, and what it could be aimed at.

```ts
import { action } from 'earshot'

const stop = action({
  id: 'stop',
  say: 'Stop',
  blocked: () => (thread.running ? null : 'Not running.'),
  run: () => thread.stop(),
})

const open = action({
  id: 'open',
  say: 'Open a thread',
  targets: () => threads.map(t => ({ id: t.id, say: t.title, value: t })),
  run: thread => show(thread),
})

await stop.run() // { done: false, why: 'blocked', say: 'Not running.' }
await open.run('t2') // { done: true }
```

A target is chosen by id and found again when the action runs. If it left in the meantime, the outcome is `{ done: false, why: 'gone' }` and nothing runs. Mark a target `private: true` to keep its name on the device once a model is choosing.

## Screens and the router

A screen has an id, its own actions, and a lifetime that ends what it started.

```ts
import { Router } from 'earshot'

const router = new Router({ home: listScreen, actions: () => [pages, refresh] })
router.onChange(screen => draw(screen))

router.open({
  id: 'thread',
  actions: () => [stop],
  enter: life => life.own(subscribe(thread)),
})

router.actions() // stop, pages, refresh: the screen's, then the app's
await router.run('stop')
router.back() // false at home: time to exit
```

## Lifetimes

A screen's lifetime ends when the screen leaves the stack, and takes with it everything started through it. A screen covered by another keeps running.

```ts
enter: life => {
  life.own(subscribe(thread)) // any cleanup function
  life.interval(refresh, 30_000) // also timeout; both return { cancel }
  life.listen(window, 'online', reconnect)
  void load(life)
}

async function load(life: Lifetime) {
  const response = await fetch(url, { signal: life.signal })
  const thread = await life.guard(response.json())
  show(thread)
}
```

- `life.signal` aborts when the lifetime ends, for `fetch` and anything else that takes a signal.
- `life.guard(work)` gives the result of `work`, or rejects with `LifetimeEnded` if the lifetime ends first. Code after it never runs for a screen that is gone.
- `life.child()` is a shorter lifetime inside this one, for one task.
- When it ends, every cleanup runs, newest first, even if one throws. The failures are then thrown together as an `AggregateError`.

## Screens on the glasses

A screen says what to show with `view`. The shell draws the current screen and runs your actions from the touchpad.

```ts
import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk'
import { action, Glasses, Lifetime, list, Router, Shell, text } from 'earshot'

const open = action({
  id: 'open',
  say: 'Open note',
  targets: () => notes.map(note => ({ id: note.id, say: note.title, value: note })),
  run: note => router.open({ id: 'note', view: () => text({ title: note.title, body: note.body }) }),
})

const router = new Router({
  home: { id: 'notes', actions: () => [open, refresh], view: () => list({ title: 'Notes', action: open }) },
})

const life = new Lifetime()
const glasses = new Glasses(life, await waitForEvenAppBridge())
const shell = new Shell(life, glasses, router)
```

- `list({ title, action, empty })` shows the targets of one action as lines of text. A swipe moves the cursor and a tap runs the action on that item.
- `text({ title, body })` shows text split into lines that fit. A swipe scrolls it two lines.
- `boxes(boxes, { on, pictures })` places each box yourself. `on` says which action a tap, a swipe up and a swipe down run: `{ tap: open, up: older, down: { action: open, target: 'next' } }`. A screen gets no raw touches, so whatever touch can do, voice can do too. A screen with no `view` lists its actions.
- By voice, a long text scrolls a screenful ("scroll down"), a list's cursor moves ("move down") and "choose this one" runs the row it is on. The model is told which row that is, unless the row is private.
- A double tap goes back. From the home screen it asks Even to close the app.
- Even's menu lists the screen's and the app's other actions. Over ten, the rest go behind "More…". An action with targets asks which one in a list.
- An action that is blocked says why over the page, which dims for a few seconds. An action with `risk: 'confirm'` asks first, and only a tap confirms.
- Call `shell.redraw()` when what a screen shows has changed. `shell.notice(text)` says something over the page.
- `new Shell(life, glasses, router, { words })` lets you change Earshot's own few words.

## Hold to talk

Give the shell a transcriber and a hold on the touchpad becomes a voice command.

```ts
import { SayError, Shell, toWav } from 'earshot'

new Shell(life, glasses, router, {
  voice: {
    transcribe: async audio => {
      const response = await fetch(myServer, { method: 'POST', body: toWav(audio.pcm) })
      if (response.status === 401) throw new SayError('Set up voice on your phone')
      return response.text()
    },
    agents: [takeNote],
  },
})
```

- A hold opens the glasses' microphone and shows "Listening" with eight bars that rise with the voice. The release closes it. A recording under half a second, or a silent one, is not sent anywhere.
- `transcribe` gets the sound as 16 kHz, 16-bit, one-channel PCM, and gives back the words. Earshot opens no connection itself; where the sound goes is yours to decide. A transcriber that cannot transcribe gives back `null`: no model is asked, and the agents get the recording with no words.
- The words show over the page, and the navigator picks from what the app can do now: go back, go home, each action, and the items of the rolling set.
- When it is sure, the action runs, and one marked `confirm` still asks first. When it is unsure, the few candidates are listed to tap. When nothing fits, it says "No match".
- `agents` get the words the navigator passes on, in order, with the recording (`audio`) and the turn's lifetime (`life`). An agent answers `{ kind: 'handled', say }`, `{ kind: 'notMine' }`, or with an action to run.
- An agent that waits before it acts waits through `life`. Any touch while a command is being decided calls it off and does nothing else; a hold calls it off and listens again. Both end `life`.
- `model` is what the navigator asks. It gets the question and gives each option a chance. Over 0.7 the navigator is sure; under that it lists the options over 0.15. The default matches the words against the labels and calls no service.
- A double tap calls a command off while it listens, and so does leaving the app. What was said is dropped when the screen changed while it listened or was decided.
- `onListen` is called when a hold starts to listen: bind there what the words are for. `shell.busy` is true from then until the command is done. A hold with no release ends after a minute (`maxHoldMs`). No answer in fifteen seconds is given up on (`timeoutMs`).
- Throw `SayError` from a transcriber to say what went wrong in your own words.

### What the navigator is offered

One question, with everything the user could mean:

```ts
import { action, Rolling } from 'earshot'

const open = action({ id: 'open', say: 'Open thread', hint: 'Shows one conversation', targets, run })

const rolling = new Rolling(life, { compact })
rolling.add(open, thread.id, thread.latestText)

new Shell(life, glasses, router, { voice: { transcribe, rolling, agents: [send], otherwise: 'A message to send' } })
```

- **Always:** going back, going home, "none of these", and every action of the screen and the app. Going back and going home are actions of the router, with the ids `back` and `home`. They are in Even's menu too, and an app replaces one by declaring an action with its id.
- **The rolling set:** items the app adds, each an action on one of its targets, newest first. Adding one again makes it the newest. It holds 255 less the options above, and the oldest leaves. It belongs to the app, so an item can be picked from any screen. A `private` target never enters it.
- **`otherwise`** names what your other agents take. The navigator offers it only when there is another agent, and picking it passes the words on.
- **Context,** all optional: a `hint` on an action, `context()` on a screen for what is on it now, and text with a rolling item that tells it from the others.
- Context can be any length. Over 1,200 characters an item, Earshot asks `compact(text, limit)` for a shorter one in the background and uses the last characters until it is back, or if it fails. Text that is still changing is compacted once it has been still for five seconds. Without `compact`, the last characters are used.
- A whole question carries at most 240,000 characters. Past that, the oldest rolling items send their name only.

### Jev, through OpenRouter

Earshot ships the three transports for [OpenRouter](https://openrouter.ai): speech-to-text, Jev as the navigator's model, and compaction. The developer pays for them, not the user: nobody signs in, and a user just holds and speaks.

```ts
import { openRouter, Rolling, Shell } from 'earshot'

const service = openRouter({ host: 'https://relay.example.com' })
const rolling = new Rolling(life, { compact: service.compact })
new Shell(life, glasses, router, { voice: { transcribe: service.transcribe, model: service.model, rolling } })
```

- `host` is your relay (below), not OpenRouter. List it in your `app.json` whitelist, with the `g2-microphone` permission. Earshot holds no address of its own.
- A lost connection, too many requests and a busy service each say so in a few words. When the relay is refused or out of credit the glasses say "Voice is off for now". After any but the first of those Earshot holds back for thirty seconds.
- `models: { speech, decide, compact }` and `language` change the defaults: `openai/whisper-large-v3-turbo`, `typesafe/jev-1.14` and `mistralai/mistral-nemo`.
- Tried live on 20 November 2026: Jev answered in about 0.2 seconds, picked the wanted option on 12 of 12 test phrases, and 24 questions cost $0.0006. Through the relay as a Cloudflare Worker, a question took about 0.35 seconds end to end, and eleven seconds of speech became the right words in 1.7 seconds.

### The relay

A glasses app is web files on the user's phone, and anyone can read a key out of them. So your OpenRouter key stays on a small server of yours, the relay, and the app calls that. Earshot ships it: one function with no dependencies that takes a request and gives a response.

On Node, on any host that keeps a process running:

```sh
EARSHOT_RELAY_KEY=sk-or-... EARSHOT_RELAY_UPSTREAM=https://openrouter.ai npx earshot-relay
```

It listens on `PORT` (8787 unless set) and on `HOST` when set. `EARSHOT_RELAY_MODELS` is a comma-separated list when your app uses other models than the defaults. Put it behind HTTPS: the Even app loads your page over HTTPS and will not call a plain HTTP address.

As a Cloudflare Worker, or on anything else that speaks web requests:

```ts
import { relay } from 'earshot/relay'

export default {
  fetch: (request: Request, env: { OPENROUTER_KEY: string; UPSTREAM: string }) =>
    relay({ key: env.OPENROUTER_KEY, upstream: env.UPSTREAM })(request),
}
```

`serve` from `earshot/relay/node` starts the same Node server from your own code.

What the relay does:

- It forwards only Earshot's three calls, only for the models you list, and only the fields Earshot sends. It is not a general key for anyone who finds its address.
- It refuses a request over four megabytes (`maxBytes`), and answers the cross-origin check a web view makes first.
- It adds your key on the way out and passes back only the answer.

What it does not do: tell one user from another. Anyone who finds the address can spend your credit on those three calls, so **set a spending limit on the key at OpenRouter**, for example a few dollars a month. That limit is the most a stranger can cost you; when it is reached, voice is off for everyone until it resets.

### Draw it yourself

Under the shell, `Glasses` draws frames of text boxes and tells you what the user did. It is the only part of Earshot that talks to Even's SDK, which your app installs.

```ts
glasses.draw({
  boxes: [
    { id: 'title', x: 0, y: 0, w: SCREEN_WIDTH, h: LINE_HEIGHT, text: 'Threads' },
    { id: 'body', x: 0, y: LINE_HEIGHT, w: SCREEN_WIDTH, h: 200, text: 'One\nTwo', brightness: 2 },
  ],
  menu: [{ id: 1, name: 'Refresh' }],
})
glasses.overlay('Listening') // dims the page and writes over it; null takes it away
glasses.onInput(input => {
  if (input.kind === 'double') void glasses.leave()
})
```

- Draw as often as you like. One draw is sent at a time, and only the newest frame waits.
- A change of text or brightness is updated in place, without a flicker. The page is rebuilt only when a box is added, removed, moved, resized or renamed, or the menu changes, and never more than about three times a second.
- A draw the glasses refuse is tried again, after half a second, then one, two and four.
- `input.kind` is `tap`, `double`, `up`, `down`, `hold`, `release`, `menu`, `foreground`, `background` or `exit`. A hold says where it was pressed: `right`, `left` or `ring`.
- An app gets seven text boxes. Earshot keeps one behind them for input, and writes its overlay there; a box of yours that sits under the overlay's lines is blank while it shows. Text over 999 bytes in a box is cut, with an ellipsis.
- A frame can carry up to four `pictures`, each `{ id, x, y, w, h, key, data }`, from 20 to 288 wide and 20 to 144 high. A picture is sent again only when its `key` changes.
- `draw` returns the frame's number, and `shown` is the number of the newest frame on the glasses. Pass `watch` in the options to be told of each frame when it is asked for, its begin and end, each call to the glasses with its answer and time, each retry, and each time a frame has to wait: for your own log.
- No rebuild starts while the microphone opens, because the Even app answers one call at a time. If your app opens the microphone itself, pass that promise to `holdRebuilds`.
- `brightness` runs from 0 to 4, and 4 is the default.
- Even reports `foreground` when its menu opens and `background` when it closes, so Earshot keeps drawing through both.

### Test without the glasses

```ts
import { fakeBridge } from 'earshot/testing'

const fake = fakeBridge()
const glasses = new Glasses(life, fake.bridge)
new Shell(life, glasses, router)
await vi.advanceTimersByTimeAsync(0)
expect(fake.lines()).toEqual(['Notes', '> First note', 'Second note'])
fake.down() // also tap, double, up, hold, release, foreground, background, exit
fake.pick('Refresh') // an item of Even's menu
fake.sound(pcm) // what the microphone hears, between a hold and a release
```

The stand-in refuses what Even's simulator refuses: a ninth text box, text of 1,000 bytes, a second page. `fake.refuse('rebuild', 2)` makes it refuse on request.

## Text for the glasses

The glasses have one font, with letters of different widths. These measure with Even's own numbers for it ([`@evenrealities/pretext`](https://www.npmjs.com/package/@evenrealities/pretext)), so text fits before it is drawn.

```ts
import { cleanText, fitText, oneLine, textWidth, wrapText } from 'earshot'

fitText(oneLine(thread.title), 400) // one line, cut to 400 pixels with an ellipsis
wrapText(cleanText(message.text), 560) // the lines, none wider than 560 pixels
textWidth('14:30') // pixels
```

- `cleanText` swaps a backtick and a tab for what the font can draw, makes line ends the same and removes characters that draw nothing. `oneLine` does that and puts the text on one line.
- `fitText` and `wrapText` measure and cut; they do not clean. Give `fitText` one line.
- `wrapText` breaks where the glasses break: after a space, a hyphen, or a Chinese, Japanese or Korean character, and inside a word only when the word is wider than the line. The glasses do not break its lines again. It keeps the spaces that start a paragraph.
- A character the font cannot draw leaves a 4 pixel gap on the glasses. `hasGlyph(char)` says whether the font draws it.
- Take the container's padding and border off the width first.

The numbers match the Even Hub simulator to the pixel. Check a tight layout on real glasses.

## Storage

What an app remembers between launches: a pairing, a token, a cache. Earshot saves each value in two places, the Even app's storage and the web view's, because either can lose its copy.

```ts
import { createStore, evenPlace, memoryPlace, webPlace } from 'earshot'

const store = createStore([evenPlace(bridge), webPlace()])

await store.set('pairing', JSON.stringify(pairing))
const text = await store.get('pairing') // null when nothing is saved
await store.remove('pairing')

const forTests = createStore([memoryPlace()])
```

- A read gives the newest copy and repairs a place that fell behind, so an old value never comes back after a save or a remove that reached only one place.
- `set` and `remove` reject with `StoreError` when no place stored the change. `get` rejects with it when no place could be read, which is not the same as nothing saved.
- Changes to one key land in the order they were made.
- Text an app saved under the same key before it used Earshot is read as it is.
- A place is `{ read, write }`, so an app can add its own.

## Develop

```sh
npm install
npm run check
npm run check:sim   # the simulator driver, against the real simulator
npm run example:pack   # build, check and pack the example app in example/
```

MIT licensed.

## Check before you submit

`earshot-check` reads your `app.json` and your build, and lists what Even Hub's review would turn down. Run it after every build.

```sh
npx earshot-check                                  # app.json and dist
npx earshot-check plugin/app.json plugin/dist      # other places
npx earshot-check --allow demo://local             # a URL that is the app's own and never leaves it
```

From [Even Hub's submission rules](https://hub.evenrealities.com/docs/ship/app-submission):

- `package_id` is reverse-domain, lowercase, with no hyphens or underscores.
- `edition` is the current one.
- `name` is at most 20 characters and does not contain "Even".
- `version` is `x.y.z`, and `min_sdk_version` and `entrypoint` are present; the entry point is a file in the build.
- Each permission has a name and a description of 1 to 300 characters, and `network` has a whitelist.

Earshot's own, stricter:

- `version` matches `package.json`, and `min_sdk_version` matches the installed SDK.
- Each whitelist entry is an origin, such as `https://api.example.com` or `wss://*.example.com`.
- No URL anywhere in the build is outside the whitelist. Scripts are read as JavaScript, so a URL joined from parts is found, and one whose host is only known at run time counts as outside. A script that cannot be read as JavaScript is reported.

The same checks are functions in `earshot/check`: `checkApp`, `manifestProblems`, `scan`.

## Run your app in the simulator

Even's simulator can be driven from a test or a script. `earshot/sim` starts it on your page, sends touchpad input, reads the page's console and takes pictures.

```ts
import { Simulator } from 'earshot/sim'

const sim = await Simulator.start({ url: 'http://127.0.0.1:5173/' })
await sim.logged('ready') // the next console entry that says so
await sim.input('tap') // tap, double, up, down, press, release, menu
const png = await sim.screenshot('glasses') // or 'phone'
await sim.stop()
```

- Install `@evenrealities/evenhub-simulator` in your project; the driver finds it there.
- `sim.until(what, check, ms)` waits for anything else, and says what the console and the simulator last said when time runs out. The simulator can only be asked, not listened to, so waiting asks it ten times a second.
- Each run has its own home folder, removed by `stop`. Every process it starts has a hard time limit, an hour unless you pass `limitSeconds`.
- On Linux without a display it starts a hidden one, which needs `Xvfb`. A bare CI machine also needs the simulator's libraries: on Ubuntu, `xvfb libwebkit2gtk-4.1-0 libasound2t64`.
- Input reaches the app only when its page has a container that captures events.
- `Simulator.start({ url, mic: true })` gives the simulator a microphone that hears a steady tone, on Linux, and `await sim.hold(1200)` holds the touchpad that long. With a scripted transcriber in your app, that tests a voice command end to end.
- `new Glasses(life, bridge, { trace: true })` writes what the glasses show to the console. Then `await sim.shows('Threads')` waits for it, `sim.shown()` gives the lines, `sim.menu()` the items of Even's menu, and `await sim.pick('Refresh')` picks one.
- The simulator is not the glasses: check fonts, scrolling and timing on the device.
