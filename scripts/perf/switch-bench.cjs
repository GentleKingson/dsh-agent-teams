/**
 * Real DSH Web session-switch benchmark (Chromium via Playwright).
 * Usage: node scripts/perf/switch-bench.cjs <lab-dir> <profile> <runs> <out.json> [cpuThrottle]
 * Needs a lab from setup-lab.sh. PLAYWRIGHT_MODULE may point at a Playwright install.
 * Nothing here is injected into the product: all probes run in the test page.
 */
const { spawn } = require('node:child_process')
const { readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? 'playwright')

const [lab, profile, runsArg, out, throttleArg] = process.argv.slice(2)
const runs = Number(runsArg ?? 10), throttle = Number(throttleArg ?? 1)
const phases = new Set((process.env.BENCH_PHASES ?? 'hot,idle,pagination,cold').split(','))
const ids = JSON.parse(readFileSync(join(lab, 'work/sessions.json'), 'utf8'))
const TURNS = { 'plain-20': 20, 'plain-100': 100, 'plain-300': 300, 'team-300': 300 }
// Park on a session whose last turn differs, so "visible" is unambiguous.
const PARK = { 'plain-20': 'plain-100', 'plain-100': 'plain-20', 'plain-300': 'plain-20', 'team-300': 'plain-20' }

function startHost(port) {
  const child = spawn(process.execPath, [join(lab, 'cli/node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', profile, '--no-open', '--port', String(port)],
    { cwd: join(lab, 'work'), env: { ...process.env, HOME: join(lab, 'user-home'), DSH_HOME: join(lab, 'home') }, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('host did not start: ' + log)), 120000)
    const onData = data => {
      log += data
      const url = /http:\/\/\S+token=\S+/.exec(log)?.[0]
      if (url) { clearTimeout(timer); resolve({ child, url }) }
    }
    child.stdout.on('data', onData); child.stderr.on('data', onData)
  })
}

/** In-page probe: long tasks and the click → selected → visible → painted timeline. */
const PROBE = () => {
  if (window.__probe) return
  const longtasks = []
  new PerformanceObserver(list => { for (const e of list.getEntries()) longtasks.push({ start: e.startTime, duration: e.duration }) }).observe({ type: 'longtask', buffered: true })
  window.__probe = {
    longtasks,
    switch(rowKey, showTail, hideTail) {
      return new Promise(resolve => {
        const row = document.querySelector(`[data-row-key="${rowKey}"]`)
        const t0 = performance.now()
        let selected
        const tick = () => {
          if (selected === undefined && row.getAttribute('aria-selected') === 'true') selected = performance.now()
          const ready = document.querySelector(`[data-turn-tail="${showTail}"]`) && !document.querySelector(`[data-turn-tail="${hideTail}"]`)
          if (!ready) return requestAnimationFrame(tick)
          const visible = performance.now()
          // The frame that paints this DOM: the next rAF runs before paint, the one after follows it.
          requestAnimationFrame(() => requestAnimationFrame(() => {
            const painted = performance.now()
            setTimeout(() => {
              const settle = painted + 1000
              const inWindow = (a, b) => longtasks.filter(t => t.start >= a && t.start < b)
              const sum = list => list.reduce((s, t) => s + t.duration, 0)
              resolve({
                selectedMs: (selected ?? visible) - t0, visibleMs: visible - t0, paintedMs: painted - t0,
                longTasks: inWindow(t0, painted).length, longTaskMs: sum(inWindow(t0, painted)),
                settleLongTasks: inWindow(t0, settle).length, settleLongTaskMs: sum(inWindow(t0, settle)),
                tails: document.querySelectorAll('[data-turn-tail]').length,
                cards: document.querySelectorAll('[data-team-turn-cards]').length,
                domNodes: document.getElementsByTagName('*').length,
              })
            }, 1000)
          }))
        }
        row.click()
        requestAnimationFrame(tick)
      })
    },
    mark() { return { at: performance.now(), tasks: longtasks.length } },
    since(mark) {
      const tasks = longtasks.slice(mark.tasks)
      return { ms: performance.now() - mark.at, longTasks: tasks.length, longTaskMs: tasks.reduce((s, t) => s + t.duration, 0), maxLongTaskMs: Math.max(0, ...tasks.map(t => t.duration)),
        tails: document.querySelectorAll('[data-turn-tail]').length, first: Number(document.querySelector('[data-turn-tail]')?.getAttribute('data-turn-tail')),
        cards: document.querySelectorAll('[data-team-turn-cards]').length, domNodes: document.getElementsByTagName('*').length, complete: !!document.querySelector('[data-turn-tail="1"]') }
    },
  }
}

