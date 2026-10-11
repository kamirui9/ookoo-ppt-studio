#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
if [ -f data/server.pid ]; then
  studio_pid=$(cat data/server.pid)
  studio_command=$(ps -p "$studio_pid" -o command= || true)
  case "$studio_command" in
    *"$PWD/dist/server.js"*|*"node dist/server.js"*) kill "$studio_pid" ;;
  esac
  rm -f data/server.pid
fi
