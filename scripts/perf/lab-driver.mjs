/** Builds the lab's long sessions through the real host: real tools, persistence and AgentTeams. */
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
export const name = 'perf-lab-driver';
export const inject = ['agents', 'sessions'];
/** label → [turns, Map(turn → team names)] */
const PLAN = {
    'plain-20': [20, {}],
    'plain-100': [100, {}],
    'plain-300': [300, {}],
    'team-300': [300, { 10: ['数据团队'], 150: ['Review Team B', 'Review Team C'] }],
};
export function apply(ctx) {
    void (async () => {
        await ctx.get('loader').await();
        const ids = {};
        for (const [label, [turns, teams]] of Object.entries(PLAN)) {
            const cwd = join(process.env.PERF_WORKSPACE, label);
            mkdirSync(cwd, { recursive: true });
            writeFileSync(join(cwd, 'notes.md'), '# notes\n\n' + 'Long-session fixture line.\n'.repeat(40));
            const handle = await ctx.agents.create({ sessionId: 'session-' + randomUUID(), meta: { cwd, title: label }, agentOptions: { provider: 'perf-lab', model: 'fixture-model' } });
            const agent = handle.agent;
            await agent.whenIdle();
            for (let turn = 1; turn <= turns; turn++) {
                const names = teams[turn] ?? [];
                const text = `TURN ${turn}: please read notes.md and summarise it.` + (names.length ? `\nTEAMS ${names.join('|')}` : '');
                agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }));
                await agent.whenIdle();
            }
            await ctx.sessions.flush(agent.session);
            ids[label] = agent.id;
            process.stdout.write(`PERF_SESSION ${label} ${agent.id}\n`);
            handle.dispose();
        }
        writeFileSync(join(process.env.PERF_WORKSPACE, 'sessions.json'), JSON.stringify(ids, null, 2) + '\n');
        process.stdout.write('PERF_LAB_SESSIONS_OK\n');
        ctx.get('appExit')(0);
    })().catch(error => { process.stderr.write(String(error.stack ?? error) + '\n'); ctx.get('appExit')(1); });
}
