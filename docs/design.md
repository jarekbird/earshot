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

- A screen is `{ id, actions?, enter? }`. `enter` receives a lifetime that ends when the screen leaves the stack
  (E7). A screen covered by another keeps running.
- A lifetime owns cleanups, timers and listeners, carries an abort signal, and guards an `await` so the code after
  it does not run for a screen that is gone. It has no sleep: a delay is a timer, and waiting for something is its
  event.
- `router.actions()` is the current screen's actions, then the app's. A screen's action replaces the app's action of
  the same id.

## Text for the glasses (slice 1, built)

`textWidth`, `fitText`, `wrapText`, `cleanText`, `oneLine`, `hasGlyph`, in `src/glasses/text.ts`. The widths are Even's
own, from `@evenrealities/pretext`, which is taken from the firmware's font; Earshot keeps no width table. `wrapText`
returns the lines, which Even's package does not, because the renderer draws lists and pages as lines of text. Its
lines are ones the glasses do not break again.

Scrolling, dates and the limits on a container's length are not here: one app scrolls, one formats dates, and the
limits belong to the renderer.

## Storage (slice 1, built)

`createStore(places)` gives `get`, `set` and `remove` by key, with text values. An app passes two places, the Even
app's storage and the web view's: each has lost data between launches. Every save is stamped, so a read takes the
newer copy and repairs the other, and a remove is a stamped save of nothing, because the SDK has no delete. A change
no place stored, and a read no place answered, are errors. Changes to one key run in order. `src/store.ts` names the
SDK's two storage calls by shape, so it does not import the SDK (E1).

## Simulator driver (slice 1, built)

`earshot/sim`, in `sim/`, outside `src` because it needs Node. It starts Even's simulator on a page, with its own home
folder, a hidden display on Linux and a hard time limit on every process, then sends touchpad input, reads the
console, takes pictures and waits for a condition. The simulator gives a picture and a console, not the text on the
glasses. Reading what the glasses show, and a stand-in bridge for tests without the simulator, come with the renderer
in slice 2, which decides what a drawn frame is.

## Store check (slice 1, built)

`earshot-check`, and `earshot/check` from code. It reads `app.json` and the build and lists what Even Hub's review
would turn down: the manifest rules, and any URL in the build outside the network whitelist. It lives in `check/`,
outside `src`, because it needs Node; nothing in `src` imports it. What belongs on an app's whitelist stays the app's
own test.

## Renderer and touch (slice 2, built)

The only code that imports the SDK (E1). It owns the device limits as tested constants, redraws a page only when its
containers change, and maps the touchpad to actions: swipe moves, tap runs, double tap goes back.

`Glasses` draws frames of boxes and reports input.

- One draw at a time, and only the newest frame waits. Text and brightness change in place; anything else about a box,
  or a change of menu, rebuilds the page, at most once in 300 ms. A refused draw is retried after 0.5, 1, 2 and then
  4 seconds.
- A full-screen empty box behind the others takes the input, because the firmware animates a bounce on the box that
  takes the swipes. One box in front of the others, three lines along the bottom, is the overlay's. That leaves an
  app six of the eight text boxes. It sets the front-to-back order of all of them.
- `overlay(text)` lowers the brightness of the page in place and writes the text, bright, in the front box.
- Input is one type: tap, double, up, down, hold, release, menu, foreground, background, exit.

`Shell` draws the router's current screen and runs actions from touch.

- A screen's `view` is a `list`, a `text` or its own `boxes`. A list shows the targets of one action. Lists are drawn
  as text, not as the SDK's list container: text can be dimmed in place, a list cannot. The row under the cursor is in
  a box of its own, so moving the cursor changes text and rebuilds nothing.
- Even's menu lists the other actions. Each action keeps one item number on every screen, so a pick that arrives from
  an old menu cannot run a different action. Over ten, the rest fold into a list.
- A blocked action says why in the overlay for three seconds. A `confirm` action asks there first, and only a tap
  confirms. An action that needs a target and has none opens a list of its targets.
- Holds are handed on untouched; slice 3 takes them.

