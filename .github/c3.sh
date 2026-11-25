#!/bin/sh
set -eu
old=$(git merge-base "$1" HEAD)
lists=$(mktemp -d)
trap 'rm -rf "$lists"' EXIT
of() {
  filter=$1
  shift
  git diff -z --no-renames --name-only --diff-filter="$filter" "$old" HEAD -- "$@"
}
of AMD src check sim relay ':!*.test.ts' > "$lists/changed"
if [ ! -s "$lists/changed" ]; then
  echo 'C3: no source changed, so there is nothing to show.'
  exit 0
fi
of AM '*.test.ts' ':!*.sim.test.ts' > "$lists/tests"
if [ ! -s "$lists/tests" ]; then
  echo '::error::C3: the source changed and no test did. Add the test that fails on the old source, or, for a change with no new behaviour, ask for the label "no new behaviour".'
  exit 1
fi
of A src check sim relay ':!*.test.ts' > "$lists/added"
of MD src check sim relay ':!*.test.ts' > "$lists/kept"
if [ -s "$lists/added" ]; then xargs -0 rm -f -- < "$lists/added"; fi
if [ -s "$lists/kept" ]; then xargs -0 git checkout -q "$old" -- < "$lists/kept"; fi
xargs -0 node -e 'require("node:fs").writeFileSync("tsconfig.c3.json", JSON.stringify({ extends: "./tsconfig.json", include: process.argv.slice(1) }))' < "$lists/tests"
if npx tsc -p tsconfig.c3.json && xargs -0 npx vitest run < "$lists/tests"; then
  echo '::error::C3: the changed tests pass on the old source too, so none of them shows the change. Write the test that fails without it, or, for a change with no new behaviour, ask for the label "no new behaviour".'
  exit 1
fi
echo 'C3: on the old source the changed tests fail, or do not compile. They show the change.'
