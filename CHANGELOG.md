# Changelog

What each version of Earshot changed, newest first. A version is a tag on `main`: `v0.0.42` is version 0.0.42. A line
that starts with **An app must** says what an app written against the version before has to change.

Earshot's API will change until two apps run on it. Before 0.0.37 these notes were written after the fact, from what
each version's commits say: they name what a version added, and may miss a change an app had to make.

## 0.0.63 (2026-11-27)

- A swipe on a text counts from what the wearer has read. A swipe made before the glasses have drawn the last one
  goes on from where that one reached, and text that came in the meantime is laid out after them.
- What belongs to a screen ends with it: a hold and a question that waits for a tap are called off when the
  screen changes, and a menu pick from the screen before does not reach the next one. A voice turn that is being
  decided is called off too, unless its words were already handed to an agent of the app: that agent may finish and
  say what it did, as in 0.0.46, and nothing else of the turn runs.
  A screen opened again after it was left starts at its beginning.
- One press of a touchpad records once, and a closed router sends the glasses nothing more.
- Live speech from Flux numbers the turns it tells itself, one by one and on across lines, so one number gone wild
  no longer hides the turns after it. A turn numbered more than 2^32 ahead of the newest of its line is not told.
- The router tells every listener of a change of screen, also when one of them throws.
- "Choose this one" and the row by name are one choice only when the model is told the same of both and both
  would run alike: the same labels and hint, the same risk, both blocked or both free, and no rolling item of
  another action. They were one choice whenever the names matched, so a vote split between the two could run an
  action of the same name that asks nothing, where the row on show asks first. When "choose this one" had the
  greater vote the row on show runs, as at a tap on it; when another row is on show by the time the model
  answers, the shell asks before it runs the row that was meant.

## 0.0.62 (2026-11-26)

- A notice shown while the touchpad is held goes under "Listening" and no longer over it. It wrote over it, until
  the next sound drew the meter again.

## 0.0.61 (2026-11-26)

- A hold ends when the screen changes under it: the microphone is let go of for it and "Listening" goes at
  once, though the touchpad is still down. It went on recording until the release, and then dropped what it had.
- So a notice the app showed when it changed the screen stays. The meter of the hold wrote over it at once, and
  the release took it away.

## 0.0.60 (2026-11-26)

- A list the shell made itself (the candidates, an action's targets, "More…") closes when a row of it is said by
  name, as it does at a tap. The row ran and the list stayed open over the screen.
- On the shell's list of an action's targets, "choose this one" and the row by name are one choice, as on a list
  of the app's screen.

## 0.0.59 (2026-11-26)

- A relay that is not set up makes the glasses say "Voice is off for now". They said "The service is busy",
  as for an upstream that is busy, since `notSetUp` answered with the same status.
- **An app must** expect 501, not 503, from `notSetUp`, if it looks at the status itself.

## 0.0.58 (2026-11-26)

- A notice the app showed after it changed the screen stays when the command that was being decided is dropped.
  The dropped command took away whatever was on show, so the user saw no reason why the words led to nothing.

## 0.0.57 (2026-11-26)

- An option that counts toward another names it: `same`, the other's id. "Choose this one" names the row it
  stands for, so an app that wraps the model can add the two up as the navigator does.

## 0.0.56 (2026-11-26)

- No further agent is asked once the screen changed while a command was being decided. When the navigator passed
  the words on after the screen had changed, the next agent was still handed them, with the new screen's actions.

## 0.0.55 (2026-11-26)

- An option of the navigator's question names what it would run: `action` and `target`. `SURE_AT` is the chance
  from which the navigator is sure. An app that wraps the model needs neither the options' words nor the number.

## 0.0.54 (2026-11-26)

- On a list, "choose this one" and the row under the cursor by its name are one choice for the navigator. When
  its model split a vote between the two, neither was sure, and the user was asked "Which one?" with two rows
  that did the same thing.

## 0.0.53 (2026-11-26)

- A rolling item with no text of its own is offered to the navigator's model with its action's `hint`. From
  another screen it was offered by its name alone, with no word of what it does.

## 0.0.52 (2026-11-26)

- `notSetUp`, from `earshot/relay`, is the answer of a host that cannot refuse to start when its settings make no
  relay: 503 that any page can read, and the browser's first check answered. The example's Worker uses it; a
  Worker without it answers with the runtime's own error, which a web view takes for a lost connection.

## 0.0.51 (2026-11-26)

- The relay forwards only the calls the developer names, of `speech`, `decide` and `compact`: `calls` in its
  options, `EARSHOT_RELAY_CALLS` for the Node server and `CALLS` for the Worker. Unset, it forwards all three.
- **An app must** pass `calls` to `relayOptions`, if it calls that itself, as a Worker does: `calls: env.CALLS`,
  or `calls: undefined`.

## 0.0.50 (2026-11-26)

- The relay answers an upstream's error with its status and none of its words. It passed the error's text back,
  and an upstream may quote in it what the user said.
- **An app must** tell an upstream's errors apart by status, if it read their text from the relay's answer.
  Earshot's own transports always did.

## 0.0.49 (2026-11-25)

- `glasses.micLeftOn` says that the glasses' microphone may still be on though nothing listens, because a close
  failed, and `glasses.onMicLeftOn` is told each time that changes. An app can now warn of it after a hold too.
- The stand-in for tests fails a close of the microphone on request: `fake.refuse('mic close')`.

## 0.0.48 (2026-11-25)

- `LIST_ROW_WIDTH` is how wide a row of a list is, so an app can fit a row before the list cuts it: keep the end
  of a row whole, or break it between words.

## 0.0.47 (2026-11-25)

- The simulator driver starts the simulator once more, on another port, when another program took the port the
  driver had picked for it. Such a start failed, or with Even's simulator ran out of time.
- A start no longer waits without end on a port whose holder takes the call and never answers.

## 0.0.46 (2026-11-25)

- What an agent says after it handled the words is shown also when the agent itself went to another screen. It was
  dropped with every other verdict of a turn whose screen had changed.

## 0.0.45 (2026-11-25)

- A tap on a list runs only the row the glasses show the cursor on, and a gesture a screen of boxes ties to an
  action runs only what the screen on show ties it to. A touch that comes while a redraw is still being written to
  the glasses is dropped; it ran what the newest frame held, which was not yet on show.
- A picture the glasses refuse is sent again, as a refused text already was.

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
