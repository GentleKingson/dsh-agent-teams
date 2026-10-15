# Long-session jank, phase 1 (2026-10-15)

**Verdict: PARTIAL · PLUGIN_IMPROVED · HOST_FIX_REQUIRED**

The plugin's own long-session cost (the T02 turn-card scan) is removed and
locked down by a permanent regression test. In a real DSH Web host, session
switching and history pagination are **not measurably different** across native
DSH (A), the baseline plugin (B) and the candidate plugin (C): the visible
long-session cost is in the host. The verdict is PARTIAL rather than PASS
because one T01 scenario (switching while several subagents are running) was
not measured, and nothing here was measured in DSH Desktop (`DESKTOP_NOT_PROVEN`).

| Item | Value |
|---|---|
| Start SHA (main) | `1094b84add6f2fb19edf659367fe2fd5f7f14154` |
| PR / merge SHA | see the PR that adds this file (filled in its description) |
| Plugin | `@nanmicoder/dsh-agent-teams` 0.1.23 (no version bump) |
| DSH host in the lab | `@deepseek-ai/dsh` / `dsh-web-app` / `dsh-base` 0.2.0-rc.2, one exact cohort |
| Repo dev host (Node fixture) | `@deepseek-ai/dsh-client-ui-chat` 0.2.0-rc.2 |
| Browser / runtime | Chromium 141.0.7390.37 (Playwright, headless), Node v22.22.0, 4 vCPU Linux container |

## Bottlenecks found

| # | Location | Finding | Owner |
|---|---|---|---|
| 1 | `src/client/TeamChatEntry.tsx:20-25` + `src/client/agent-teams-card-definition.ts:255` (before: `teamCardsForTurn(nodes.values(), turn)`) | Each mounted `conversation.chat.turnTail` copied and filtered **every loaded Chat node**. A render pass cost mountedTails × loadedNodes: 631,800 node visits for a fully paginated 300-turn session. | Plugin, **fixed** |
| 2 | Host history pagination (`dsh-client-ui-chat` / conversation controller, `HISTORY_PAGE_OPTIONS = {maxMessages:500, turnWindow:{minMessages:50,minTurns:2}}`) | Loading a 300-turn session to turn 1 takes 17 pages, ~17–24 s P50, with ~10–12 s of long tasks (single tasks ≤ ~1 s) **with no plugin installed**. The time per page grows with the number of mounted turns. The last pages swing from 1 s to 16 s in all three variants. | Host |
| 3 | `src/client/activity-monitor.ts:184` (`ACTIVITY_POLL_MS = 1000`) | One `/state` request per second while a captain session has a live team; 5–6 ms P50, ≤10 ms P95. No duplicate loops (see T03). | Plugin, no change needed |

## A/B/C results — real DSH Web host (raw: `raw/web{A,B,C}-r1.json`)

Lab: `scripts/perf/setup-lab.sh` installs one exact host and four profiles that
share one session store. Sessions are written by the real headless host and a
deterministic fixture model (`scripts/perf/lab-llm.mjs`); only the model is
synthetic. `team-300` creates a team at turn 10 and attempts two more (both
rejected by the host, as in real use) at turn 150. Measurement:
`scripts/perf/switch-bench.cjs`, 10 runs per cell after one warm-up, no CPU
throttling. Initial window: 17 turn tails for every session size. Times are
click → session visible / painted (double rAF) in ms, **P50 / P95**.

### Hot switch (same page)

| Session | A visible | B visible | C visible | A paint | B paint | C paint |
|---|---|---|---|---|---|---|
| plain-20 | 154 / 177 | 170 / 213 | 160 / 182 | 179 / 196 | 193 / 228 | 180 / 205 |
| plain-100 | 158 / 230 | 145 / 196 | 159 / 185 | 190 / 257 | 169 / 214 | 190 / 212 |
| plain-300 | 141 / 192 | 144 / 184 | 164 / 223 | 168 / 214 | 165 / 204 | 178 / 247 |
| team-300 | 153 / 205 | 165 / 244 | 158 / 236 | 163 / 227 | 189 / 267 | 182 / 265 |

### Cold switch (fresh page per run)

| Session | A visible | B visible | C visible | A paint | B paint | C paint |
|---|---|---|---|---|---|---|
| plain-20 | 216 / 242 | 219 / 238 | 221 / 254 | 233 / 276 | 241 / 265 | 236 / 283 |
| plain-100 | 213 / 294 | 219 / 267 | 230 / 375 | 234 / 312 | 248 / 297 | 253 / 406 |
| plain-300 | 229 / 305 | 233 / 333 | 230 / 298 | 246 / 343 | 264 / 355 | 258 / 336 |
| team-300 | 212 / 305 | 232 / 322 | 212 / 269 | 240 / 332 | 259 / 359 | 235 / 301 |

Every switch had one long task (P50 84–152 ms in all variants). The DOM is
2,612–2,651 nodes. Loaded turns are 17 at every size; turn tails are 17; and the
card counts are 0 in all three variants, because the team-300 teams are outside
the initial window. React render time was not separately measurable without
instrumenting the host, so it is not reported.

