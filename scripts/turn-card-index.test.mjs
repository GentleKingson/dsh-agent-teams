/**
 * Turn-tail team cards read only their own turn (long-session performance).
 *
 * `TeamTurnCard` is mounted once per loaded turn. It used to filter every
 * loaded Chat node, so a long session paid (mounted turns × loaded nodes) per
 * render pass. It now reads the host Location index for its own turn. These
 * tests run the installed host's real Conversation assembler and Chat snapshot
 * builder (see fixtures/dsh-chat-host.mjs) and the built browser bundle.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { chatSnapshot, createAssembler, loadPluginSlots, renderStatic, sessionLog } from './fixtures/dsh-chat-host.mjs'
import { teamCardsForTurn } from '../lib/client/agent-teams-card-definition.js'

const LONG_NAME = '跨区域研发效能平台数据治理跨区域研发效能平台数据治理跨区域研发效能平台数据治理专项验证小组'
const TEAMS = new Map([[2, ['数据团队']], [4, ['Alpha <&> "β"', 'Beta']], [5, ['Bad', LONG_NAME]]])
const FAILED = new Set(['Bad'])

/** The removed implementation, kept as the oracle: every loaded node, any order. */
const legacyCards = (snapshot, turn) => [...snapshot.nodes.values()].filter(node => node.kind === 'agent-teams'
  && (node.location.kind === 'turn' || node.location.kind === 'step') && node.location.turn.turn === turn)
const byAnchor = nodes => [...nodes].sort((a, b) => a.anchorSeq - b.anchorSeq)

/** Count the node reads one lookup performs. */
function counted(snapshot) {
  const reader = { visits: 0 }
  reader.nodes = { get: key => { reader.visits++; return snapshot.nodes.get(key) } }
  reader.locations = snapshot.locations
  return reader
}

test('cards match the full-scan oracle on a real host snapshot, in creation order', () => {
  const snapshot = chatSnapshot(createAssembler(), sessionLog(6, { teams: TEAMS, failed: FAILED, toolsPerTurn: 2 }))
  for (let turn = 1; turn <= 6; turn++) {
    const cards = teamCardsForTurn(snapshot, turn)
    assert.deepEqual(cards, byAnchor(legacyCards(snapshot, turn)), `turn ${turn}`)
  }
  assert.deepEqual(teamCardsForTurn(snapshot, 1), [])
  assert.deepEqual(teamCardsForTurn(snapshot, 3), [])
  assert.deepEqual(teamCardsForTurn(snapshot, 99), [])
  assert.deepEqual(teamCardsForTurn(snapshot, 4).map(node => node.data.teamName), ['Alpha <&> "β"', 'Beta'])
  // The failed create never becomes a card; its sibling in the same turn does.
  assert.deepEqual(teamCardsForTurn(snapshot, 5).map(node => node.data.teamName), [LONG_NAME])
  const [card] = teamCardsForTurn(snapshot, 2)
  assert.equal(card.key, legacyCards(snapshot, 2)[0].key)
  assert.deepEqual(card.data, {
    teamId: '数据团队', captainSessionId: 'session-captain', teamName: '数据团队',
    members: [{ id: '', name: '数据团队-a', role: 'engineer' }, { id: '', name: '数据团队-b', role: 'reviewer' }],
  })
})

test('a session without AgentTeams yields no cards', () => {
  const snapshot = chatSnapshot(createAssembler(), sessionLog(30))
  for (let turn = 1; turn <= 30; turn++) assert.deepEqual(teamCardsForTurn(snapshot, turn), [])
})

