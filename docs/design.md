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

`action({ id, say, risk?, blocked?, targets?, choose?, run })`.

- `say` is the label on the glasses and what the navigator reads.
- `blocked()` returns why the action does not apply now, or null. A menu stays fixed; the action answers when picked.
- `targets()` lists what the action could be aimed at: `{ id, say, value, private?, risk? }`. A target's own `risk`
  replaces the action's. `choose()` shows the targets on the app's own screen when touch picks the action; without
  it Earshot lists them.
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
containers change, and maps the touchpad to actions: swipe moves, tap runs, double tap goes up (E10).

`Glasses` draws frames of boxes and reports input.

- One draw at a time, and only the newest frame waits. Text and brightness change in place; anything else about a box,
  or a change of menu, rebuilds the page, at most once in 300 ms. A refused draw is retried after 0.5, 1, 2 and then
  4 seconds.
- A full-screen box behind the others takes the input. It holds no text of the page's, because the firmware animates
  a bounce on the box that takes the swipes. The overlay goes there, on the last lines, so the overlay
  costs no box: an app has seven of the eight text boxes. Earshot sets the front-to-back order of all of them.
- `overlay(text)` lowers the brightness of the page in place and draws the text, bright, in a card in that box.
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

A frame can carry up to four pictures, each a box with a key and its data. They sit behind the text and in front of
the input box. The data is sent after the page is built and again only when the key changes, so a new picture rebuilds
nothing; a picture the glasses refuse is tried again like any draw.

An app can watch the draws for its own log: each frame has a number, and `watch` is told when a frame begins and
ends, each call to the glasses with its answer and how long it took, each retry with its wait, and when a frame is
put off: between two rebuilds, or behind a retry.

No rebuild starts while the microphone opens: the Even app answers one call at a time, so a rebuild on its way would
hold the microphone back past a short hold. Text still changes in place meanwhile. An app that makes such a call
to the Even app itself says so with `holdRebuilds`.

Still to try on real glasses: how the dimmed page reads behind
the overlay, and which levels to use. It is 1 now.

## Hold and the agent stack (slice 3, built)

Built: the shell owns the hold. It opens the glasses' microphone, records until the release, drops a recording under
half a second or with no sound in it, and gives the rest to the app's transcriber. The words go to the navigator and
then to the app's agents. The navigator asks one question of a model behind one interface; the model built in is
`matchWords`, the offline stand-in (E4), which compares the words with the labels. A double tap calls a command off, a
hold without a release ends after a minute, and an answer that takes over forty-five seconds is given up on. A hold while
a question is up calls the question off.

Not built yet, and belonging to the next slice: Jev as the model, the rolling queue of items, context and its
compaction, and the default transports.

The design it follows:

Hold always opens the mic. Earshot owns the hold, the recording and the checks for a recording that is too short or
silent. The hold is one trigger of this path; a wake word can be a second (below). Release sends the audio to a
transcriber, `(audio) => text`, and the words show briefly as heard. The Even SDK gives an app the raw microphone
only: the "Hey Even" wake word and Even's assistant screen are closed to apps, so Earshot draws its own listening and
heard lines.

### The voice overlay

The same in every app, so a user learns it once. During a hold, and while the words are shown and decided on, Earshot
lowers the brightness of the page's text in place and draws a card along the bottom, like a notification: a rounded
border of box-drawing characters around up to three lines (listening, the words heard, and what went wrong). The card
grows with its lines. Each box of the page keeps only its lines above the card, cut where the glasses would wrap them.
When it is done the page comes back. Nothing is rebuilt, so nothing flickers.

- The display has no fill: black is see-through. No box can hide what is behind it, so the page gives up the card's
  rows, and dimming sets the rest back. A picture of the page under the card still shows.
- The overlay and its words are Earshot's. Everything else on the page is the app's.

The words go down a stack of agents; each answers with a verdict:

- **sure**: this action, this target. Safe actions run; `confirm` actions ask first.
- **unsure**: these few candidates. They are shown as a list to tap.
- **not mine**: the next agent in the stack gets the words.

Built since: the person can turn the navigator's choice down. The model's pick is a guess, and words meant for an
agent are lost if the only answers to its question are yes and no. When the app names what its agents do with the
words (`instead`, a few words for the glasses: "Keep as a note") and has an agent after the navigator:

- A question the navigator raised gains a third line, "Swipe: Keep as a note". A tap still confirms and a double tap
  still drops it; a swipe either way starts a turn of the agents alone, with the same words and recording. Nothing is
  transcribed or asked of the model again.
- The list of candidates gains it as the last row.
- Only the navigator's choices: a question a touch raised has no words, and an agent's own question is the app's.
  A sure choice that needs no tap has run by then.
- The card holds three lines, so a question that wraps pushes the swipe's line out; the swipe still works.
- A question is answered by touch only: a tap, a swipe or a double tap. A hold calls it off and listens anew, as it
  always has. The question is there because the model's pick is a guess, so a second guess never answers it, neither
  to confirm nor to hand the words on, which in an app can be a write as well. It is the shell's question, not an
  input of a screen (E9), and what a swipe does is what saying the words again does when the navigator passes them.

The navigator is first in the stack. Apps add their own agents after it, for example one that sends the words as a
message. A stronger agent gets three tools: read the screen's text, list the actions, run one.

An offline navigator that matches words stands in for the model in tests and demos only (E4). In an app nothing
matches words in front of the model.

## Jev navigator (slice 4, built)

Built: the one question with its system set and rolling set, going back and going home as actions of the router,
context with its two limits and its compaction, the thresholds that turn the model's chances into a verdict, and the
three OpenRouter transports, and the relay that holds the developer's key. The numbers are first guesses: sure from 0.7, a candidate from 0.15, at most
three candidates, 1,200 characters an item, 240,000 a question, five seconds of stillness.

Tried live on 2026-11-20 with `typesafe/jev-1.14`: an answer in about 0.2 seconds, the wanted option on 12 of 12 test
phrases, each sure pick at 0.82 or more, and 24 questions for $0.0006. Speech-to-text and compaction answered
correctly in form; the relay has not been tried from inside the Even app.

Tried live the same day through the relay as a Cloudflare Worker: a Jev question in about 0.35 seconds end to end,
and eleven seconds of recorded speech turned into the right words in 1.7 seconds.

The design it follows:

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
use it, compaction. Earshot ships all three for OpenRouter, paid by the developer: no user signs in.

- **The key cannot be in the app.** An app is web files on the user's phone; anyone can read them, and the key
  travels in every request. So the key stays on a server of the developer's, the relay, and the app calls the relay.
- **Earshot ships the relay** as one function on web standards, request in and response out. Its Node server uses
  the `ws` package for live speech.
  It runs unchanged on Node, where Earshot also ships a server and a command, and as a Cloudflare Worker, Deno or
  Bun. Earshot is tied to none of them.
- **The relay waits just under what the app waits.** Ten seconds for a question or a shortening, where the app
  waits twelve; twenty-eight for speech, where it waits thirty for each part of a recording. A slow upstream is then
  the relay's own answer, and a long part is not cut off early.
- **Its two hosts are one server (E13).** The Node server and the example's Worker only hand requests to `relay`, and
  read their settings through `relayOptions`, whose type names every setting a host must pass. One table of calls
  runs against both and their answers must match. Only where a host listens (`PORT`, `HOST`) is its own, and for
  live speech how it takes and opens a WebSocket (below).
- **A long recording goes in parts.** Over a minute, the transcriber cuts it at its quietest moment near each minute
  and joins the words, so each part fits the relay's four megabytes.
- **A request ends with its turn.** The shell hands the transcriber and the model the lifetime of the command; the
  OpenRouter transports abort with it, and an error carries the status of its own request.
- **It forwards little.** Only the three calls, only the models the developer lists, only the fields Earshot sends,
  and nothing over a size limit. A stranger who finds the address gets those three calls, not a general key.
- **It does not know one user from another.** The developer sets a spending limit on the key at OpenRouter; that
  is the most a stranger can cost, and when it is reached voice is off for everyone until it resets. A limit for
  each user is the next step, when an app needs it.
- The app names the relay as its host (E2), and the developer names the relay's upstream. Earshot holds no address
  of its own, in the app or in the relay, and the store check holds the app to its whitelist.
- An app with its own back end plugs in its own transports, and then its audio and context go only there.
- Built first, then deleted: sign-in with the user's own OpenRouter account (OAuth PKCE), so that the user paid. It
  was the wrong default: the cost is the developer's.

### When it goes wrong

