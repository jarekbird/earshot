# Earshot

A voice-first app framework for [Even Realities G2](https://www.evenrealities.com) glasses.

An Earshot app declares what it can do as **actions**. The menu, the touchpad and your voice all run those same actions. Hold the touchpad, say what you want, and a navigator picks the action and its target. Because the app's abilities are data, an agent can pilot it.

**Status: early.** Only the first slice exists. The API will change until two apps run on it.

| Slice | What                                                                   | State   |
| ----- | ---------------------------------------------------------------------- | ------- |
| 1     | Actions, the screen router, lifetimes, text and the store check        | here    |
| 2     | Glasses renderer and touch input                                       | planned |
| 3     | Hold to talk, and the agent stack with an offline navigator            | planned |
| 4     | Navigation by [Jev](https://typesafe.ai), TypeSafe AI's decision model | planned |

The design is in [`docs/design.md`](docs/design.md).

## Install

Not on npm yet. Pin a tag from GitHub:

```sh
npm install github:jarekbird/earshot#v0.0.5
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

const router = new Router({
  home: listScreen,
  actions: () => [pages, refresh],
  onChange: screen => draw(screen),
})

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

## Develop

```sh
npm install
npm run check
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