test('live appends, history pages and a reopened session keep the same cards', () => {
  const log = sessionLog(8, { teams: new Map([[3, ['Early']], [7, ['Late']]]) })
  const split = log.findIndex(entry => entry.event.type === 'turn/start' && entry.event.data.turn === 5)
  const assembler = createAssembler()
  const recent = chatSnapshot(assembler, log.slice(split), true)
  assert.deepEqual(teamCardsForTurn(recent, 3), [])
  assert.equal(teamCardsForTurn(recent, 7).length, 1)
  // Load earlier history: the readers are live, so the same objects now see turn 3.
  assembler.prepend(log.slice(0, split), false)
  assembler.flush()
  const full = assembler.get('chat')
  assert.equal(full.nodes, recent.nodes)
  assert.equal(full.locations, recent.locations)
  assert.deepEqual(teamCardsForTurn(full, 3).map(node => node.data.teamName), ['Early'])
  // A new turn streamed in: the card appears once its create result lands.
  const extra = sessionLog(9, { teams: new Map([[9, ['Live']]]) }).filter(entry => entry.event.data.turn === 9)
  let seq = log.at(-1).event.seq
  for (const entry of extra) {
    assembler.append({ ...entry, event: { ...entry.event, seq: ++seq } })
    assembler.flush()
    const created = entry.event.type === 'tool/result' && entry.event.data.message.source.callId.startsWith('team_')
    if (created) assert.deepEqual(teamCardsForTurn(assembler.get('chat'), 9).map(node => node.data.teamName), ['Live'])
  }
  // Reopening the same log from scratch yields identical cards.
  const reopened = chatSnapshot(createAssembler(), log)
  // Separate builders own separate node objects; compare what the card renders.
  const shown = (chat, turn) => teamCardsForTurn(chat, turn).map(({ key, anchorSeq, data }) => ({ key, anchorSeq, data }))
  for (const turn of [3, 7]) assert.deepEqual(shown(reopened, turn), shown(full, turn))
})

test('lookup cost depends on the turn, not on the rest of the loaded session', () => {
  const visits = (turns, turn) => {
    const snapshot = chatSnapshot(createAssembler(), sessionLog(turns, { teams: new Map([[turn, ['Probe']]]) }))
    const reader = counted(snapshot)
    assert.equal(teamCardsForTurn(reader, turn).length, 1)
    return { visits: reader.visits, turnNodes: snapshot.locations.getTurn(turn).length, loaded: snapshot.nodes.values().length }
  }
  const short = visits(20, 10), long = visits(300, 10)
  assert.equal(short.visits, short.turnNodes)
  assert.equal(long.visits, short.visits, 'same turn shape, 15x the session: same reads')
  // The removed scan read every loaded node for every mounted turn tail.
  assert.ok(long.loaded >= 15 * short.loaded * 0.9, `${long.loaded} loaded nodes vs ${short.loaded}`)
})

test('the built turn tail renders its own cards and keeps stable Chat selections', () => {
  const { spec, component: TeamTurnCard } = loadPluginSlots().get('conversation.chat.turnTail')
  const assembler = createAssembler()
  const log = sessionLog(4, { teams: new Map([[2, ['数据团队']]]) })
  let snapshot = chatSnapshot(assembler, log)
  const selections = []
  const props = turn => ({
    sessionId: 'session-captain', t: key => key, ...spec.inject(),
    turn: snapshot.nodes.get(snapshot.locations.getTurn(turn).at(-1)).location.turn,
    useChat: select => { const value = select(snapshot); selections.push(value); return value },
  })
  const html = renderStatic(TeamTurnCard, props(2))
  assert.match(html, /data-team-turn-cards/)
  assert.match(html, /数据团队-a/)
  assert.equal(renderStatic(TeamTurnCard, props(1)), '')
  assert.equal(renderStatic(TeamTurnCard, { ...props(2), turn: { ...props(2).turn, status: 'open' } }), '')
  // A later publication must not change what the card selected, or every
  // mounted turn tail would re-render on each streaming frame.
  const first = selections.splice(0)
  assembler.append({ type: 'event', event: { type: 'turn/start', seq: log.at(-1).event.seq + 1, time: 1, data: { turn: 5 } } })
  assembler.flush()
  const next = assembler.get('chat')
  assert.notEqual(next, snapshot)
  snapshot = next
  renderStatic(TeamTurnCard, props(2))
  assert.equal(selections.length, 2)
  assert.deepEqual(selections.map((value, index) => Object.is(value, first[index])), [true, true])
})
