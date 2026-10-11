#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
if curl -fsS --max-time 2 http://127.0.0.1:3210/health >/dev/null 2>&1; then
  echo "工作台已经启动：http://localhost:3210"
  exit 0
fi
mkdir -p data
launch_node_bin="${NODE_BIN:-node}"
"$launch_node_bin" scripts/build.js
"$launch_node_bin" -e '
const fs=require("node:fs"),path=require("node:path"),{spawn}=require("node:child_process");
const log=fs.openSync("data/server.log","a");
const child=spawn(process.execPath,[path.resolve("dist/server.js")],{cwd:process.cwd(),detached:true,stdio:["ignore",log,log]});
child.unref();fs.closeSync(log);fs.writeFileSync("data/server.pid",String(child.pid));
'
launch_attempt=0
while [ "$launch_attempt" -lt 20 ]; do
  if curl -fsS --max-time 2 http://127.0.0.1:3210/health >/dev/null 2>&1; then
    echo "工作台已启动：http://localhost:3210"
    exit 0
  fi
  launch_attempt=$((launch_attempt + 1))
  sleep 1
done
echo "启动未完成，请检查 data/server.log" >&2
exit 1
