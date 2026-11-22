# Earshot

Voice-first app framework for Even G2 glasses. Design and slices: `docs/design.md`. `AGENTS.md` links here. `src` is the
framework; `check` is the build-time store check, `sim` drives Even's simulator for tests and `relay` is the server
that holds the developer's key. `installed` tests the package as an app gets it, and compiles the README's examples
against it. `check`, `sim` and the relay's Node server need Node.

## Rules

Checks cite these IDs. Changing one needs Jarek's OK.

- **E1** Only `src/glasses` imports the Even SDK. The rest runs anywhere.
- **E2** The framework connects only to hosts the app lists: it holds no address of its own, and only
  `src/openrouter` and `src/flux` open a connection. Speech-to-text, live speech, the navigator's model and compaction
  are transports an app can replace.
- **E3** Every action is reachable by touch. Voice is never the only way.
- **E4** The navigator's model sits behind one interface with an offline stand-in. Tests and demos call no outside
  service.
- **E5** A target the user chose is found again by id when the action runs. One that left is reported, never guessed.
- **E6** A target marked private never leaves the device.
- **E7** What a screen starts ends with it.
- **E8** An API is added only with an app that uses it, in the same slice.
- **E9** Every input a screen takes is an action, so voice can do whatever touch can.
- **E10** Double tap goes up. The stack is the path from home to the screen on show, never a history. A screen opens
  as a child of the one on show; a jump from anywhere (an action of the app, a rolling item, an alert) replaces the
  path.
- **E11** A page is rebuilt only when its boxes, its pictures' boxes or its menu change. Text and brightness change in
  place, and the overlay rebuilds nothing.
- **E13** The relay's hosts, the Node server and the example's Worker, are one server: each only hands requests to
  `relay`, and a setting or a feature of one is in the other in the same change. Only where a host listens, and how
  it takes and opens a WebSocket, is its own.
- **E14** Input that Earshot could not read in full runs nothing. A gesture, a pick or a value it does not know,
  cannot parse, or stopped reading before the end of, is no input: never a default, never a guess.
- **E15** A touch acts only on what the glasses are known to show: not on a row a notice still covers, and not as
  the answer to a question that is not on show yet.

## Code rules

- **C1** No comments, except tool directives and one-line notes of external facts the code cannot express.
- **C2** Delete, never bypass: a replaced path goes in the same change, with its tests and docs.
- **C3** A bug fix comes with a test that fails on the old code.

## Process

This is the maintainer's own process. A contribution from outside follows `CONTRIBUTING.md`: the rules above bind it,
and this section and the skills are not its to run.

Follow skill `develop` for every feature and fix; it reviews with skill `review-loop` and ends with skill `release`.
Write each test first and see it fail. `npm run check` before every commit.
Nothing reaches `main` but through a pull request with every required check green, and no agent merges on its own. When
Jarek corrects an agent, make the correction a rule here and a check, as high up as it can go: architecture, types,
tests, then prose. The repository is public: no secrets, and nothing about the apps that use it beyond what their own
READMEs say.