`earshot/testing` is a stand-in bridge for tests, and a traced frame is what `earshot/sim` reads back as the glasses'
text and menu.

What the simulator showed, which the code follows where it differs from Even's pages:

- A text box takes 999 bytes, on a rebuild and on an update. Even's pages say 1,000 and 2,000 characters.
- It reports `foreground` when Even's menu opens and `background` when it closes, so Earshot keeps drawing through
  both and only reports them.
- A second create is refused, so a reloaded web view takes its old page over with a rebuild.
- Even's menu opens with its first item chosen and wraps at both ends. It ignores a press while it is closing, and
  taps do not reach the app until it has closed.

Not built: images, which no app on Earshot uses yet. Still to try on real glasses: how the dimmed page reads behind
the overlay, and which levels to use. It is 1 now.

## Hold and the agent stack (slice 3, built)

Built: the shell owns the hold. It opens the glasses' microphone, records until the release, drops a recording under
half a second or with no sound in it, and gives the rest to the app's transcriber. The words go to the navigator and
then to the app's agents. The navigator asks one question of a model behind one interface; the model built in is
`matchWords`, the offline stand-in (E4), which compares the words with the labels. A double tap calls a command off, a
hold without a release ends after a minute, and an answer that takes over fifteen seconds is given up on. A hold while
a question is up calls the question off.

Not built yet, and belonging to the next slice: Jev as the model, the rolling queue of items, context and its
compaction, and the default transports with the user's own key.

The design it follows:

Hold always opens the mic. Earshot owns the hold, the recording and the checks for a recording that is too short or
silent. The hold is one trigger of this path; a wake word can be a second (below). Release sends the audio to a
transcriber, `(audio) => text`, and the words show briefly as heard. The Even SDK gives an app the raw microphone
only: the "Hey Even" wake word and Even's assistant screen are closed to apps, so Earshot draws its own listening and
heard lines.

### The voice overlay

The same in every app, so a user learns it once. During a hold, and while the words are shown and decided on, Earshot
lowers the brightness of the page's text in place and writes its own lines, bright, in the front box: listening, the
words heard, and what went wrong. When it is done the page's brightness returns. Nothing is rebuilt, so nothing
flickers.

- The display has no fill: black is see-through. A box in front cannot hide what is behind it, so dimming is what
  keeps the overlay readable.
- The overlay and its words are Earshot's. Everything else on the page is the app's.

The words go down a stack of agents; each answers with a verdict:

- **sure**: this action, this target. Safe actions run; `confirm` actions ask first.
- **unsure**: these few candidates. They are shown as a list to tap.
- **not mine**: the next agent in the stack gets the words.

The navigator is first in the stack. Apps add their own agents after it, for example one that sends the words as a
message. A stronger agent gets three tools: read the screen's text, list the actions, run one.

An offline navigator that matches words stands in for the model in tests and demos only (E4). In an app nothing
matches words in front of the model.

## Jev navigator (slice 4)

Jev answers typed questions with a typed answer and a probability, in well under a second. Jev decides every hold, in one
question that offers everything the user could mean: a system set and a rolling set. Navigation needs no generated
text, so Jev is enough.

- **The system set** is always offered: Earshot's standard options, then the actions of the screen and the app, in
  the app's order.
- **The standard options** are the same in every app: back, home, "not a navigation command" and "none of these".
  - Back and home are ordinary actions the router supplies, so touch reaches them too (E3) and an app replaces one by
    declaring an action with its id. Back at the home screen is blocked and says so.
  - "Not a navigation command" is the navigator's **not mine**: the words go to the next agent in the stack. The app
    gives the option its text, saying what its other agents take, for example "a message to send". It is offered only
    when the app has another agent.
  - "None of these" means the user asked to go somewhere that is not offered. It stops there with "No match", so a
    navigation command is never handed to another agent as if it were a message.
- **The rolling set** is a first in, first out queue of items the app adds, each an action with one of its targets,
  for example "open" with one conversation. Adding an item already in the queue makes it the newest. The queue
  belongs to the app, not a screen, so an item can be picked from any screen.
- **Jev takes 255 options a question.** The rolling set holds 255 less the system set; when it is full the oldest
  item leaves. Touch still reaches an item that left (E3).

