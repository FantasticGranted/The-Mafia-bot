// OpenRouter model selection + chat helper for the bot's AI features.
// - Keeps a ranked list of FREE text-chat models, refreshed from the public /models endpoint
//   (no key needed) at startup and every few hours, so retired models drop out automatically.
// - Falls back to the hardcoded DEFAULT_MODELS if discovery fails.
// - Skips models that are gone (404 / "no longer available" / "unavailable for free") for the rest
//   of the session, and cools down rate-limited (429) models briefly.
// - Never uses paid models unless OPENROUTER_PAID_MODELS is set (explicit opt-in).
const https = require('https');

// Current free models (checked against https://openrouter.ai/api/v1/models on 2026-11-22), best first.
const DEFAULT_MODELS = [
    'google/gemma-4-31b-it:free',
    'nvidia/nemotron-3-ultra-550b-a55b:free',
    'nvidia/nemotron-3.5-super-vl:free',
    'google/gemma-4-26b-a4b-it:free',
    'inclusionai/ling-3.2-flash:free',
    'nvidia/nemotron-3.5-lightning:free',
    'baidu/ernie-5.5-flash-preview:free',
];
// OpenRouter's own free router: picks any working free model. Always tried last.
const FREE_ROUTER = 'openrouter/free';

const REFRESH_MS = 6 * 60 * 60 * 1000;
const RATE_LIMIT_COOLDOWN_MS = 60 * 1000;
const MAX_MODELS = 8;

function splitList(v) { return (v || '').split(',').map(s => s.trim()).filter(Boolean); }

function isFree(m) {
    const p = m.pricing || {};
    const zero = (x) => x === undefined || x === null || Number(x) === 0;
    return Number(p.prompt) === 0 && Number(p.completion) === 0 && zero(p.request) && zero(p.image);
}

function isTextChat(m) {
    const a = m.architecture || {};
    const ins = a.input_modalities || (a.modality ? a.modality.split('->')[0].split('+') : ['text']);
    const outs = a.output_modalities || (a.modality ? a.modality.split('->')[1].split('+') : ['text']);
    if (!ins.includes('text')) return false;
    if (outs.length !== 1 || outs[0] !== 'text') return false; // skip music/image/audio generators
    if (Array.isArray(m.endpoints) && !m.endpoints.includes('/api/v1/chat/completions')) return false;
    return true;
}

function notExpired(m, now = Date.now()) {
    if (!m.expiration_date) return true;
    const t = Date.parse(m.expiration_date);
    return isNaN(t) || t > now + 24 * 60 * 60 * 1000;
}

