/**
 * Loads the installed DSH Chat pipeline in Node: the real
 * `dsh-client-ui-conversation` assembler and the real `dsh-client-ui-chat`
 * node definitions and Chat snapshot builder, fed with synthetic durable
 * session events. Used by the turn-card regression and the long-session
 * benchmark so both measure the host's own Chat snapshot, not a mock.
 *
 * The host ships its browser bundles as `window.__ModuleLoader__` factories;
 * this file evaluates them with a minimal loader and only reads their public
 * exports (`ConversationNodeAssembler`) and their public registration path
 * (`apply(ctx)` → `uiConversation.events/views/groups.register`).
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { agentTeamsCardDefinition } from '../../lib/client/agent-teams-card-definition.js'

const require = createRequire(import.meta.url)
const bundles = new Map()

/** Resolve a host package's browser entry: `./client` when exported, else the root. */
function resolveBrowserEntry(from, id) {
  try { return from.resolve(`${id}/client`) } catch { return from.resolve(id) }
}

/** Presentational component kits that the data path never calls; stubbed so no DOM/CSS deps load. */
const UI_ONLY = new Set(['@deepseek-ai/dsh-client-ui-primitives'])
const uiStub = new Proxy(function () {}, { get: (_t, key) => key === '__esModule' ? false : key === 'then' ? undefined : uiStub, apply: () => uiStub })

/**
 * `dsh-client-store` ships its engine with zustand/immer as dev-only deps, so
 * it cannot load here. The Chat pipeline uses three helpers; this stand-in
 * keeps `notifySubscribers` identical and gives the snapshot stores the
 * engine's default synchronous flush. None of them is on the scanned path.
 */
function notifySubscribers(listeners, label, ...args) {
  for (const listener of [...listeners]) {
    try { listener(...args) } catch (error) { console.error(`${label} subscriber failed:`, error) }
  }
}
function createSnapshotStore(init) {
  let state = init
  const listeners = new Set()
  return {
    getSnapshot: () => state,
    subscribe: fn => { listeners.add(fn); return () => { listeners.delete(fn) } },
    update: mutator => { const draft = structuredClone(state); mutator(draft); state = draft; notifySubscribers(listeners, '[client-store]') },
    set: next => { state = next; notifySubscribers(listeners, '[client-store]') },
  }
}
const clientStore = {
  notifySubscribers,
  createSnapshotStore,
  defineStore: decl => ({ spec: decl, create: () => {
    const store = createSnapshotStore(decl.init())
    const actions = Object.fromEntries(Object.entries(decl.actions).map(([key, mutate]) => [key, (...params) => store.update(d => mutate(d, ...params))]))
    return { actions, getSnapshot: store.getSnapshot, subscribe: store.subscribe, store, clearPersisted: () => {} }
  } }),
}
bundles.set('@deepseek-ai/dsh-client-store', clientStore)

function loadBundle(id, from = require) {
  if (bundles.has(id)) return bundles.get(id)
  if (UI_ONLY.has(id)) return uiStub
  const file = resolveBrowserEntry(from, id)
  const text = readFileSync(file, 'utf8')
  if (!text.includes('__ModuleLoader__')) {
    const plain = from(id)
    bundles.set(id, plain)
    return plain
  }
  const local = createRequire(file)
  const hostRequire = dep => dep.startsWith('@deepseek-ai/') ? loadBundle(dep, local) : local(dep)
  let exported
  const loader = { load: ({ factory }) => { exported = factory(hostRequire) } }
  // The bundle only touches `window.__ModuleLoader__` and, lazily, the DOM.
  new Function('window', text)({ __ModuleLoader__: loader })
  bundles.set(id, exported)
  return exported
}

/** No-op context whose `uiConversation` registries record what ui-chat registers. */
function captureContext() {
  const events = [], views = [], groups = []
  const noop = new Proxy(function () {}, {
    get: (_target, key) => key === Symbol.toPrimitive ? () => '' : key === 'then' ? undefined : noop,
    apply: () => noop,
  })
  const registry = list => ({ register: d => { list.push(d); return () => {} }, registerFallback: () => () => {} })
  const ctx = new Proxy({}, {
    get: (_target, key) => key === 'uiConversation'
      ? new Proxy({ events: registry(events), views: registry(views), groups: registry(groups) }, { get: (t, k) => t[k] ?? noop })
      : noop,
  })
  return { ctx, events, views, groups }
}

let cached
/** @returns the host Chat definitions plus the plugin card definition. */
export function loadChatHost() {
  if (cached) return cached
  const conversation = loadBundle('@deepseek-ai/dsh-client-ui-conversation')
  const chat = loadBundle('@deepseek-ai/dsh-client-ui-chat')
  const captured = captureContext()
  try { chat.apply(captured.ctx) } catch { /* only the registrations made before UI wiring are needed */ }
  const chatView = captured.views.find(view => view.target === 'chat')
  if (chatView === undefined) throw new Error('ui-chat did not register its chat view')
  cached = { conversation, chat, events: captured.events, chatView, groups: captured.groups }
  return cached
}

/**
 * Build one assembler over the real host node definitions and the plugin card.
 * @param {{ withPlugin?: boolean }} options - `withPlugin: false` is the native-host control.
 */
export function createAssembler({ withPlugin = true } = {}) {
  const host = loadChatHost()
  const definitions = withPlugin ? [...host.events, agentTeamsCardDefinition] : [...host.events]
  const assembler = new host.conversation.ConversationNodeAssembler(
    { entries: () => definitions, fallbackEntry: () => undefined },
    { entries: () => [host.chatView] },
    { entries: () => host.groups, forTarget: target => host.groups.find(group => group.target === target) },
  )
  assembler.activateTarget('chat')
  return assembler
}