### History pagination to turn 1 (5 fresh pages per session)

| Session | A total | B total | C total | A long-task ms | B long-task ms | C long-task ms |
|---|---|---|---|---|---|---|
| plain-300 | 18,681 / 31,625 | 24,415 / 41,938 | 19,108 / 21,535 | 10,117 | 12,101 | 11,398 |
| team-300 | 18,070 / 25,877 | 17,048 / 17,631 | 20,366 / 33,636 | 11,597 | 11,335 | 11,278 |

All runs reach turn 1, with 300 tails and ~35k DOM nodes. B and C show the team
card (cards = 1); A has none.

**Reading:** every A/B/C difference lies within the run-to-run spread of a
single variant (for example, A plain-300 P95 is 31.6 s against a P50 of 18.7 s).
Result: **NO_MEASURABLE_GAIN** at page level. The large cost is identical
without the plugin, so it is a host issue.

### Idle `/state` polling on the team captain session (10 s)

| | A | B | C |
|---|---|---|---|
| requests | 0 | 10 | 10 |
| ms P50 / P95 | — | 5.2 / 10.0 | 5.6 / 8.8 |

## Deterministic A/B/C — node visits per render pass (raw: `raw/turn-card-bench.json`)

`scripts/perf/turn-card-bench.mjs` runs the installed host's real Conversation
assembler and Chat snapshot builder (`scripts/fixtures/dsh-chat-host.mjs`). A
"pass" renders every mounted tail once. Times are Node wall clock over 30 runs,
not Desktop measurements. A (native) does no turn-tail work.

| Turns | Scope | Tails | Loaded nodes | B visits | C visits | B ms P50 / P95 | C ms P50 / P95 |
|---|---|---|---|---|---|---|---|
| 20 | initial window | 17 | 146 | 2,482 | 125 | 0.039 / 0.204 | 0.016 / 0.021 |
| 20 | fully paginated | 20 | 146 | 2,920 | 146 | 0.029 / 0.032 | 0.013 / 0.016 |
| 100 | initial window | 17 | 706 | 12,002 | 123 | 0.115 / 0.178 | 0.003 / 0.004 |
| 100 | fully paginated | 100 | 706 | 70,600 | 706 | 0.503 / 1.595 | 0.025 / 0.059 |
| 300 | initial window | 17 | 2,106 | 35,802 | 119 | 0.121 / 0.409 | 0.003 / 0.005 |
| 300 | fully paginated | 300 | 2,106 | 631,800 | 2,106 | 1.819 / 3.792 | 0.054 / 0.082 |

Visits per pass drop from O(tails × loaded nodes) to O(Σ nodes of the mounted
turns), and B and C return the same cards in every case. In absolute terms,
the baseline cost was at most ~2–4 ms per full pass against 10+ s of host long
tasks. That is why the page-level numbers do not move.

## Task status

| Task | Status | Evidence |
|---|---|---|
| T01 baseline A/B/C | **PARTIAL** | Measured: plain 20/100/300, a team session (one team in one turn, two creates in another turn), hot, cold, reopen (cold = fresh page), and pagination; 10 runs; P50/P95. **Not measured:** switching while several subagents are running, and DSH Desktop (`DESKTOP_NOT_PROVEN`). |
| T02 location index | **MERGED** (this PR) | `teamCardsForTurn` reads `locations.getTurn` + `nodes.get`. It adds no full-snapshot subscription, rebuilt Maps, caches or private API: both readers are public `ChatSnapshot` fields and keep their identity across publications. Tests: `scripts/turn-card-index.test.mjs` (in `verify:issue-203`). |
| T03 `/state` polling | **NO-GO** | 1 req/s, 5–6 ms P50. `WorkspaceActivity` mounts either `ActivityPanel` or `WorkspaceMonitor`, never both (`src/client/WorkspaceActivity.tsx:31-32`), so there is one loop per session. The retry path stops after its first tick (`:102-103`). Discovery sessions probe at 5 s and switch to 1 s only after a team is detected. There is no measured benefit to justify a change, and widening the interval is ruled out. |
| T04 session navigation | **ALREADY_RESOLVED** | `src/client/session-navigation.ts:53-70`: hosts with `workspace.openSession` open the address directly, with no `refreshSubagents` on the path. Older hosts already use `layout.beginNavigation()` and return `'cancelled'` when a newer navigation supersedes the refresh. No monkey patching is needed or present. |
| T05 gates | **PASS** | `pnpm install --frozen-lockfile`, `build`, `typecheck`, `verify:issue-203`, `verify:harness-contract`, and the full `verify` chain (see below). The PR's CI matrix is listed on the PR. |

### T02 regression coverage (`scripts/turn-card-index.test.mjs` + `scripts/client-harness-migration.test.mjs`)

These tests use the real host assembler and snapshot builder, not a mock.