One typed list of failures, each with default glasses text an app can override. Touch still reaches everything (E3).

| Situation                                      | User sees                    | Earshot does                             |
| ---------------------------------------------- | ---------------------------- | ---------------------------------------- |
| Offline, or no answer in time                  | A short reason               | Drops the hold                           |
| Relay refused or out of credit                 | "Voice is off for now", once | Stops calling for a while; no retry loop |
| Rate limited, busy                             | A short reason, once         | Stops calling for a while; no retry loop |
| Nothing heard, or too short                    | "Didn't catch that"          | Sends nothing                            |
| The wake phrase, then no words                 | Nothing                      | Listens for the phrase again             |
| Unsure                                         | The few candidates, to tap   |                                          |
| None of these                                  | "No match"                   | Stops; the words go to no other agent    |
| Not a navigation command                       | What the next agent shows    | Passes the words to the next agent       |
| The screen changed while deciding              | Nothing                      | Drops the verdict                        |
| The target left, or the action is blocked      | The reason                   | Reports it (E5)                          |
| Too many targets, or too much context          | Nothing                      | Trims to the cap                         |
| The model names an option that was not offered | "No match"                   | Treats it as unknown                     |

## Contextual navigation (built in part)

Voice must be able to do everything touch can, in any app, without the app writing voice code. Today it cannot: a
`boxes` view takes raw touches in its own code, which the navigator never sees. The rule that closes this is E9:
**every input a screen takes is an action.** A screen declares its actions; Earshot derives the tap, the row a swipe
lands on, Even's menu and the navigator's options from that one list. A screen then has no input voice cannot reach,
and one check can prove it for any screen.

- **Three sets per hold**, as now: the system's, the screen's, and the app's with the rolling queue. The system set
  grows from back and home to what every screen with more text than fits needs: scroll up, scroll down, top, latest.
- **The item under the cursor** goes to the model as context, so "pin this" and "open it" mean something.
- **A submenu is one sentence.** An action that opens a list of further actions offers those to the model too, so
  what takes three steps by touch is said once.
- **States inside a screen** change its action list, never the drawing of Even's menu: an action that does not apply
  right now is blocked and says why. A menu that is redrawn can freeze the glasses for seconds.
- Press and hold belongs to Earshot on every screen: it is the microphone. An app's own hold gesture moves to the
  menu and to voice.

Built: a `boxes` view binds a tap and each swipe to an action (`on`), and takes no raw input; those actions go to the
model and stay out of Even's menu. The shell adds its own for what its views do by touch: scroll a long text, move a
list's cursor, choose the row under it. The row under the cursor goes to the model as context unless it is private.
A pick from Even's menu is ignored while the glasses still show another screen's menu. While a command is being
decided, a touch only calls it off: an agent's pending work ends with the turn's lifetime, and a new hold starts over.
A submenu is one sentence: an action with targets is offered to the model once for each target that is not private,
named "action: target", and an action with a single target is offered only as that. Beside its targets the
action alone is offered as "action (show the list)": against the real model, "use opus" split 54 to 43 between
"Model" and "Model: Opus" and neither was sure; with the list named, the target wins. A target that is also a
rolling item is offered once, with the item's context.

### Double tap goes up (E10)

Jarek, 2026-11-21: double tap is the glasses' way out, so it goes up, in every Earshot app. With voice a user jumps
from anywhere to anywhere; if each jump were pushed, the way out would grow with every place visited and nobody could
say where a double tap lands.

- The router's stack is the path from home to the screen on show. `open` adds a child. `jump(...path)` makes the
  path under home the one given, keeps the screens it shares with the old path (they neither leave nor enter), and
  leaves the rest.
- The shell runs a from-anywhere action as a jump: an action of the app, and a rolling item picked on a screen that
  does not offer its action. While it runs, each `open` is the next step of the path from home, so an app cannot
  pile up history by accident. An action that opens nothing leaves the path alone.
- What is lost: a gesture that returns to where a jump came from. Saying its name does that.
- Known: the jump lasts until the action's promise settles, so a child opened by another input in that time is
  taken for a step of the jump.

## Listening (slice 5, built)

The microphone is open while anything listens. A hold is one listener; an app that hears for longer is another.

- `glasses.listen(hear)` adds a listener and returns what removes it. The first one opens the glasses' microphone and
  the last one closes it, so no caller opens or closes it for another.
