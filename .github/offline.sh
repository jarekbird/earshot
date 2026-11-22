#!/bin/sh
set -eu
exec sudo -E unshare --net -- sh -c 'ip link set lo up && user=$1 path=$2 && shift 2 && exec runuser -u "$user" -- env "PATH=$path" EARSHOT_OFFLINE=1 "$@"' sh "$(id -un)" "$PATH" "$@"
