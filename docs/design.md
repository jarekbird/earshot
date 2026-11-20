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

Hold always opens the mic. Earshot owns the hold, the recording and the checks for a recording that is too short or
silent. Release sends the audio to a transcriber, `(audio) => text`, and the words show briefly as heard. The Even
SDK gives an app the raw microphone only: the "Hey Even" wake word and Even's assistant screen are closed to apps, so
Earshot draws its own listening and heard lines.

The words go down a stack of agents; each answers with a verdict:

- **sure**: this action, this target. Safe actions run; `confirm` actions ask first.
- **unsure**: these few candidates. They are shown as a list to tap.
- **not mine**: the next agent in the stack gets the words.

The navigator is first in the stack. Apps add their own agents after it, for example one that sends the words as a
message. A stronger agent gets three tools: read the screen's text, list the actions, run one.

An offline navigator that matches words stands in for the model in tests and demos only (E4). In an app nothing
matches words in front of the model.

## Jev navigator (slice 4)

Jev answers typed questions with a typed answer and a probability, in well under a second. Jev decides every hold. The
navigator asks "which action, or none" over the current actions, then "which target" over the chosen action's targets.
Navigation needs no generated text, so Jev is enough.

- The thresholds that turn probabilities into verdicts live with the navigator.
- Private targets are left out of the request (E6) and are picked by touch.

### Context

An app improves the navigator's picks with context, all optional and read only when a hold ends:

- a screen: what is on it now;
- an action: a hint of when to pick it;
- a target: `brief`, sent with its name, and `detail`, a function called only for a shortlist.

Rules for it:

- A private target sends neither name nor context (E6).
- Context is untrusted text. It can change which target is picked; it never skips a `confirm`.
- The navigator caps context per target and in total and trims from the end of the list, so list order is priority.
  The cap is about cost, speed and accuracy: the model's context is large.
- Later: drill-down. When a few targets are close, the navigator asks again with only their `detail`. Each step is
  one more typed question, so the model still writes no text.
- Compaction is too slow for a hold. An app that wants a summary as context makes it when its data changes and keeps
  it; a cheap text model on the same key costs about what Jev does.

### Transports and keys

Three transports, each one interface an app can replace: the transcriber, the navigator's model and, for apps that
use it, compaction. The built-in default for all three is OpenRouter with the user's own key: the user signs in with
OpenRouter on the phone page (OAuth PKCE), the key stays on the device, and the user pays their own use. No back end
is needed. An app with a back end plugs in its own transports, and then its audio and context go only there.

Building the default needs rule E2 reworded, from "opens no connection" to "connects only to hosts the app lists".

### When it goes wrong

One typed list of failures, each with default glasses text an app can override. Touch still reaches everything (E3).

| Situation                                      | User sees                    | Earshot does                             |
| ---------------------------------------------- | ---------------------------- | ---------------------------------------- |
| No key                                         | "Set up voice on your phone" | Calls nothing                            |
| Offline, or no answer in time                  | A short reason               | Drops the hold                           |
| Key refused, out of credit, rate limited, busy | A short reason, once         | Stops calling for a while; no retry loop |
| Nothing heard, or too short                    | "Didn't catch that"          | Sends nothing                            |
| Unsure                                         | The few candidates, to tap   |                                          |
| No match                                       | "No match"                   | Passes the words to the next agent       |
| The screen changed while deciding              | Nothing                      | Drops the verdict                        |
| The target left, or the action is blocked      | The reason                   | Reports it (E5)                          |
| Too many targets, or too much context          | Nothing                      | Trims to the cap                         |
| The model names an option that was not offered | "No match"                   | Treats it as unknown                     |

## Open

- Whether OpenRouter's sign-in redirect works inside the Even app's web view. To be tested before building on it.
- Whether screens get declared ids and parameters (`thread/:id`), so context and deep links attach to a route.
- Streaming speech-to-text, so words show while the user talks. It needs a second service and probably a back end.