- Each piece of sound comes with who the Even app says spoke: `self`, `other` or `unknown`. Even makes no promise
  about that guess, and the phone's microphone gives `unknown`.
- A hold has the microphone to itself. A listener hears a sound exactly when no touchpad is held down, whenever it
  joined and whichever touchpads were pressed meanwhile; so a voice command is never part of what an app is listening
  to, and a hold starts without waiting when the microphone is already open. The hold asks for the microphone only
  while it records, so a touchpad held with no voice set up and nothing listening asks nothing of it: called off, or past its longest length, it still keeps the listeners from hearing until the
  release, and no longer keeps the microphone open by itself. It is told of a refused open by a way of its own, so
  news meant for others, such as the close a departing listener asked for, cannot fail it. Only the shell can take it: the way in is not part of the public API. A hold whose microphone did not
  open still keeps the listeners from hearing until its release, and so does one that was called off or reached its
  longest length. A release can be lost, and a session must not go deaf for it: the listeners hear again after twice
  the longest hold, or when the app leaves the foreground.
- When the phone suspends the app, capture stops and nothing says so. So each listener has a time without sound after
  which Earshot takes the microphone for closed and asks for it again: three seconds unless it says otherwise (from
  half a second to a day, or never). Only those that hear now count, and the time is worked out again whenever they change.
  The shortest time among them counts. A hold has no such time, so silence never makes Earshot ask again during a
  hold, also while an app listens. When the microphone refuses to open for a hold, the shell says so and ends the recording; the
  microphone is asked again only while something still wants it, a listener or a new hold. And a hold asks for the microphone once
  as it starts to record, open or not: after a suspension Earshot may still take a dead microphone for open, and the
  simulator answers `true` to a second open.
- The microphone is one small machine, in `src/glasses/mic.ts`. It knows two things: whether capture may be on (an
  open was asked for and no close has been answered since), and whether it takes the microphone for open. A
  microphone Earshot never asked for is not its to close: an app that opened the phone's microphone itself keeps it.
  It makes one call at a time and looks again after each answer, so a close on its way is answered before the next
  open is asked. An open that is refused, and a close that fails to go through, is asked again after 0.5, 1, 2 and
  then 4 seconds. A close is done when it is answered, whatever the answer: Even's simulator answers `true` to an open
  and `false` to a close that worked. A simulator test holds that, and the stand-in bridge answers the same. Its
  timers are its own, so a close that fails as the app ends is still asked again, five times in all, and then no
  more. An open that was asked for and not yet answered as the app ends is owed a close too.
- Sound that arrives is proof the microphone is on, whatever a call answered: a refused try to get it back fails
  nothing that is hearing, and capture that proves to be on with nobody listening is closed. A sound is handed out
  before its news is told, and only to those who were to hear it when it came.
- `micOpen` says whether Earshot takes it for open; `onMic` is told each change in the order it happened, and `false`
  again each time an open is refused. False means not hearing, which silence alone can make it: the sure sign that the
  glasses' microphone is closed is the promise of the function that stopped the last listener. A microphone that
  opens after the last listener left is closed and not told of.
- Each sound says whether there was a break before it in what that listener heard (`gap`): the first sound, the
  first after a hold, the first after the microphone was closed, opened or asked for again.
- The function that stops a listener gives a promise that is kept when the machine is calm: nothing asked, nothing
  owed, looked at again after anything an app was told. Every open Earshot asked for is owed a close once nothing
  listens, whatever was answered, since capture may have begun. After that close the microphone is not Earshot's, and
  sound from one the app opened itself is left alone.
- A sound that follows a new request for the microphone is marked as after a break once: at the request, or at the
  answer when nothing was heard in between.
- Each listener gets its own copy of a sound. A listener that throws stops nothing. Earshot reports that one threw
  and not what, to the page's error reporting or the console, since the error may carry what was heard.
- A hold ends at the release of the touchpad that was held. A release that names another, or none when the hold
  named one, does not end it: it would let the rest of a command reach the app's listeners.

Still to try on real glasses: whether sound keeps arriving while nobody speaks, whether asking for an open
microphone again is harmless, and whether a hold and its release always name the same touchpad. If the glasses send nothing in silence, a lasting listener asks again every three
seconds of it.

## Live speech (slice 6, built)

Words while they are said. A hold's recording is sent when it is finished; an app that listens for longer wants the
words as they come.

