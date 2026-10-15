#!/usr/bin/env bash
# Long-session performance lab (see docs/long-session-perf-2026-10-15/REPORT.md).
# Usage: scripts/perf/setup-lab.sh <lab-dir> <host-version> <baseline.tgz> <candidate.tgz>
# Installs one exact DSH Web host into <lab-dir>/home/profiles/web and derives
# four profiles that share its node_modules and one DSH_HOME session store:
#   gen  - headless host + candidate plugin + lab driver: writes the sessions
#   webA - native Web host, no AgentTeams
#   webB - Web host + baseline AgentTeams
#   webC - Web host + candidate AgentTeams
# Only the model is a fixture (lab-llm.mjs). Nothing outside <lab-dir> is touched.
set -euo pipefail
LAB=$(realpath -m "$1"); VERSION=$2; BASELINE=$(realpath "$3"); CANDIDATE=$(realpath "$4")
HERE=$(cd "$(dirname "$0")" && pwd)
H=$LAB/home; export HOME=$LAB/user-home DSH_HOME=$H
mkdir -p "$HOME" "$H/profiles/web" "$LAB/work"
WEB=$H/profiles/web
cat > "$WEB/package.json" <<JSON
{"name":"perf-lab-host","private":true,"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app"]}}}
JSON
printf 'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\n' > "$WEB/pnpm-workspace.yaml"
(cd "$WEB" && pnpm add "@deepseek-ai/dsh-base@$VERSION" "@deepseek-ai/dsh-web-app@$VERSION" "@deepseek-ai/dsh-headless@$VERSION" >/dev/null)
for d in "$WEB"/node_modules/@deepseek-ai/dsh*; do
  v=$(node -p "require('$d/package.json').version")
  [ "$v" = "$VERSION" ] || { echo "mixed host cohort: $d $v" >&2; exit 1; }
done
mkdir -p "$LAB/cli"; [ -f "$LAB/cli/package.json" ] || echo '{"private":true}' > "$LAB/cli/package.json"
(cd "$LAB/cli" && npm install --no-audit --no-fund "@deepseek-ai/dsh@$VERSION" >/dev/null)
for x in B C; do rm -rf "$LAB/plugin$x"; mkdir -p "$LAB/plugin$x"; done
tar xzf "$BASELINE" -C "$LAB/pluginB"; tar xzf "$CANDIDATE" -C "$LAB/pluginC"

LLM='- id: llm-deepseek
  disabled: true
- id: llm-pi-ai
  disabled: true
- id: agent-default-model
  config:
    provider: perf-lab
    model: fixture-model
- insert:
    - id: perf-lab-llm
      name: ./lab-llm.mjs
'
profile() { # name plugin-dir bundles-json patch
  local P=$H/profiles/$1
  rm -rf "$P"; mkdir -p "$P/node_modules"
  for e in "$WEB"/node_modules/* "$WEB"/node_modules/.bin; do
    [ "$(basename "$e")" = "@nanmicoder" ] || ln -s "$e" "$P/node_modules/$(basename "$e")"
  done
  if [ -n "$2" ]; then mkdir -p "$P/node_modules/@nanmicoder"; ln -s "$2" "$P/node_modules/@nanmicoder/dsh-agent-teams"; fi
  printf '{"name":"%s","private":true,"type":"module","dsh":{"profile":{"bundles":%s}}}\n' "$1" "$3" > "$P/package.json"
  printf '%s' "$4" > "$P/cordis.patch.yml"; echo '[]' > "$P/cordis.yml"; printf 'packages:\n  - .\n' > "$P/pnpm-workspace.yaml"
  cp "$HERE"/lab-llm.mjs "$HERE"/lab-driver.mjs "$P/"
}
WEB_BUNDLES='["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app"'
# Pre-acknowledge the first-run Preview Notice (0.2.x) so it does not cover the UI.
NOTICE=$(grep -ho 'WELCOME_NOTICE_VERSION = "[^"]*"' "$WEB"/node_modules/@deepseek-ai/dsh-client-ui-settings-models/lib/client.js 2>/dev/null | head -1 | cut -d'"' -f2 || true)
WEB_LLM=$LLM
if [ -n "$NOTICE" ]; then WEB_LLM="$LLM- id: ui-settings-general
  name: '@deepseek-ai/dsh-client-ui-settings-general'
  config:
    welcomeNoticeVersion: '$NOTICE'
"; fi
profile gen "$LAB/pluginC/package" '["@deepseek-ai/dsh-base","@deepseek-ai/dsh-headless","@nanmicoder/dsh-agent-teams"]' "$LLM- id: headless-startup
  disabled: true
- id: headless-runner
  disabled: true
- insert:
    - id: perf-lab-driver
      name: ./lab-driver.mjs
"
profile webA "" "$WEB_BUNDLES]" "$WEB_LLM"
profile webB "$LAB/pluginB/package" "$WEB_BUNDLES,\"@nanmicoder/dsh-agent-teams\"]" "$WEB_LLM"
profile webC "$LAB/pluginC/package" "$WEB_BUNDLES,\"@nanmicoder/dsh-agent-teams\"]" "$WEB_LLM"
DSH="$LAB/cli/node_modules/@deepseek-ai/dsh/lib/bin.js"
if [ ! -f "$LAB/work/sessions.json" ]; then
  (cd "$LAB/work" && PERF_WORKSPACE=$LAB/work node "$DSH" --profile gen > "$LAB/gen.log" 2>&1)
fi
grep -q PERF_LAB_SESSIONS_OK "$LAB/gen.log" || { tail -30 "$LAB/gen.log" >&2; exit 1; }
cat "$LAB/work/sessions.json"