// Higher is better. Prefers strong general instruct models; demotes previews, code-only, tiny models.
function scoreModel(m, now = Date.now()) {
    const id = m.id.toLowerCase();
    const desc = (m.description || '').toLowerCase().slice(0, 300);
    let s = 0;
    const families = [
        [/^(deepseek|openai\/gpt-oss|moonshotai|z-ai|x-ai)\//, 30],
        [/^google\/gemma/, 30], [/^(meta-llama|qwen|nvidia\/nemotron)/, 25],
        [/^(mistralai|microsoft|baidu|minimax)\//, 18], [/^inclusionai\//, 15],
    ];
    for (const [re, pts] of families) if (re.test(id)) { s += pts; break; }
    const size = id.match(/(\d+(?:\.\d+)?)b(?![a-z])/);
    if (size) s += Math.min(Math.log2(parseFloat(size[1]) + 1) * 4, 40);
    if (/(ultra|super|large|pro)\b/.test(id)) s += 12;
    if (/(nano|tiny|small|mini)\b/.test(id) || (size && parseFloat(size[1]) < 4)) s -= 15;
    if (/(-it\b|instruct|chat)/.test(id)) s += 10;
    if (/(preview|beta|experimental|exp\b)/.test(id)) s -= 20;
    if (/(code|coder|coding)/.test(id) || /(agentic coding|for coding|coding agents|software engineering)/.test(desc)) s -= 40;
    if (/(reasoning|thinking)/.test(id)) s -= 10;
    if (/omni|sub-agent/.test(id + ' ' + desc)) s -= 10;
    if ((m.context_length || 0) >= 32000) s += 5;
    if ((m.context_length || 0) < 8000) s -= 30;
    if (m.created && now / 1000 - m.created < 180 * 86400) s += 5;
    return s;
}

// From a /api/v1/models payload, return ranked free text-chat model IDs (best first).
function rankFreeModels(payload, { max = MAX_MODELS, now = Date.now() } = {}) {
    const data = Array.isArray(payload) ? payload : (payload && payload.data) || [];
    return data
        .filter(m => m && m.id && m.id !== FREE_ROUTER && isFree(m) && isTextChat(m) && notExpired(m, now))
        .map(m => ({ id: m.id, score: scoreModel(m, now) }))
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
        .slice(0, max)
        .map(m => m.id);
}

// Build the final fallback chain.
function buildModelList({ envModels = [], discovered = null, available = null, paid = [] } = {}) {
    // available: Set of every model ID OpenRouter currently lists (used to check the free router exists).
    let list;
    if (envModels.length) list = [...envModels];
    else if (discovered && discovered.length) {
        // Keep hardcoded favourites that still exist (in their order), then the rest by score.
        const keep = DEFAULT_MODELS.filter(id => discovered.includes(id));
        list = [...new Set([...keep, ...discovered])].slice(0, MAX_MODELS);
    } else list = [...DEFAULT_MODELS];
    if (!envModels.length && (!available || available.has(FREE_ROUTER))) list.push(FREE_ROUTER);
    list.push(...paid);
    return [...new Set(list)];
}

// Classify an OpenRouter failure. -> { kind: 'gone' | 'rate_limited' | 'paid_only' | 'transient', reason }
function classifyError(status, err) {
    const code = err && (err.code ?? (err.error && err.error.code));
    const msg = String((err && (err.message || (err.error && err.error.message))) || '').toLowerCase();
    if (status === 429 || code === 429 || /rate.?limit|too many requests/.test(msg)) return { kind: 'rate_limited', reason: msg || '429' };
    if (/unavailable for free|paid version|use this slug/.test(msg)) return { kind: 'paid_only', reason: msg };
    if (status === 404 || code === 404 || /no longer available|no endpoints found|not a valid model|model not found|does not exist/.test(msg)) return { kind: 'gone', reason: msg || '404' };
    if (status === 402 || code === 402 || /insufficient credits|requires more credits/.test(msg)) return { kind: 'paid_only', reason: msg || '402' };
    return { kind: 'transient', reason: msg || `HTTP ${status}` };
}

// Strip leaked reasoning; return '' if the reply is unusable.
function cleanReply(text) {
    let reply = String(text || '');
    reply = reply.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/<thinking>[\s\S]*?<\/thinking>/g, '').trim();
    if (/^(here'?s a thinking process|thinking:|thought process|let me think|analysis:)/i.test(reply)) {
        const lines = reply.split('\n');
        let start = 0;
        for (let i = 0; i < lines.length; i++) if (lines[i].trim() === '' && i > 3) { start = i + 1; break; }
        reply = lines.slice(start).join('\n').trim();
    }
    if (/^(here'?s a thinking process|here is what i need|thinking:|thought process|analysis:|let me (think|analyze))/i.test(reply)) return '';
    return reply.substring(0, 1900);
}

function httpJson({ method = 'GET', path, body, key, timeout = 20000 }) {
    return new Promise((resolve, reject) => {
        const headers = { 'Content-Type': 'application/json', 'HTTP-Referer': 'https://github.com/FantasticGranted/The-Mafia-bot', 'X-Title': 'The Mafia bot' };
        if (key) headers.Authorization = `Bearer ${key}`;
        const data = body ? JSON.stringify(body) : null;
        if (data) headers['Content-Length'] = Buffer.byteLength(data);
        const req = https.request({ hostname: 'openrouter.ai', path, method, headers, timeout }, (res) => {
            let raw = '';
            res.on('data', c => raw += c);
            res.on('end', () => {
                let json = null;
                try { json = JSON.parse(raw); } catch (e) {}
                resolve({ status: res.statusCode, json, raw });
            });
        });
        req.on('timeout', () => req.destroy(new Error('timed out')));
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

function createModelManager({ key, env = process.env, fetchJson = httpJson, log = console } = {}) {
    const envModels = splitList(env.OPENROUTER_MODELS);
    const paid = splitList(env.OPENROUTER_PAID_MODELS);
    let models = buildModelList({ envModels, paid });
    let lastRefresh = 0;
    const blocked = new Map(); // model -> until (ms); Infinity = rest of session

    async function refresh() {
        if (envModels.length) return models;
        try {
            const res = await fetchJson({ path: '/api/v1/models', timeout: 15000 });
            if (res.status !== 200 || !res.json || !Array.isArray(res.json.data)) throw new Error(`HTTP ${res.status}`);
            const available = new Set(res.json.data.map(m => m.id));
            const discovered = rankFreeModels(res.json);
            models = buildModelList({ discovered, available, paid });
            lastRefresh = Date.now();
            log.log(`AI models refreshed (${models.length}): ${models.join(', ')}`);
        } catch (e) {
            log.error('AI model discovery failed, keeping current list:', e.message);
        }
        return models;
    }

    function usable(now = Date.now()) {
        return models.filter(m => !(blocked.get(m) > now));
    }

    async function complete(messages, { maxTokens = 400, temperature = 0.7 } = {}) {
        if (!lastRefresh && !envModels.length) await refresh();
        const failures = [];
        const chain = usable();
        for (const model of chain) {
            let res;
            try {
                res = await fetchJson({
                    method: 'POST', path: '/api/v1/chat/completions', key, timeout: 25000,
                    // Reasoning models: keep thinking short and out of the reply so it doesn't eat the answer.
                    body: { model, messages, max_tokens: maxTokens + 800, temperature, reasoning: { effort: 'low', exclude: true } },
                });
            } catch (e) { failures.push(`${model}: ${e.message}`); continue; }
            const err = res.json && res.json.error;
            if (res.status >= 400 || err) {
                const c = classifyError(res.status, err || { message: res.raw && res.raw.slice(0, 200) });
                if (c.kind === 'gone' || c.kind === 'paid_only') blocked.set(model, Infinity);
                else if (c.kind === 'rate_limited') blocked.set(model, Date.now() + RATE_LIMIT_COOLDOWN_MS);
                failures.push(`${model}: [${c.kind}] ${c.reason.slice(0, 160)}`);
                continue;
            }
            const content = res.json && res.json.choices && res.json.choices[0] && res.json.choices[0].message && res.json.choices[0].message.content;
            const reply = cleanReply(content);
            if (!reply) { failures.push(`${model}: empty/thinking-only reply`); continue; }
            if (failures.length) log.log(`AI answered with ${model} after ${failures.length} failure(s): ${failures.join(' | ')}`);
            return { reply, model };
        }
        log.error(`AI failed on all ${chain.length} model(s):\n  ${failures.join('\n  ') || 'no usable models'}`);
        if (lastRefresh && Date.now() - lastRefresh > 10 * 60 * 1000) refresh().catch(() => {});
        const e = new Error('AI_UNAVAILABLE'); e.failures = failures; throw e;
    }

    function start() {
        refresh();
        const t = setInterval(refresh, REFRESH_MS);
        if (t.unref) t.unref();
    }

    return { refresh, complete, start, get models() { return [...models]; }, blocked };
}

const FRIENDLY_AI_ERROR = "🤖 My AI brain is taking a quick nap. All the free AI models I use are busy or unavailable right now. Try again in a minute!";

module.exports = { DEFAULT_MODELS, FREE_ROUTER, rankFreeModels, buildModelList, classifyError, cleanReply, scoreModel, createModelManager, FRIENDLY_AI_ERROR };