- One interface, `LiveSpeech`: `start(life, heard, told)` gives back the function that takes each sound, and tells of
  turns. A turn has an id, its words so far, whether it is final, whether it was cut, and who spoke most of it. It is
  told again as it grows. `told` hears `down`, `on` and `refused`, and nothing while all is well.
- A turn is `cut` when the sound or the line ended it and not the speaker, so an app that scores or files whole
  sentences can tell half of one.
- Nothing is told once the lifetime has ended, also when the listener ended it while being told: a turn that was
  growing then stays as it was last told (E7).
- `scriptedLive` is the offline stand-in (E4), driven by the amount of sound alone, so a test needs no clock. Each
  start plays the lines from the first, so two listeners on one script do not take each other's lines. Where the
  real transport draws a line, the stand-in draws the same one: a break ends the turn and nothing from before it
  counts towards the next word, the speaker is whoever spoke most of the turn's sound, and the listener is told
  after the sound is taken in. Once its last line is said it takes no more sound. The example's Listen screen shows
  its turns, a growing one with three dots after it.
- `fluxLive` (`src/flux`, the second folder that may open a connection, E2) is the transport: sound to the
  developer's relay over one WebSocket, and Deepgram Flux's turns back. Flux decides where a turn ends, so Earshot
  cuts nothing by pauses. The relay is named with `https`, or is on the same device, and by its address alone: the
  line carries the secret, so it is opened at the address that was checked, never at the text that was given.

The line, as states:

| State      | It is                                  | Leaves when                                                         |
| ---------- | -------------------------------------- | ------------------------------------------------------------------- |
| Idle       | No line. Nothing is held               | A sound comes: it is held, and a line is opened                     |
| Connecting | A line asked for; sound is held        | Flux says `Connected`: the held sound goes first. Ten seconds: lost |
| Live       | Sound goes out as it comes             | Ten seconds with no sound: closed, back to idle. A drop: lost       |
| Waiting    | No line, after a loss; sound is held   | Half a second, then double, up to eight: a line, if sound is held   |
| Refused    | The relay closed with 4400, 4401, 4403 | Never: nothing is sent or held until the app starts again           |

- A line that closes while the lifetime goes on ends the turn that was growing, as final and cut, with the words it
  had. Turns of the next line are numbered on from there.
- While the line is up, sound goes out as it comes. Only sound that cannot be sent yet is held: the last ten
  seconds of it, to the sample, in memory of its own (a long piece is copied, not kept whole), and let go of when the
  lifetime ends. It is sent however long the line was away, unless the app set `staleMs`: then sound held longer is
  dropped, before the transport decides whether to open a line again or to stay awake; so is sound whose age
  cannot be told because the clock went back. A transcript wants the late
  words; a command does not. The example's Listen screen sets three seconds.
- A break in the sound ends the turn that was growing, as cut, and what follows goes on a new line: on one line Flux
  would join the words on either side of a hold. Sound still held from before the break is let go, so no line ever
  carries both sides. The stand-in cuts at a break too, so an app tested on it sees what it will get.
- **What the transport holds and hands over is its own.** Held sound is a copy of exactly what is held, so an app
  may reuse its buffer. A turn handed to the listener is a copy too. Sound that was held gets the whole quiet time
  from the moment it goes out, so its words are still heard.
- **A listener's failure says nothing of what was heard.** Turns and changes are handed over the way the microphone
  hands over sound: if the listener throws, or its promise fails, one fixed sentence is reported and the words stay
  out of it. The stand-in does the same.
- **What ending cannot take back.** Ending the lifetime closes the line and lets go of held sound, but sound the
  browser had already taken for the line may still be sent before the close: a page cannot cancel it.
- **Sound that comes while a line is closing is held**, not handed to a socket that would drop it, and goes out
  on the next line.
- **A line that cannot even be opened is a line lost.** If the browser refuses to make the socket, the transport
  says `down` and tries again as after any loss; nothing is thrown at the app's microphone listener.
- **Its socket and its clock are its own.** Tests hand in their own through `fluxOver`, which the package does not
  export; an app gets `fluxLive` and its three settings.
- **The app is told last.** Every step of the transport (a sound, a message, a close, a timer) first settles its own
  state and only then tells the listener of turns and changes, in order. A listener may feed sound or end the
  lifetime from inside its callback and finds the transport as the callback describes it. The stand-in moves on to
  its next line before it tells of a final turn, for the same reason.
