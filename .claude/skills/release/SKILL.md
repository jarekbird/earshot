---
name: release
description: How the maintainer releases a version of Earshot to the apps that use it - a tag on main that an app pins. Use after a pull request merges, or to see what a version holds. An outside contributor tags nothing.
---

# Release

The maintainer's process. An outside contribution follows `CONTRIBUTING.md` and runs none of this.

A version is a tag `v<version>` on `main`. Apps pin one (`"earshot": "github:jarekbird/earshot#v0.0.31"`); nothing
goes to npm, and `dist` is built when the app installs (`prepare`).

1. **In the pull request.** A change to what an app installs raises `version` in `package.json` by one patch, with
   `npm install --package-lock-only` for the lock file: `src`, `check`, `sim`, `relay`, a runtime dependency, the
   package's `exports` or `bin`, or the build configuration. The README's two lines that name a version and `example/package.json` name the same one, and tests
   hold them there. Docs, skills, tests and CI raise nothing, and a merge that raised nothing ends here: no tag,
   no new pin.
2. **After the merge.** When the merge raised the version, wait for every job of the workflow `check` to pass on the merge commit on
   `main`, then tag that commit and push the tag: `git tag v<version> <sha> && git push origin v<version>`. A red
   `main` gets no tag. Never move or reuse a tag: a mistake is fixed by the next version.
3. **In the app.** The app raises its pin to the new tag in a pull request of its own, with its own checks and review.

What shipped: `git tag --list 'v*' --sort=-v:refname | head`, and `git log v<a>..v<b> --oneline` for what a version
holds.

Not part of a release, and only on Jarek's word: uploading the example app to the Even Hub, and deploying the
example relay.
