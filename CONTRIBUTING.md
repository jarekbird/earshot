# Contributing to Earshot

Earshot is early, and its API will change until two apps run on it. The most useful things from outside right now are
an app built on it and a report of what got in the way.

## A report

Open an issue. Say what you did, what you expected and what happened, with the version you pinned. For something the
glasses drew or heard wrong, a short test with `fakeBridge` from `earshot/testing` that shows it is the best report
there is.

## A change

Ask first, in an issue, before anything that adds to the API or changes what an app sees. The framework is kept small
on purpose: an API is added only with an app that uses it (rule E8), and what only one app needs stays in that app.

1. Use the Node version `package.json` asks for. Run `npm ci`, then `npm ci --prefix workerd` for the tests of the
   relay's Worker host.
2. Write the test first and see it fail. A bug fix comes with a test that fails on the old code (C3). CI tries it:
   the job `c3` runs the tests your pull request changed on the source as it was, and expects one to fail. A change
   with no new behaviour, a tidying say, gets the label `no new behaviour` from the maintainer.
3. Run `npm run check` before every commit. It checks the formatting, type-checks, runs the tests and builds;
   `npm run format` fixes the formatting. No test may call an outside service (E4), and a guard refuses one that tries.
4. Open a pull request into `main`. In the template, fill in **What changed**, **Checks** and **Not verified**, and
   leave **App-agnostic** and **Review** to the maintainer. CI runs `check` and the simulator suite (`sim`) on it.

The rules are in [CLAUDE.md](CLAUDE.md), each with an id that its check cites. Two of them surprise people: the code
has no comments, except tool directives and one-line notes of outside facts (C1), and a replaced path is deleted in
the same change, never left beside the new one (C2).

## What the maintainer does

Every change is reviewed by a panel before it merges, and it merges only on the maintainer's word. A version is a tag
on `main`. That process is written down under Process in `CLAUDE.md` and in `.claude/skills`. It is the maintainer's
own, and nothing in it is yours to run.

## If you work with a coding agent

An agent that opens this repository reads `CLAUDE.md` (or `AGENTS.md`, the same file) and `.claude/skills`. The rules
there bind your change too. The process does not: your agent follows this page, starts no review panel, opens no pull
request for a new rule and tags nothing.

## Licence

Earshot is MIT licensed. What you contribute is under the same licence.
