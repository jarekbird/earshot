---
name: review-loop
description: Review an Earshot branch with a panel of focused reviewers before it merges. Use after a branch passes npm run check, or when Jarek asks for a review.
---

# Review loop

## Panel

Each focus has its own reviewer. Add a focus by adding a row.

| Focus        | Looks for                                                                                                                                                                                                                                                  |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Architecture | Breaks of CLAUDE.md's rules, a `docs/design.md` or README that does not match the change, wrong data shape, duplication, replaced paths left behind, code the goal does not need, lifetimes, and what happens after an `await`                             |
| Security     | The developer's key and the relay, the hosts the framework connects to, private targets leaving the device, audio handling, what an error or a log could leak, anything in this public repository that names a secret, a private app or a person's machine |
| Any app      | Whether the change works for any app on Earshot and not only the one it was written for: the shape and names of the public API, changes that break an existing app, E8, README examples that match the code, behaviour in the example app                  |

## A round, per focus

1. The author runs `npm run check`, commits, and writes a brief from the template, outside the repository
   (`~/.local/state/earshot/briefs/<branch>-<focus>-r<n>.md`): the repository is public, a brief names a machine.
2. Start one fresh reviewer per focus, from the provider that did not write the code. Never give a reviewer a
   worktree of its own: it works in the author's worktree at the reviewed head. The author changes nothing there
   until every reviewer at work in it has reported.
3. The reviewer reads the diff with `git show` and `git diff`. It never edits, commits, installs, checks out,
   switches, resets, stashes or cleans. It runs no full suite, no build and no simulator suite; at most one targeted
   test proves a finding. It makes no request to a relay or to OpenRouter: each one is paid.
4. The author checks each finding, fixes blockers and shoulds with tests (rule C3), and starts that focus's next
   round with a new reviewer.

A focus is done when a round has no blockers or shoulds. A commit added after approval gets new rounds. Nothing merges
on a fix no reviewer has read. The pull request's **Review** section gives the outcome per focus, with its rounds.

## After round 5

Round 5's findings are fixed and re-reviewed like any round's. If a focus still has not approved, the author steps
back before asking for more: is the loop unlikely to end, because the same issue is argued again and again, or fixes
cause new findings of the same kind? It says what it found and asks Jarek for 5 more rounds. Until he answers, the
branch waits.

## Conflicts

A rebase or merge whose conflicts were resolved by hand gets one more round per focus, on the resolution only: the
brief names the commits resolved by hand and gives `git range-diff <old base>..<old head> <new base>..HEAD` for them.

## Rule proposals

For each finding, the reviewer decides whether it should be a repository-wide rule, and if so proposes it in its
answer. The author opens a **draft pull request** against `main` for each proposed rule, adding the rule to CLAUDE.md
and its check if one is feasible, and leaves it for Jarek to review.

## Brief template

```
# <Focus> review, round <n>: Earshot <branch>

Focus: <focus>. Report only findings in this focus.
Looks for: <the panel's row>
Repo <worktree>, branch <branch>, base main <sha>, head <sha>. Diff: git diff <base>..<head>.
Read CLAUDE.md first. What changed, and why: <a few lines, or the path of a batch brief>.

Work in that worktree at head; read it with git show and git diff. Never edit, commit, install, check out, switch,
reset, stash or clean it. No full suites, builds or simulator suite; at most one targeted test per finding.
Make no request to a relay or to OpenRouter: each one is paid.
Prove each finding with steps or one targeted test.
For each finding, decide whether it should be a repo-wide rule; if so, propose the rule (and its check if feasible).

Scope: the whole diff | conflict resolution only: <commits>, range-diff: <command>.
Author's checks at head: npm run check, <n> tests passed; simulator tests run: <names, or none>.
Earlier rounds' fixes: <one line each>.

Answer: approve or changes needed, then each finding as
F<k> [blocker|should|nit] file:line: what fails, and how to reproduce it. Rule: <proposed rule and check, or none>.
```
