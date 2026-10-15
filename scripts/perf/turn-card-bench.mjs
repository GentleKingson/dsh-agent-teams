/**
 * Node-level A/B/C benchmark of the turn-tail card lookup on the installed
 * host's real Chat snapshot (fixtures/dsh-chat-host.mjs).
 *   A - native host: no plugin definition, no turn-tail work.
 *   B - baseline: every mounted tail filters every loaded node (removed code).
 *   C - candidate: every mounted tail reads its own turn's Location index.
 * One "pass" renders every mounted tail once, as a history page or a reopen does.
 * Usage: node scripts/perf/turn-card-bench.mjs [runs=30] [out.json]
 * Not part of `verify`; timings are Node wall clock, not Desktop measurements.
 */
import { writeFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { chatSnapshot, createAssembler, sessionLog } from '../fixtures/dsh-chat-host.mjs'
import { teamCardsForTurn } from '../../lib/client/agent-teams-card-definition.js'

const runs = Number(process.argv[2] ?? 30)
const out = process.argv[3]
const INITIAL_TAILS = 17 // turns in the host's first history page for these sessions (lab measurement)

const legacy = (nodes, turn) => [...nodes.values()].filter(node => node.kind === 'agent-teams'
  && (node.location.kind === 'turn' || node.location.kind === 'step') && node.location.turn.turn === turn)

function counting(snapshot) {
  const reader = { visits: 0 }
  reader.nodes = {
    get: key => { reader.visits++; return snapshot.nodes.get(key) },
    values: () => { const all = snapshot.nodes.values(); reader.visits += all.length; return all },
  }
  reader.locations = snapshot.locations
  return reader
}

const pass = { B: (chat, turn) => legacy(chat.nodes, turn), C: (chat, turn) => teamCardsForTurn(chat, turn) }
const pct = (list, p) => { const s = [...list].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)] }
const summary = list => ({ p50: +pct(list, 0.5).toFixed(4), p95: +pct(list, 0.95).toFixed(4), n: list.length })

const results = []
for (const turns of [20, 100, 300]) {
  const teams = new Map([[Math.min(10, turns), ['数据团队']], [Math.min(150, turns), ['Review Team B', 'Review Team C']]])
  const build = withPlugin => chatSnapshot(createAssembler({ withPlugin }), sessionLog(turns, { teams, toolsPerTurn: 2 }))
  const native = build(false), plugin = build(true)
  for (const [scope, from] of [['initial-window', Math.max(1, turns - INITIAL_TAILS + 1)], ['fully-paginated', 1]]) {
    const mounted = turns - from + 1
    const row = { turns, scope, mountedTails: mounted, loadedNodes: { A: native.nodes.values().length, BC: plugin.nodes.values().length } }
    for (const variant of ['B', 'C']) {
      const reader = counting(plugin)
      let cards = 0
      for (let turn = from; turn <= turns; turn++) cards += pass[variant](reader, turn).length
      const times = []
      for (let i = 0; i < runs + 3; i++) {
        const t0 = performance.now()
        for (let turn = from; turn <= turns; turn++) pass[variant](plugin, turn)
        if (i >= 3) times.push(performance.now() - t0)
      }
      row[variant] = { nodeVisitsPerPass: reader.visits, cards, passMs: summary(times) }
    }
    results.push(row)
    console.log(JSON.stringify(row))
  }
}
if (out) writeFileSync(out, JSON.stringify({ node: process.version, runs, results }, null, 2) + '\n')
