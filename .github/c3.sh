#!/bin/sh
set -eu
old=$(git merge-base "$1" HEAD)
ours='src check sim relay'
changed=$(git diff --name-only "$old" HEAD -- $ours ':!*.test.ts')
if [ -z "$changed" ]; then
  echo 'C3: no source changed, so there is nothing to show.'
  exit 0
fi
tests=$(git diff --name-only --diff-filter=AMR "$old" HEAD -- '*.test.ts' ':!*.sim.test.ts')
if [ -z "$tests" ]; then
  echo '::error::C3: the source changed and no test did. Add the test that fails on the old source, or, for a change with no new behaviour, ask for the label "no new behaviour".'
  exit 1
fi
git diff --name-only --diff-filter=A "$old" HEAD -- $ours ':!*.test.ts' | while read -r added; do rm -f -- "$added"; done
git ls-tree -r --name-only "$old" -- $ours | grep -v '\.test\.ts$' | xargs git checkout -q "$old" --
if npx tsc --noEmit && npx vitest run $tests; then
  echo '::error::C3: the changed tests pass on the old source too, so none of them shows the change. Write the test that fails without it, or, for a change with no new behaviour, ask for the label "no new behaviour".'
  exit 1
fi
echo 'C3: on the old source the changed tests fail, or do not compile. They show the change.'