- Sound goes out a second at a time at most, whatever size the glasses hand over, so the relay's limit on one piece
  is never met by a well-behaved app. A line whose sound is not getting out (thirty seconds of it queued, looked at
  before each second that goes out) counts as lost, and the rest of the piece is held.
- The speaker of a turn is whoever the glasses named for most of the stretch of sound Flux says the turn came from.
  The transport keeps who spoke only for sound no finished turn has covered.
- The first tests ran on what Flux really sent: 90 messages recorded on 2026-11-23 from 21 seconds of synthetic
  speech, kept as `src/flux/recorded.jsonl`.

### The relay's part

- One path, `/api/v1/live`, a WebSocket. The caller's first message is a greeting: the secret, the model, and the
  few settings the relay lists. The relay checks them, opens the upstream with the developer's key, and from then on
  passes sound up and text down. Nothing else the caller says is passed on.
- It closes with a code of its own: 4400 for no proper greeting in three seconds, 4401 for a wrong secret, 4403 for
  a model nobody listed, 4502 when the upstream does not open in five seconds or goes, and 1009 for any message over
  64 kilobytes, sound or text, counted in bytes on both hosts. The first three are for good; the transport tries
  again after any other.
- **The sound stays out of training.** The relay adds Deepgram's `mip_opt_out` to every line itself, so no caller
  can leave it out or turn it off.
- **The secret is required.** Live speech is billed by the minute and the provider offers no limit to set, so no
  relay is made with a live upstream and a secret under sixteen characters, or over 1,024 as a greeting writes it
  (a sign JSON must escape counts for six), which no greeting could carry. The relay itself refuses, so a host that
  builds its options by hand cannot skip the check. The secret is the user's to type on the phone, never the
  build's, and never part of an address. The relay does not count minutes yet: that comes with the first app that
  needs it.
- **No key travels in the clear.** An upstream is named with `https`, or `wss` for live speech, unless it is on the
  same machine. The relay follows an upstream to no other address, for the three calls as for live speech, so a
  redirect gets no key and no recording.
- **What the relay starts ends with the caller.** When the caller leaves, the relay tells the host to stop reaching
  for the upstream, and closes it if it opened all the same. A host that is closing says so (`Sockets.closing`); the
  relay then tells each caller it is going (1001) and lets go of the upstream at once, without waiting for the
  caller to answer. The Node server does this when it is closed, and drops an upstream outright, open or not, so no
  goodbye waits behind queued sound. Set listening again, it takes live callers again.
- **The Node server takes only its own WebSocket path, and none without live speech.** An upgrade on any other path
  is left to the app's own listener, when it has one; with no live speech set the server listens for no upgrade at
  all. The upstream of the three calls is used spelled as the developer spelled it, a query of its own
  included, as it always was. It is always a whole address, written with its scheme and two slashes, and with
  `https` (`wss` for live speech), or plain `http` (`ws`) on the same machine (`localhost`, `[::1]`, anything in 127)
  and no other scheme, so the address that was checked is the one that is used on either host. A host that brings
  its own `fetch` names a whole address too. For some rounds of review it could name a path on itself, as it could
  before this change; every way of checking such a name left one that came to mean another host, so it was removed
  (Jarek, 2026-11-23). The live upstream is dialled at the address that was checked.
- **An upstream that misbehaves is dropped at once.** When the Node server's socket to the upstream fails (a
  message too large, say), it is destroyed there and then, so the caller hears 4502 as soon as a Worker's would.
- **A refused upgrade leaves no socket behind.** The Node server destroys the socket once its answer is written,
  also when the caller keeps its own side open.
- **A caller who will not say goodbye is let go of.** When the relay closes a line, the Node server waits one second
  for the caller's answer and then drops the socket; unanswered, `ws` would hold it for thirty.
- **A host hands the relay its sockets when it makes it**, so what `relay` gives back still takes one request and
  fits wherever it fitted before.
- **It holds little.** A message of the upstream's over 64 kilobytes, text or sound, ends the line (4502) on both
  hosts. On Node the
  relay stops passing to a side that has stopped taking once a mebibyte is queued for it (1013). A Worker's
  WebSocket does not say how much it has queued, so there the runtime's memory limit is the bound.
