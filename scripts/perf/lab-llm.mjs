/** Deterministic model for the long-session performance lab. Only the LLM is a fixture. */
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm';
let seq = 0;
const model = { provider: 'perf-lab', id: 'fixture-model', name: 'Perf fixture', context: { contextWindow: 10_000_000 }, defaultMaxTokens: 8192, reasoning: { efforts: [{ id: 'low', name: 'low' }], defaultEffort: 'low' } };
const usage = { type: 'usage', usage: { inputTokens: 10, outputTokens: 30 } };
const answer = turn => `### Turn ${turn}\n\nChecked the file and summarised it.\n\n- item one for turn ${turn}\n- item two with \`code\` and **bold**\n\n\`\`\`ts\nconst value${turn} = ${turn} * 2\n\`\`\`\n`;
function text(value) { return [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text: value }, { type: 'block-end', index: 0, block: { type: 'text', text: value } }, usage, { type: 'finish', reason: { kind: 'stop' } }]; }
function calls(list) {
    const out = [];
    list.forEach(([name, args], index) => {
        const id = ToolCallId('perf-' + (++seq)), json = JSON.stringify(args);
        out.push({ type: 'block-start', index, blockType: 'tool-call' }, { type: 'tool-call-delta', index, id, name, argumentsDelta: json }, { type: 'block-end', index, block: { type: 'tool-call', id, name, arguments: json } });
    });
    return [...out, usage, { type: 'finish', reason: { kind: 'tool-calls' } }];
}
class PerfAdapter extends LlmAdapter {
    async listModels() { return [model]; }
    async resolveModel(provider, id) { return { ...model, provider, id }; }
    async *stream(options) {
        if (options.purpose) { yield* text('Perf lab'); return; }
        const lastUser = options.messages.findLastIndex(m => m.role === 'user' && m.source?.kind === 'user');
        const prompt = options.messages[lastUser].content.filter(b => b.type === 'text').map(b => b.text).join('\n');
        const turnCalls = options.messages.slice(lastUser + 1).flatMap(m => m.content ?? []).filter(b => b.type === 'tool-call');
        const turn = Number(/TURN (\d+)/.exec(prompt)?.[1] ?? 0);
        const teams = /TEAMS ([^\n]+)/.exec(prompt)?.[1].split('|') ?? [];
        if (turnCalls.length === 0) {
            yield* calls([['read', { path: 'notes.md' }], ...teams.map(name => ['agent_teams_create', { name, description: 'perf lab', approval: 'required' }])]);
            return;
        }
        yield* text(answer(turn));
    }
}
export const name = 'perf-lab-llm';
export const inject = ['llm'];
export function apply(ctx) { ctx.llm.registerAdapter(['perf-lab'], new PerfAdapter()); }
