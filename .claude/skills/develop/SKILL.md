---
name: develop
description: The development process for Earshot, from a decided change to a tagged version an app can pin. Use for every feature and fix.
---

# Develop

1. **Decided.** Build what Jarek has decided: a slice of `docs/design.md`, or what an app on Earshot needs. A rule
   in CLAUDE.md changes only with his OK.
2. **Design.**
   - Name the data shape and the public API first. An API comes with an app that uses it, in the same change (E8);
     the example app in `example/` counts.
   - Ask whether it works for any app, not only the one that needs it: write how two unlike apps would use it.
     What only one app needs stays in that app. The app-agnostic reviewer asks the same (skill `review-loop`).
   - A change to what the framework does updates `docs/design.md` and the README in the same change.
   - For a flow (a hold, a command, a draw), write its states and transitions first.
3. **Build.** Work on a branch in your own worktree, never on `main`. Write each test first and see it fail. Run
   `npm run check` before each commit. A test reaches only this machine (E4). On your machine a guard
   refuses the usual ways out, in the simulator's page too; CI runs every test with no network but its own, which
   closes the rest.
4. **Self-verify.** For a change to what the glasses draw, to input, to the microphone or to the example app, run the
   simulator tests it reaches: `npx vitest run --config vitest.sim.config.ts -t "<test name>"` (Linux, with `Xvfb`).
   The whole simulator suite is CI's job `sim`, never a local run. `Simulator.screenshot('glasses')` in a test gives
   the picture; the simulator is not the glasses, so say what only the device can show.
5. **Review.** Use skill `review-loop`.
6. **Pull request.** Rebase onto `origin/main`, run `npm run check`, push the branch and open a pull request into
   `main`. The body follows `.github/pull_request_template.md`; every section is required. It merges only with
   `check` and `sim` green on the pull request, with every focus of the review approved, and on Jarek's word: no
   agent merges on its own. Remove the worktree once it merges.
7. **Release.** Use skill `release`.

The repository is public. Briefs, logs and screenshots that name a machine, a path or an app stay out of it.
