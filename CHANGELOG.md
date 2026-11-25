# Changelog

What each version of Earshot changed, newest first. A version is a tag on `main`: `v0.0.42` is version 0.0.42. A line
that starts with **An app must** says what an app written against the version before has to change.

Earshot's API will change until two apps run on it. Before 0.0.37 these notes were written after the fact, from what
each version's commits say: they name what a version added, and may miss a change an app had to make.

## 0.0.45 (2026-11-24)

- A tap on a list runs only the row the glasses show the cursor on, and a gesture a screen of boxes ties to an
  action runs only what the screen on show ties it to. A touch that comes while that is still changing on its way
  to the glasses is dropped; it ran what the newest frame held, which was not yet on show.

## 0.0.44 (2026-11-24)

- A tap or a swipe that takes a notice away does nothing else. It also ran the row under the cursor, which the
  notice covered. A double tap still goes up, and a pick from Even's menu still runs.
- A tap or a swipe reaches the page only once the glasses have taken a notice away in full, and answers a question
  only once the glasses show that question.

## 0.0.43 (2026-11-24)

- A gesture Even's SDK does not know is no input. It was read as a tap, and a tap runs what the cursor is on.
- An event whose parts name different gestures is no input either, nor is a pick from the menu whose item the SDK
  could not read. A gesture that arrives with sound is no longer dropped.

## 0.0.42 (2026-11-24)

- The simulator driver, `earshot/sim`, runs on Windows.

## 0.0.41 (2026-11-24)

- The relay's three calls for a hold work on a Cloudflare Worker again. In 0.0.36 to 0.0.40 each of them was answered
  502 there; the Node server was not affected.
- **An app must** deploy its relay again from this version, if it runs the relay as a Worker.

## 0.0.40 (2026-11-24)

- Earshot is tested on macOS, on Windows and on the newest Node as well as on Linux.

## 0.0.39 (2026-11-24)

- The example app stands alone: copy `example/` out, install and run it. The README's "Your first app" says how.

## 0.0.38 (2026-11-24)

- **An app must** build with Node 24 or newer. Earshot asks for the Node it is built and tested on.

## 0.0.37 (2026-11-23)

- A request takes what `toWav` gives as its body: its type says the bytes are in an `ArrayBuffer`.
- The package is tested as an app installs it, and every example of the README is compiled against it.

## 0.0.36 (2026-11-23)

- Live speech: words while they are said, turn by turn, with `fluxLive` and its offline stand-in `scriptedLive`.
  The relay takes it over one WebSocket, on the Node server and on the Worker.
- A text view with `end: true` shows its last lines and goes on showing the last as the text grows.
- **An app must** build with Node 22 or newer.

## 0.0.35 (2026-11-23)

- The navigator's choice can be turned down: a swipe hands the words to the app's agents.

## 0.0.34 (2026-11-23)

- The microphone is open while anything listens, so an app can hear for longer than a hold: `glasses.listen`.
- **An app must** use `listen` where it used `openMic`, `closeMic` or `onAudio`. They are gone.

## 0.0.33 (2026-11-22)

- The relay's two hosts are one server: the Worker takes the models the Node server takes.

## 0.0.32 (2026-11-22)

- The relay gives speech 28 seconds, not 10, so a long recording is not cut off.

## 0.0.31 (2026-11-21)

- A voice request ends with its command, and an error carries the status of its own request.
- `scriptedSpeech` stands in for speech-to-text in tests.
- A command waits 45 seconds for the words and then its answer.

## 0.0.30 (2026-11-21)

- A recording over a minute is transcribed in parts, cut at its quietest moment.

## 0.0.29 (2026-11-21)

- The voice overlay is a rounded card along the bottom, and the page stops above it.

## 0.0.28 (2026-11-21)

- Beside its targets, an action alone is offered to the navigator as the list of them.

## 0.0.27 (2026-11-21)

- An action can show its targets on the app's own screen, and a target can carry its own risk.

## 0.0.26 (2026-11-21)

- Double tap goes up. The stack is the path from home to the screen on show, never a history, and `Router.jump`
  replaces the path.

## 0.0.25 (2026-11-21)

- An action is offered to the navigator's model with each of its targets.

## 0.0.24 (2026-11-21)

- The navigator hands its model the turn's lifetime.

## 0.0.23 (2026-11-21)

- A list the shell made passes on that the words chose its row.

## 0.0.22 (2026-11-21)

- No agent is asked once a command was called off.

## 0.0.21 (2026-11-21)

- `risk: 'voice'` asks before an action runs when the words chose it, and runs at once from a touch.

## 0.0.20 (2026-11-21)

- A hold tells the app when it starts to listen (`onListen`), and drops what was said if the screen changed.

## 0.0.19 (2026-11-21)

- Leaving the app calls a command off.

## 0.0.18 (2026-11-21)

- Bars rise with the voice while a hold listens. Any touch calls off a command that is being decided.
- An agent gets the recording, and `maxHoldMs` sets how long a hold may record.

## 0.0.17 (2026-11-20)

- Every input a screen takes is an action, so voice can do whatever touch can. A boxes view binds a tap and each
  swipe to an action, and takes no raw input.

## 0.0.16 (2026-11-20)

- No rebuild of the page starts while the microphone opens.

## 0.0.15 (2026-11-20)

- An app that watches the draws is told when a frame has to wait.

## 0.0.14 (2026-11-20)

- Pictures in a frame, and a way for an app to watch the draws.
- The overlay writes in the input box, so an app has seven text boxes.

## 0.0.13 (2026-11-20)

- Voice is paid by the developer, through a relay that holds the developer's key. Sign-in with a user's own
  OpenRouter account is gone.

## 0.0.12 (2026-11-20)

- The navigator's model (Jev), speech-to-text and compaction, through OpenRouter.

## 0.0.11 (2026-11-20)

- The navigator's question, the rolling set and context.

## 0.0.10 (2026-11-20)

- Hold to talk, and the stack of agents with an offline navigator.
- The example app has a manifest, a build and a pack script.

## 0.0.9 (2026-11-20)

- Screens on the glasses, run from the touchpad.

## 0.0.8 (2026-11-20)

- Boxes drawn on the glasses, and input read from them.

## 0.0.7 (2026-11-20)

- The simulator driver: run an app in Even's simulator from a test.

## 0.0.6 (2026-11-20)

- Storage: one store over two places, where the newest copy wins.

## 0.0.5 (2026-11-20)

- Text for the glasses: measure, fit and split with Even's own widths.

## 0.0.4 (2026-11-20)

- The store check reads scripts with acorn, not with the TypeScript compiler.

## 0.0.3 (2026-11-20)

- The store check: the manifest's rules, and a scan of the build for addresses.

## 0.0.2 (2026-11-20)

- Lifetimes: what a screen starts ends with it.

## 0.0.1 (2026-11-20)

- Actions as data, and the router.
