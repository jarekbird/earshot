# Earshot

Voice-first app framework for Even G2 glasses. Design and slices: `docs/design.md`. `AGENTS.md` links here. `src` is the
framework; `check` is the build-time store check, which needs Node.

## Rules

Checks cite these IDs. Changing one needs Jarek's OK.

- **E1** Only `src/glasses` imports the Even SDK. The rest runs anywhere.
- **E2** The framework opens no connection. Speech-to-text and the navigator's model are reached only through
  transports the app supplies.
- **E3** Every action is reachable by touch. Voice is never the only way.
- **E4** The navigator's model sits behind one interface with an offline stand-in. Tests and demos call no outside
  service.
- **E5** A target the user chose is found again by id when the action runs. One that left is reported, never guessed.
- **E6** A target marked private never leaves the device.
- **E7** What a screen starts ends with it.
- **E8** An API is added only with an app that uses it, in the same slice.

## Code rules

- **C1** No comments, except tool directives and one-line notes of external facts the code cannot express.
- **C2** Delete, never bypass: a replaced path goes in the same change, with its tests and docs.
- **C3** A bug fix comes with a test that fails on the old code.

## Process

Write each test first and see it fail. `npm run check` before every commit. The repository is public: no secrets, and
nothing about the apps that use it beyond what their own READMEs say.
