// Tests for OpenRouter model filtering/ranking, error classification and fallback behaviour.
const assert = require('assert');
const o = require('./openrouter');
let failures = 0;
async function t(name, fn) { try { await fn(); console.log('PASS |', name); } catch (e) { failures++; console.log('FAIL |', name, '->', e.message); } }
const NOW = Date.parse('2026-11-22T00:00:00Z');
const free = { prompt: '0', completion: '0' };
const text = { input_modalities: ['text'], output_modalities: ['text'] };
const chat = ['/api/v1/chat/completions'];
const m = (id, extra = {}) => ({ id, pricing: free, architecture: text, endpoints: chat, context_length: 131072, created: NOW / 1000 - 86400 * 30, description: '', ...extra });
const SAMPLE = { data: [
    m('google/gemma-4-31b-it:free'),
    m('nvidia/nemotron-3-ultra-550b-a55b:free'),
    m('acme/tiny-1b:free'),
    m('acme/coder-70b:free'),
    m('particle-ai/particle-1:free', { description: 'An agentic coding model for software engineering.' }),
    m('acme/great-70b-instruct-preview:free'),
    m('meta-llama/llama-5-70b-instruct:free'),
    m('meta-llama/llama-5-70b-instruct', { pricing: { prompt: '0.0000002', completion: '0.0000006' } }), // paid
    m('google/lyria-3-pro-preview', { architecture: { input_modalities: ['text'], output_modalities: ['text', 'audio'] } }), // music
    m('acme/embed-only:free', { endpoints: ['/api/v1/embeddings'] }),
    m('acme/expiring-70b:free', { expiration_date: '2026-11-22T12:00:00Z' }),
    m('acme/short-ctx-70b:free', { context_length: 4096 }),
    m('openrouter/free'),
] };