- Parity with the removed full-scan oracle on every turn, in creation (anchorSeq) order.
- Multiple teams in one turn.
- A failed create next to a successful one in the same turn.
- Escaping-sensitive and very long (CJK) team names, with exact card data.
- A session with no teams yields no cards.
- History windowing with `hasMore`, then a "load earlier" `prepend` with the same live readers.
- A live turn appended event by event: the card appears when its create result lands.
- Reopen parity from a fresh builder.
- A key filed under another turn does not leak in.
- The built `lib/client.js` turn tail renders its own cards and nothing for card-less or open turns.
- Chat selections keep their identity across a new publication, so streaming does not re-render every tail.
- **Permanent complexity test:** 20 vs 300 turns with the same team turn take the same number of node reads, equal to that turn's own node count, while loaded nodes grow ≥15×.

### Verification run

Run in the container as root on `perf/turn-card-location-index`:
`pnpm install --frozen-lockfile`, `pnpm build`, `pnpm typecheck`,
`pnpm verify:issue-203`, `pnpm verify:harness-contract`: pass. `pnpm verify`:
every step passes except two tests in `scripts/quality-gates-work-order.test.mjs`
(#174 and #161, "unreadable path"). Those two expect `chmod 000` to make a file
unreadable, which is not true for root. They fail identically on unmodified
`main` (`1094b84`) as root, and all 68 quality-gate tests pass when run as an
unprivileged user. They are unrelated to this change. CI runs as a normal user.

## Changed files

**Production (net +22 lines in `src/`):**
- `src/client/agent-teams-card-definition.ts`: `ChatTurnReader` + index-based `teamCardsForTurn`.
- `src/client/TeamChatEntry.tsx`: selects the `nodes` and `locations` readers.
- `lib/**` + `lib/git-artifact-stamp.json`: regenerated build output.

**Tests and lab (not shipped behaviour, not run by default except the regression test):**
- `scripts/turn-card-index.test.mjs`, `scripts/fixtures/dsh-chat-host.mjs`
- `scripts/client-harness-migration.test.mjs`, `package.json` (`verify:issue-203`)
- `scripts/perf/{setup-lab.sh,lab-llm.mjs,lab-driver.mjs,switch-bench.cjs,turn-card-bench.mjs,summarize.cjs}`

The probes run only in the test page or in Node. No logging, sampling or telemetry is added to production code.

## Remaining DSH (host) issues

1. **History pagination is super-linear in mounted turns** (host; reproduces with no plugin). Repro:
   - `scripts/perf/setup-lab.sh <lab> 0.2.0-rc.2 <any.tgz> <any.tgz>`
   - then `BENCH_PHASES=pagination node scripts/perf/switch-bench.cjs <lab> webA 5 out.json`
   - Open `plain-300` and click "Load earlier" to turn 1.
   - Pages take ~250 ms early on and 0.5–1.1 s late. The final pages take up to 3–16 s, with long tasks up to ~1 s. The whole load totals ~18 s P50 and ~10 s of long tasks.
2. **Chain turn-tail slot on old hosts (side finding, pre-existing, report only).** On hosts ≤ 0.1.5-rc.3, `conversation.chat.turnTail` is a chain slot. The plugin registers it as a list entry without `select`, so on those hosts the turn-tail card likely does not mount. This PR does not change it and it was not measured.

## Phase-2 recommendation

- **Host:** virtualise or window the chat turn list. Today every loaded turn stays mounted (~35k DOM nodes at 300 turns), and each page re-lays-out all of them. File the pagination repro above upstream.
- **Plugin:** nothing else in the switch or pagination paths is measurable. Re-measure only if DSH Desktop numbers (Electron, real model) disagree with the Web lab.
- **Lab:** add a fixture member delay to `lab-llm.mjs` to cover "switch while subagents are running", and run the bench in DSH Desktop to clear `DESKTOP_NOT_PROVEN`.

## Independent reviews

- **DSH API compatibility** (separate review path, done before implementation):
  - `ChatSnapshot.nodes.get` and `ChatSnapshot.locations.getTurn` are public fields of `@deepseek-ai/dsh-client-ui-chat/client`.
  - On 0.2.0-rc.2 both are the builder's live store and index, and both keep their identity across publications.
- **Performance and tests** (separate review path, nothing blocking):
  - Card parity: `getTurn` indexes only visible Chat nodes. Agent-teams nodes are always `visibility: 'visible'`, and nodes placed on a step are filed under their turn, so no card can be lost.
  - Ordering: cards now follow display (anchor) order instead of store insertion order.
  - Re-renders: the selections never change identity, so this PR does not change how often turn tails re-render. A tail updates when the host re-renders it (turn close).
  - Pre-existing limitation, unchanged: if a card were added to an already closed and mounted turn, it would appear only on that tail's next render. In practice the create result always lands before `turn/end`.
  - Perf scripts: none are referenced by `src/`, `lib/`, the package `files` list or the default scripts.
  - Claims: the node-visit numbers reproduce, e.g. 300 × 2,106 = 631,800 visits before vs 2,106 after.