- The thresholds that turn probabilities into verdicts live with the navigator.
- Private targets never enter the rolling set (E6) and are picked by touch.

### Context

An app improves the navigator's picks with context, all optional:

- a screen: what is on it now;
- an action: a hint of when to pick it;
- a rolling item: anything that tells it from the others, for example the latest text of a conversation.

The app hands Earshot the text whenever it changes, at any length. Earshot makes it fit:

- **Two limits, in characters.** One per item, and one for a whole question.
- **Per item, by compaction.** Text over the item limit is compacted at once, in the background, each item on its
  own. Until the compaction is back, and whenever it fails, the item's last characters are used. A hold never waits.
- **Text that changed while it was being compacted** drops that result and starts again once it has settled, so text
  that is still streaming is not compacted on every change.
- **Per question, by age.** The system set's text is counted first. When the rolling items pass what is left of the
  question limit, the oldest send their name only. Nothing is compacted for this limit.
- A private target sends neither name nor context, and is never compacted (E6).
- Context is untrusted text. It can change which target is picked; it never skips a `confirm`.
- Compaction sends an item's text to the compaction transport when the text changes, before any hold. An app that
  must keep text on the device gives no context for it, or supplies its own transport.
- Later: drill-down. When a few targets are close, the navigator asks again with a longer piece of only their text.
  Each step is one more typed question, so the model still writes no text.

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
| The wake phrase, then no words                 | Nothing                      | Listens for the phrase again             |
| Unsure                                         | The few candidates, to tap   |                                          |
| None of these                                  | "No match"                   | Stops; the words go to no other agent    |
| Not a navigation command                       | What the next agent shows    | Passes the words to the next agent       |
| The screen changed while deciding              | Nothing                      | Drops the verdict                        |
| The target left, or the action is blocked      | The reason                   | Reports it (E5)                          |
| Too many targets, or too much context          | Nothing                      | Trims to the cap                         |
| The model names an option that was not offered | "No match"                   | Treats it as unknown                     |

## Wake word (built with the first app that uses it, E8)

A second way to start a voice command, hands-free: a spoken phrase in place of a hold. Hold and the phrase are two
triggers of one path. After either, Earshot shows the overlay, records, transcribes and sends the words down the
stack. A hold ends at release; after the phrase, a pause in speech or a longest length ends it.

- It listens through the glasses. While it is on and the app is open on the glasses, Earshot keeps the glasses'
  microphone open and hands the audio to a detector on the phone. Nothing leaves the phone until the phrase is heard.
- The detector is the app's: it takes the audio and says when it heard the phrase. The app picks the engine and sets
  its own phrase. Earshot ships no detector and no model, because the open models found so far have licences that do
  not clearly allow commercial apps.
- Audio the SDK marks as someone else's voice is not handed to the detector.
- It is off until the app turns it on, so an app can make it the user's choice.
- A hold works as always while it is on.
- When the phone suspends the app the microphone stops; Earshot opens it again when the app is back.
- The phrase cannot open the app: an app runs only while it is open on the glasses.
- An action that asks first is still answered by a tap.

## Open

- How dimmed text behind bright text reads on real glasses, and which brightness levels to use. The overlay is
  built and dims to level 1; it is to be tried on real glasses before slice 3 relies on it. A reserved row is the
  fallback.
- Whether OpenRouter's sign-in redirect works inside the Even app's web view. To be tested before building on it.
- Whether screens get declared ids and parameters (`thread/:id`), so context and deep links attach to a route.
- The two context limits and how long text must be still before it is compacted. First guess: 1,200 characters an
  item, 240,000 a question, 5 seconds.
- Which other standard options every app gets. Candidates: "what can I say", which lists the actions to tap, and
  "never mind".
- For the wake word, on real glasses, before it is built: what it costs the glasses' battery to send audio the whole
  time, whether a detector runs in the Even app's web view, and whether the phrase also wakes Even's own assistant.
- How long a pause ends a command started by the wake word, and the longest command.
- Streaming speech-to-text, so words show while the user talks. It needs a second service and probably a back end.