const TIME = 1_700_000_000_000
/**
 * Synthetic durable log: every turn is user prompt → assistant tool call →
 * tool result → assistant answer. `teams` maps a turn to the team names whose
 * `agent_teams_create` calls that turn makes; `failed` marks failing creates.
 * @param {number} turns
 * @param {{ teams?: Map<number, string[]>, failed?: Set<string>, toolsPerTurn?: number }} [options]
 */
export function sessionLog(turns, { teams = new Map(), failed = new Set(), toolsPerTurn = 1 } = {}) {
  const out = []
  let seq = 0
  const surface = new Set(['user/message', 'assistant/message', 'tool/result'])
  const push = (type, data) => out.push({ type: 'event', event: {
    type, seq: seq++, time: TIME + seq, data, ...(surface.has(type) ? { surfaceOp: 'append' } : {}),
  } })
  const source = { kind: 'model', provider: 'fixture', model: 'fixture' }
  for (let turn = 1; turn <= turns; turn++) {
    push('turn/start', { turn })
    push('step/start', { turn, step: 1 })
    push('user/message', { id: `u${turn}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `prompt ${turn}` }] })
    const calls = []
    for (let i = 0; i < toolsPerTurn; i++) calls.push({ callId: `read_${turn}_${i}`, name: 'read', arguments: JSON.stringify({ path: `f${i}.ts` }) })
    for (const [i, name] of (teams.get(turn) ?? []).entries()) {
      calls.push({ callId: `team_${turn}_${i}`, name: 'agent_teams_create', arguments: JSON.stringify({ name }), team: name })
    }
    push('assistant/message', {
      turn, step: 1, stream: [],
      message: { id: `a${turn}_1`, role: 'assistant', source, content: [
        { type: 'text', text: `working on ${turn}` },
        ...calls.map(call => ({ type: 'tool-call', id: call.callId, name: call.name, arguments: call.arguments })),
      ] },
    })
    for (const call of calls) push('tool/call', { turn, step: 1, callId: call.callId, name: call.name, arguments: call.arguments })
    for (const call of calls) {
      const isError = call.team !== undefined && failed.has(call.team)
      const text = call.team === undefined ? 'file contents'
        : isError ? `team "${call.team}" is taken` : `Team "${call.team}" created (id ${call.team}) under .agent-teams/${call.team}. You are the captain.`
      const meta = call.team === undefined || isError ? undefined : {
        team_id: call.team, team_name: call.team, captain_session_id: 'session-captain',
        members: [{ id: '', name: `${call.team}-a`, role: 'engineer' }, { id: '', name: `${call.team}-b`, role: 'reviewer' }],
      }
      push('tool/result', {
        turn, step: 1,
        message: { id: `r_${call.callId}`, role: 'tool', source: { kind: 'tool', callId: call.callId }, toolCallId: call.callId, isError, content: [{ type: 'text', text }] },
        ...(meta === undefined ? {} : { meta }),
      })
    }
    push('step/end', { turn, step: 1 })
    push('step/start', { turn, step: 2 })
    push('assistant/message', { turn, step: 2, stream: [], message: { id: `a${turn}_2`, role: 'assistant', source, content: [{ type: 'text', text: `answer ${turn}` }] } })
    push('step/end', { turn, step: 2 })
    push('turn/end', { turn, reason: { kind: 'success' } })
  }
  return out
}

/** @returns the published Chat snapshot after replacing the window with `entries`. */
export function chatSnapshot(assembler, entries, hasMore = false) {
  assembler.replaceWindow(entries, hasMore)
  assembler.flush()
  return assembler.get('chat')
}

/**
 * Evaluate a built plugin browser bundle (default: this repo's `lib/client.js`)
 * and run its `apply(ctx)` against a recording context, returning every slot
 * component it registers keyed by slot name.
 * @param {string} [file] - absolute path of the bundle.
 */
export function loadPluginSlots(file = new URL('../../lib/client.js', import.meta.url).pathname) {
  loadChatHost()
  const text = readFileSync(file, 'utf8')
  const local = createRequire(file)
  // Static rendering has no server snapshot; reuse the client one (fixture-only).
  const react = require('react')
  const ssrReact = { ...react, useSyncExternalStore: (subscribe, get, server) => react.useSyncExternalStore(subscribe, get, server ?? get) }
  const pluginRequire = dep => dep === 'react' ? ssrReact : dep.startsWith('@deepseek-ai/') ? loadBundle(dep, require) : local(dep)
  let plugin
  new Function('window', text)({ __ModuleLoader__: { load: ({ factory }) => { plugin = factory(pluginRequire) } } })
  const slots = new Map()
  const noop = new Proxy(function () {}, {
    get: (_t, key) => key === Symbol.toPrimitive ? () => '' : key === 'then' ? undefined : noop,
    apply: () => noop,
  })
  const ctx = new Proxy({}, {
    get: (_t, key) => {
      if (key === 'inject') return (_deps, callback) => callback(ctx)
      if (key === 'get') return () => undefined
      if (key === 'slots') return {
        inject: (_name, register) => register(),
        register: (spec, component) => { slots.set(spec.name, { spec, component }); return () => {} },
      }
      return noop
    },
  })
  plugin.apply(ctx)
  return slots
}

/** Render one slot component with the repo's React (the instance the bundles were given). */
export function renderStatic(component, props) {
  const { createElement } = require('react')
  const { renderToStaticMarkup } = require('react-dom/server')
  return renderToStaticMarkup(createElement(component, props))
}