async function openPage(browser, url, stateTimings) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  const page = await context.newPage()
  page.on('requestfinished', request => {
    if (!request.url().includes('/plugins/dsh-agent-teams/state')) return
    const t = request.timing()
    stateTimings.push({ at: Date.now(), ms: t.responseEnd >= 0 ? t.responseEnd - t.requestStart : null })
  })
  if (throttle > 1) {
    const cdp = await context.newCDPSession(page)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle })
  }
  await page.goto(url)
  await page.waitForSelector('[data-row-key^="workspace:"]')
  await page.evaluate(PROBE)
  const keys = Object.values(ids).map(id => `[data-row-key="session:${id}"]`)
  for (let i = 0; ; i++) {
    if ((await Promise.all(keys.map(key => page.$(key)))).every(Boolean)) break
    if (i === 100) throw new Error('session rows did not appear')
    const collapsed = await page.$('[data-row-key^="workspace:"][aria-expanded=false]')
    if (collapsed) await collapsed.click()
    await page.waitForTimeout(200)
  }
  return { context, page }
}

/** Click the host's "Load earlier" control until turn 1 is loaded (history pagination). */
async function loadAll(page) {
  const mark = await page.evaluate(() => window.__probe.mark())
  const pages = []
  for (let i = 0; i < 100; i++) {
    const before = await page.evaluate(() => window.__probe.since({ at: 0, tasks: 0 }))
    if (before.complete) break
    const button = page.getByRole('button', { name: /Load earlier|加载更早/ })
    if (!(await button.isVisible().catch(() => false))) break
    const step = await page.evaluate(() => window.__probe.mark())
    await button.click()
    await page.waitForFunction(first => Number(document.querySelector('[data-turn-tail]')?.getAttribute('data-turn-tail')) < first, before.first, { timeout: 30000 })
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))
    pages.push(await page.evaluate(m => window.__probe.since(m), step))
  }
  return { ...(await page.evaluate(m => window.__probe.since(m), mark)), pages }
}

const switchTo = (page, label, from) => page.evaluate(([key, show, hide]) => window.__probe.switch(key, show, hide),
  [`session:${ids[label]}`, TURNS[label], TURNS[from]])

;(async () => {
  const { child, url } = await startHost(7900 + Math.floor(Math.random() * 90))
  const browser = await chromium.launch()
  const stateTimings = [], result = { profile, runs, throttle, chromium: browser.version(), hot: {}, cold: {}, pagination: {}, idleState: null }
  try {
    // Hot switches: one long-lived page, every target re-visited `runs` times after one warm-up.
    const { context, page } = await openPage(browser, url, stateTimings)
    for (const label of phases.has('hot') ? Object.keys(TURNS) : []) {
      result.hot[label] = []
      await switchTo(page, PARK[label], label)
      for (let i = 0; i <= runs; i++) {
        const sample = await switchTo(page, label, PARK[label])
        if (i > 0) result.hot[label].push(sample)
        await switchTo(page, PARK[label], label)
      }
    }
    // Idle polling on a team captain session.
    if (phases.has('idle')) {
    await switchTo(page, 'team-300', 'plain-20')
    const before = stateTimings.length, t0 = Date.now()
    await page.waitForTimeout(10000)
    result.idleState = { seconds: (Date.now() - t0) / 1000, requests: stateTimings.length - before, ms: stateTimings.slice(before).map(t => t.ms) }
    }
    // History pagination to turn 1 (fresh page per run so each load starts from the initial window).
    await context.close()
    for (const label of phases.has('pagination') ? ['plain-300', 'team-300'] : []) {
      result.pagination[label] = []
      for (let i = 0; i < Math.min(runs, 5); i++) {
        const fresh = await openPage(browser, url, stateTimings)
        await switchTo(fresh.page, label, 'plain-20')
        result.pagination[label].push(await loadAll(fresh.page))
        await fresh.context.close()
      }
    }
    // Cold switches: a fresh page load each time, then the first open of the target.
    for (const label of phases.has('cold') ? Object.keys(TURNS) : []) {
      result.cold[label] = []
      for (let i = 0; i < runs; i++) {
        const fresh = await openPage(browser, url, stateTimings)
        await switchTo(fresh.page, PARK[label], label)
        result.cold[label].push(await switchTo(fresh.page, label, PARK[label]))
        await fresh.context.close()
      }
    }
    result.stateRequests = { count: stateTimings.length, ms: stateTimings.map(t => t.ms) }
  } finally {
    await browser.close()
    child.kill('SIGTERM')
  }
  writeFileSync(out, JSON.stringify(result, null, 2) + '\n')
  console.log('wrote', out)
})().catch(error => { console.error(error); process.exit(1) })