(async () => {
    const ranked = o.rankFreeModels(SAMPLE, { now: NOW });
    await t('only free text-chat models, no paid/music/embedding/expiring', () => {
        for (const bad of ['meta-llama/llama-5-70b-instruct', 'google/lyria-3-pro-preview', 'acme/embed-only:free', 'acme/expiring-70b:free', 'openrouter/free']) assert(!ranked.includes(bad), bad);
    });
    await t('strong general instruct models rank first', () => {
        assert.deepStrictEqual(ranked.slice(0, 3).sort(), ['google/gemma-4-31b-it:free', 'meta-llama/llama-5-70b-instruct:free', 'nvidia/nemotron-3-ultra-550b-a55b:free'].sort(), ranked.join(','));
    });
    await t('preview, code-only, tiny and short-context models rank below general models', () => {
        const idx = id => ranked.indexOf(id) === -1 ? 99 : ranked.indexOf(id);
        for (const low of ['acme/great-70b-instruct-preview:free', 'acme/coder-70b:free', 'particle-ai/particle-1:free', 'acme/tiny-1b:free', 'acme/short-ctx-70b:free'])
            assert(idx(low) > idx('meta-llama/llama-5-70b-instruct:free'), low);
        assert(idx('acme/coder-70b:free') > idx('acme/great-70b-instruct-preview:free'));
    });
    await t('buildModelList keeps surviving defaults first, drops retired ones, adds free router last', () => {
        const available = new Set(SAMPLE.data.map(x => x.id));
        const list = o.buildModelList({ discovered: ranked, available });
        assert.strictEqual(list[0], 'google/gemma-4-31b-it:free');
        assert(!list.includes('inclusionai/ling-3.2-flash:free'), 'retired default should be dropped');
        assert.strictEqual(list[list.length - 1], 'openrouter/free');
    });
    await t('env override wins; paid models only when opted in', () => {
        assert.deepStrictEqual(o.buildModelList({ envModels: ['a/b:free'] }), ['a/b:free']);
        assert(!o.buildModelList({ discovered: ranked }).some(id => !id.endsWith(':free') && id !== 'openrouter/free'));
        assert.strictEqual(o.buildModelList({ discovered: ranked, paid: ['x/paid'] }).slice(-1)[0], 'x/paid');
    });
    await t('discovery failure falls back to hardcoded defaults', () => {
        assert.deepStrictEqual(o.buildModelList({}).slice(0, o.DEFAULT_MODELS.length), o.DEFAULT_MODELS);
    });
    await t('classifyError', () => {
        assert.strictEqual(o.classifyError(404, { message: 'x is no longer available on OpenRouter' }).kind, 'gone');
        assert.strictEqual(o.classifyError(200, { code: 404, message: 'No endpoints found' }).kind, 'gone');
        assert.strictEqual(o.classifyError(429, { message: 'Rate limit exceeded' }).kind, 'rate_limited');
        assert.strictEqual(o.classifyError(400, { message: 'This model is unavailable for free. The paid version is available now - use this slug instead: qwen/x' }).kind, 'paid_only');
        assert.strictEqual(o.classifyError(502, { message: 'Provider returned error' }).kind, 'transient');
    });
    await t('cleanReply strips <think> and rejects thinking-only output', () => {
        assert.strictEqual(o.cleanReply('<think>hmm</think>Hello!'), 'Hello!');
        assert.strictEqual(o.cleanReply('Thinking: step 1'), '');
    });

    // Fallback chain with a fake OpenRouter
    const calls = [];
    const replies = {
        'gone/model:free': { status: 404, json: { error: { code: 404, message: 'gone/model:free is no longer available on OpenRouter' } } },
        'busy/model:free': { status: 429, json: { error: { code: 429, message: 'Rate limit exceeded' } } },
        'flaky/model:free': { status: 502, json: { error: { code: 502, message: 'Provider returned error' } } },
        'good/model:free': { status: 200, json: { choices: [{ message: { content: 'Hi there!' } }] } },
    };
    const quiet = { log: () => {}, error: () => {} };
    const mgr = o.createModelManager({ key: 'k', env: { OPENROUTER_MODELS: 'gone/model:free,busy/model:free,flaky/model:free,good/model:free' }, log: quiet,
        fetchJson: async ({ body }) => { calls.push(body.model); return replies[body.model]; } });
    await t('falls through gone/429/provider errors to a working model', async () => {
        const r = await mgr.complete([{ role: 'user', content: 'hi' }]);
        assert.strictEqual(r.reply, 'Hi there!'); assert.strictEqual(r.model, 'good/model:free');
    });
    await t('retired model is skipped for the rest of the session; 429 cools down; transient retried', async () => {
        calls.length = 0;
        await mgr.complete([{ role: 'user', content: 'hi' }]);
        assert.deepStrictEqual(calls, ['flaky/model:free', 'good/model:free']);
    });
    await t('all models failing -> AI_UNAVAILABLE (caller shows friendly message), details logged', async () => {
        const logged = [];
        const m2 = o.createModelManager({ key: 'k', env: { OPENROUTER_MODELS: 'gone/model:free,flaky/model:free' }, log: { log: () => {}, error: (...a) => logged.push(a.join(' ')) },
            fetchJson: async ({ body }) => replies[body.model] });
        await assert.rejects(m2.complete([{ role: 'user', content: 'hi' }]), e => e.message === 'AI_UNAVAILABLE');
        assert(/gone\/model:free: \[gone\]/.test(logged.join('\n')) && /flaky/.test(logged.join('\n')));
        assert(!/:free|\//.test(o.FRIENDLY_AI_ERROR), 'friendly message must not list model slugs');
    });
    await t('discovery refresh replaces list from /models payload', async () => {
        const m3 = o.createModelManager({ key: 'k', env: {}, log: quiet, fetchJson: async ({ path }) => path === '/api/v1/models' ? { status: 200, json: SAMPLE } : null });
        await m3.refresh();
        assert.strictEqual(m3.models[0], 'google/gemma-4-31b-it:free');
        assert(m3.models.includes('meta-llama/llama-5-70b-instruct:free'));
        assert(!m3.models.includes('meta-llama/llama-5-70b-instruct'));
    });
    await t('discovery failure keeps defaults', async () => {
        const m4 = o.createModelManager({ key: 'k', env: {}, log: quiet, fetchJson: async () => { throw new Error('offline'); } });
        await m4.refresh();
        assert.deepStrictEqual(m4.models.slice(0, o.DEFAULT_MODELS.length), o.DEFAULT_MODELS);
    });
    console.log(`\n${failures} failures`);
    process.exit(failures ? 1 : 0);
})();
