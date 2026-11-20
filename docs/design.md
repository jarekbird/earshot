# Design

## The idea

On glasses, most of what a user wants is "go there" or "do that". Earshot's opinion: say it. Hold the touchpad, speak,
release. The app declares what is possible right now as data, so one small, fast model can pick from it, and a stronger
agent can use the same list as its tools.

The centre is the action list, not the router. The menu, touch, voice and agents are four callers of the same actions.

## Layers

```
your app          screens, actions, its own agents, its transports
earshot           actions · router · renderer and touch · hold and the agent stack · navigator
Even Hub SDK      the bridge to the glasses
```

One package. The navigator's model (Jev) is built in and on by default, behind one interface (E4).

## Actions (slice 1, built)

`action({ id, say, risk?, blocked?, targets?, run })`.

- `say` is the label on the glasses and what the navigator reads.
- `blocked()` returns why the action does not apply now, or null. A menu stays fixed; the action answers when picked.
- `targets()` lists what the action could be aimed at: `{ id, say, value, private? }`.
- `risk: 'confirm'` asks before running. The default is `safe`.
- `run(targetId)` returns an outcome: `done`, or not done because `blocked` (with its words), `target` (one is needed),
  `gone` (the chosen target left, E5) or `unknown`.

## Router (slice 1, built)

A stack of screens over a home screen. `open`, `replace`, `back` (false at home), `goHome`, `close`.

- A screen is `{ id, actions?, enter? }`. `enter` receives a signal that aborts when the screen leaves the stack (E7).
  A screen covered by another keeps running.
- `router.actions()` is the current screen's actions, then the app's. A screen's action replaces the app's action of
  the same id.

## Renderer and touch (slice 2)

The only code that imports the SDK (E1). It owns the device limits as tested constants, redraws a page only when its
containers change, and maps the touchpad to actions: swipe moves, tap runs, double tap goes back.

## Hold and the agent stack (slice 3)

Hold always opens the mic. The app supplies `transcribe(audio)`. The words go down a stack of agents; each answers
with a verdict:

- **sure**: this action, this target. Safe actions run; `confirm` actions ask first.
- **unsure**: these few candidates. They are shown as a list to tap.
- **not mine**: the next agent in the stack gets the words.

The navigator is first in the stack. Apps add their own agents after it, for example one that sends the words as a
message. A stronger agent gets three tools: read the screen's text, list the actions, run one.

An offline navigator that matches words stands in for the model in tests and demos (E4).

## Jev navigator (slice 4)

Jev answers typed questions with a typed answer and a probability, in well under a second. The navigator asks "which
action, or none" over the current actions, then "which target" over the chosen action's targets. Navigation needs no
generated text, so Jev is enough.

- The thresholds that turn probabilities into verdicts live with the navigator.
- Private targets are left out of the request (E6) and are picked by touch.
- The app supplies the transport to Jev (E2): an app bundle is public and cannot hold the key.

## Open

- Who hosts the transport to Jev: each app's own back end, or a shared proxy.
- Whether a screen's text may be sent to the navigator, or only action and target names.