- **The upstream is Cloudflare's AI Gateway, for both hosts.** Reaching Workers AI through a Worker's own binding
  would have made the Worker a different server from the Node one (E13). Tried on 2026-11-23: a WebSocket to the
  gateway's Workers AI path opens with the header `cf-aig-authorization`, and Flux answers as it does directly.
- **Each host takes and opens a WebSocket in its own way** (E13, as Jarek agreed on 2026-11-23), because no web
  standard covers either: a Worker takes one with `WebSocketPair` and opens one with its own headers through
  `fetch`; Node does both with the `ws` package. Each is a few lines beside `relay`, and every case of the live path
  runs against both hosts for real, the Worker in Cloudflare's own runtime on the test machine.
- **A relay can be for live speech alone.** With no upstream for the three calls it forwards none of them.
- What those runs and the gateway showed, which the docs did not say:
  - The gateway does not answer with a subprotocol when the token is sent as one, the way its docs give for
    browsers. Node's WebSocket then fails the connection; a Worker's does not. So the token goes in a header.
  - A Worker gives a WebSocket's sound as a Blob unless asked for an ArrayBuffer, and takes a message of more than a
    mebibyte, so the limit on a piece of sound is the relay's own.
  - A Worker's `fetch` follows a redirect, headers and all, unless told not to.
  - Node's own WebSocket can send a header, but it asks a second time when answered 401, and it cannot drop a
    connection it is still making. So the Node server opens the upstream with `ws`.
  - `ws` hands on a message that came with the opening before a promise made at the opening is read. So a host hands
    the relay the line at the moment it opens, and the relay listens at once.
  - Workers AI takes every setting of a speech model as text, a number or a boolean being refused.
- The app lists the relay twice in its whitelist: `https://` for a hold and `wss://` for live speech. The store
  check cannot see a missing `wss://` entry, because the address is made from the host as the app runs.
- The example takes the relay's secret from a field on its phone page only. What the glasses show is written to the
  console only in the build the simulator tests make, never in the packed one: with live speech a frame holds what
  was said.
- Not tried yet: a deployed Worker, and live speech from inside the Even app.

## Wake word (built with the first app that uses it, E8)

A second way to start a voice command, hands-free: a spoken phrase in place of a hold. Hold and the phrase are two
triggers of one path. After either, Earshot shows the overlay, records, transcribes and sends the words down the
stack. A hold ends at release; after the phrase, a pause in speech or a longest length ends it.

- It is one more listener (above). While it is on and the app is open on the glasses, the detector listens through
  `glasses.listen`, on the phone. Nothing leaves the phone until the phrase is heard.
- The detector is the app's: it takes the audio and says when it heard the phrase. The app picks the engine and sets
  its own phrase. Earshot ships no detector and no model, because the open models found so far have licences that do
  not clearly allow commercial apps.
- Sound marked as someone else's voice is not handed to the detector.
- It is off until the app turns it on, so an app can make it the user's choice.
- A hold works as always while it is on: it has the microphone to itself, so the detector does not hear the command.
- The command after the phrase is recorded by the shell the way a hold is, with the microphone to itself.
- The phrase cannot open the app: an app runs only while it is open on the glasses.
- An action that asks first is still answered by a tap.

## Open

- How dimmed text behind bright text reads on real glasses, and which brightness levels to use. The overlay is
  built and dims to level 1; it is to be tried on real glasses before slice 3 relies on it. A reserved row is the
  fallback.
- Whether the Even app's web view reaches the relay: its cross-origin check, from whatever origin Even gives the
  page. Tried in the simulator only.
- A limit for each user in the relay. Even's SDK gives a user id, but nothing proves it.
- Whether screens get declared ids and parameters (`thread/:id`), so context and deep links attach to a route.
- The two context limits and how long text must be still before it is compacted. First guess: 1,200 characters an
  item, 240,000 a question, 5 seconds.
- Which other standard options every app gets. Candidates: "what can I say", which lists the actions to tap, and
  "never mind".
- For listening, on real glasses: what it costs the glasses' battery to send audio the whole time, whether sound
  arrives in silence, and whether the microphone stays open with the phone locked.
- For the wake word, before it is built: whether a detector runs in the Even app's web view, and whether the phrase
  also wakes Even's own assistant.
- How long a pause ends a command started by the wake word, and the longest command.
