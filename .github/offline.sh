#!/bin/sh
set -eu
exec sudo unshare --net -- sh -c 'ip link set lo up && user=$1 path=$2 home=$3 ci=$4 && shift 4 && exec runuser -u "$user" -- env "PATH=$path" "HOME=$home" "CI=$ci" EARSHOT_OFFLINE=1 "$@"' sh "$(id -un)" "$PATH" "$HOME" "${CI:-}" "$@"
