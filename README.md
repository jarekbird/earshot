# Earshot

A voice-first app framework for [Even Realities G2](https://www.evenrealities.com) glasses.

An Earshot app declares what it can do as **actions**. The menu, the touchpad and your voice all run those same actions. Hold the touchpad, say what you want, and a navigator picks the action and its target. Because the app's abilities are data, an agent can pilot it.

**Status: early.** Only the first slice exists. The API will change until two apps run on it.

| Slice | What                                                                   | State   |
| ----- | ---------------------------------------------------------------------- | ------- |
| 1     | Actions, the screen router and lifetimes                               | here    |
| 2     | Glasses renderer and touch input                                       | planned |
| 3     | Hold to talk, and the agent stack with an offline navigator            | planned |
| 4     | Navigation by [Jev](https://typesafe.ai), TypeSafe AI's decision model | planned |

The design is in [`docs/design.md`](docs/design.md).

## Install

Not on npm yet. Pin a tag from GitHub:

```sh
npm install github:jarekbird/earshot#v0.0.2
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

## Develop

```sh
npm install
npm run check
```

MIT licensed.
