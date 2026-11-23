// Offline smoke test: runs bot.js handlers against fake interactions/messages
// for home server, other server, user-installed app (bot not in server), and DMs.
const djs = require('discord.js');
const { PermissionsBitField } = djs;
const handlers = {};
let clientInstance = null;
djs.Client.prototype.login = async function () { return 'stub'; };
const origOn = djs.Client.prototype.on;
djs.Client.prototype.on = function (ev, fn) { clientInstance = this; (handlers[ev] = handlers[ev] || []).push(fn); return origOn.call(this, ev, fn); };
djs.REST.prototype.put = async () => ({});
let restGet = async () => [];
djs.REST.prototype.get = function (...a) { return restGet(...a); };
process.env.OPENROUTER_KEY = '';
process.env.OPENROUTER_MODELS = 'test/model:free';
// No real network calls to OpenRouter from tests.
const https = require('https');
const { EventEmitter } = require('events');
https.request = () => { const r = new EventEmitter(); r.write = () => {}; r.end = () => setImmediate(() => r.emit('error', new Error('offline test'))); r.destroy = () => {}; return r; };
require('./bot.js');

const HOME = '1525527778949202031', OTHER = '999', CREATOR = '1525529923387789533', BOT_ID = '1546004878130941952';
let failures = 0;
function check(name, cond, extra) { console.log(`${cond ? 'PASS' : 'FAIL'} | ${name}${cond ? '' : ' -> ' + JSON.stringify(extra)}`); if (!cond) failures++; }

function makeInteraction({ commandName, guildId = null, botInGuild = false, member = null, perms = null, options = {}, sub = null, context = 0, userId = 'u1' }) {
    const out = [];
    const i = {
        commandName, guildId, context, channelId: 'c1', user: { id: userId, username: 'dave', globalName: 'Dave', displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/0.png' },
        guild: botInGuild ? fakeGuild(guildId) : null,
        channel: botInGuild ? { send: async (m) => out.push({ channelSend: m }) } : null,
        member, memberPermissions: perms ? new PermissionsBitField(perms) : null,
        deferred: false, replied: false, out,
        isChatInputCommand: () => true,
        options: { getString: k => options[k] ?? null, getUser: k => options[k] ?? null, getChannel: k => options[k] ?? null, getSubcommand: () => sub },
        reply: async (m) => { i.replied = true; out.push({ reply: m }); return { resource: { message: { react: async () => { if (!botInGuild) { const e = new Error('Missing Access'); e.code = 50001; throw e; } } } } }; },
        deferReply: async () => { i.deferred = true; },
        editReply: async (m) => { out.push({ edit: m }); },
        followUp: async (m) => { out.push({ followUp: m }); },
        deleteReply: async () => { out.push({ deleted: true }); },
    };
    return i;
}
function fakeMember(id, roles = []) {
    const rc = new Map(roles.map(r => [r, { id: r, name: 'R' + r, position: 1 }]));
    return { id, user: { id, bot: false, username: 'm' + id, displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/0.png' }, displayName: 'M' + id, nickname: null, joinedAt: new Date(0),
        roles: { cache: rc, highest: { name: 'TopRole', position: 1 } } };
}
function fakeGuild(id) {
    const members = new djs.Collection();
    for (let k = 0; k < 40; k++) members.set('m' + k, fakeMember('m' + k));
    // 40 distinct top roles to exceed the 25-field limit
    let n = 0; for (const m of members.values()) m.roles.highest = { name: 'Role' + (n++), position: n };
    return { id, name: 'Other Server', memberCount: 40, members: { fetch: async () => members, cache: members }, channels: { cache: new djs.Collection() } };
}
const run = async (i) => { for (const h of handlers.interactionCreate) await h(i); return i.out; };
const text = (out) => JSON.stringify(out);

(async () => {
    // Other server, bot in it
    let o = await run(makeInteraction({ commandName: 'roster', guildId: OTHER, botInGuild: true }));
    check('roster other server: no error, <=25 fields', !/Something went wrong/.test(text(o)) && o[0].edit.embeds[0].data.fields.length <= 25, o);
    o = await run(makeInteraction({ commandName: 'members', guildId: OTHER, botInGuild: true }));
    check('members other server', !/Something went wrong/.test(text(o)), o);
    o = await run(makeInteraction({ commandName: 'random', guildId: OTHER, botInGuild: true }));
    check('random other server', !/Something went wrong/.test(text(o)), o);
    // user-installed in a server bot isn't in (raw member)
    const raw = { roles: ['1', '2'], nick: 'Nick', joined_at: '2024-01-01T00:00:00Z', permissions: '0' };
    o = await run(makeInteraction({ commandName: 'rank', guildId: OTHER, member: raw, perms: 0n }));
    check('rank user-install raw member', /Nick/.test(text(o)) && !/Something went wrong/.test(text(o)), o);
    o = await run(makeInteraction({ commandName: 'roster', guildId: OTHER, member: raw }));
    check('roster user-install (no public data) gives friendly message + add button', /doesn't let apps see/.test(text(o)) && /integration_type=0/.test(text(o)), o);
    o = await run(makeInteraction({ commandName: 'poll', guildId: OTHER, member: raw, options: { question: 'Q?', options: 'a,b' } }));
    check('poll user-install uses native poll', o[0].reply && o[0].reply.poll && o[0].reply.poll.answers.length === 2, o);
    o = await run(makeInteraction({ commandName: 'stats', guildId: OTHER, member: raw, options: { player: 'melonpopbob' } }));
    check('stats user-install', o[0].reply && o[0].reply.embeds && !/Something went wrong/.test(text(o)), o);
    o = await run(makeInteraction({ commandName: 'help', context: 1 }));
    check('help in DM', !!o[0].reply.embeds, o);
    o = await run(makeInteraction({ commandName: 'info', guildId: OTHER, member: raw }));
    check('info user-install', !/Something went wrong/.test(text(o)), o);
    o = await run(makeInteraction({ commandName: 'ign', guildId: OTHER, member: raw, options: { user: { id: 'u2', username: 'x' }, ign: 'Hacker' } }));
    check('ign: cannot set others outside home', /only set your own/.test(text(o)), o);
    o = await run(makeInteraction({ commandName: 'anon', guildId: OTHER, member: raw, options: { message: 'hi' } }));
    check('anon user-install refused cleanly with add button', /needs me to be a member/.test(text(o)) && /permissions=93248/.test(text(o)), o);

    // /members, /roster, /random as a user app in a server the bot isn't in
    const err = (code) => Object.assign(new Error('x'), { code });
    const PREVIEW = { name: 'Disco Server', approximate_member_count: 12345, approximate_presence_count: 678 };
    const WIDGET = { name: 'Widget Server', presence_count: 42, members: [{ username: 'alice', avatar_url: 'https://cdn.discordapp.com/embed/avatars/1.png' }, { username: 'bob_*x*' }], instant_invite: 'https://discord.com/invite/abc123' };
    const INVITE = { approximate_member_count: 999, approximate_presence_count: 50 };
    let gid = 1000;
    const ui = (commandName) => makeInteraction({ commandName, guildId: String(gid++), member: raw });
    restGet = async (route) => { if (route.endsWith('/preview')) return PREVIEW; throw err(50004); };
    o = await run(ui('members'));
    let f = JSON.stringify(o[0].edit && o[0].edit.embeds[0].data);
    check('members user-install: discoverable -> approx counts', /12,345/.test(f) && /678/.test(f) && /Disco Server/.test(f), o);
    restGet = async (route) => { if (route.endsWith('/preview')) throw err(50001); if (route.endsWith('/widget.json')) return WIDGET; if (route.startsWith('/invites/abc123')) return INVITE; throw err(0); };
    o = await run(ui('members'));
    f = JSON.stringify(o[0].edit && o[0].edit.embeds[0].data);
    check('members user-install: widget+invite -> approx counts', /999/.test(f) && /50/.test(f) && /Widget Server/.test(f), o);
    o = await run(ui('roster'));
    f = JSON.stringify(o[0].edit && o[0].edit.embeds[0].data);
    check('roster user-install: widget online list', /alice/.test(f) && /bob\\\\_/.test(f), o);
    o = await run(ui('random'));
    f = JSON.stringify(o[0].edit && o[0].edit.embeds[0].data);
    check('random user-install: picks from widget', /alice|bob/.test(f), o);
    restGet = async () => { throw err(50004); };
    o = await run(ui('members'));
    check('members user-install: nothing public -> friendly ephemeral + button, not an error', o.some(x => x.followUp && x.followUp.ephemeral && /doesn't let apps see/.test(x.followUp.content) && x.followUp.components) && !/Something went wrong/.test(text(o)), o);
    o = await run(makeInteraction({ commandName: 'members', context: 1 }));
    check('members in DM: server-only message', /only works inside a server/.test(text(o)), o);
    restGet = async () => [];
    // autopublish permissions
    o = await run(makeInteraction({ commandName: 'autopublish', guildId: HOME, botInGuild: true, member: fakeMember('a', []), perms: PermissionsBitField.Flags.Administrator, sub: 'list' }));
    check('autopublish home: admin w/o Creator denied', /Creator role/.test(text(o)), o);
    o = await run(makeInteraction({ commandName: 'autopublish', guildId: HOME, botInGuild: true, member: fakeMember('a', [CREATOR]), perms: 0n, sub: 'list' }));
    check('autopublish home: Creator allowed', /auto-publish/i.test(text(o)) && !/Creator role/.test(text(o)), o);
    o = await run(makeInteraction({ commandName: 'autopublish', guildId: OTHER, botInGuild: true, member: fakeMember('a', []), perms: PermissionsBitField.Flags.ManageGuild, sub: 'list' }));
    check('autopublish other: Manage Server allowed', !/permission to use/.test(text(o)), o);
    o = await run(makeInteraction({ commandName: 'autopublish', guildId: OTHER, botInGuild: true, member: fakeMember('a', []), perms: 0n, sub: 'list' }));
    check('autopublish other: no perms denied', /Manage Server/.test(text(o)), o);
    o = await run(makeInteraction({ commandName: 'autopublish', guildId: HOME, botInGuild: true, member: fakeMember('su', []), sub: 'list', userId: '1349498346162880523' }));
    check('autopublish home: super user allowed without role', /auto-publish/i.test(text(o)) && !/Creator role/.test(text(o)), o);
    o = await run(makeInteraction({ commandName: 'anon', guildId: HOME, botInGuild: true, member: fakeMember('su', []), options: { message: 'hi' }, userId: '1349498346162880523' }));
    check('anon home: super user allowed without role', !/Creator role/.test(text(o)), o);
    o = await run(makeInteraction({ commandName: 'sync', guildId: OTHER, botInGuild: true, member: fakeMember('a', []), perms: PermissionsBitField.Flags.Administrator }));
    check('sync refused outside home', /only works in The Mafia/.test(text(o)), o);

    // AI mention gating: only a direct <@BOT>/<@!BOT> mention, a reply to the bot, or a DM
    clientInstance.user = { id: BOT_ID };
    const typed = [];
    function msg(content, extra = {}) {
        return { id: 'x', content, author: { bot: false, username: 'dave', globalName: 'Dave' }, guild: { id: OTHER, members: { cache: new Map(), fetch: async () => new Map() } }, channelId: 'c1', reference: null, flags: null,
            mentions: { has: () => true, users: new Map() },
            channel: { sendTyping: async () => { typed.push(content); throw new Error('stop'); }, messages: { fetch: async () => ({ author: { id: 'someone' }, embeds: [] }) } }, reply: async () => {}, react: async () => ({ }), ...extra };
    }
    const fire = async (m) => { typed.length = 0; for (const h of handlers.messageCreate) { try { await h(m); } catch (e) {} } await new Promise(r => setTimeout(r, 20)); return typed.length > 0; };
    check('AI ignores @everyone', !(await fire(msg('@everyone hello'))));
    check('AI ignores @here', !(await fire(msg('@here hello'))));
    check('AI ignores role ping', !(await fire(msg('<@&12345> hello'))));
    check('AI ignores other user mention', !(await fire(msg('<@42> hello'))));
    check('AI responds to <@BOT>', await fire(msg(`<@${BOT_ID}> hello`)));
    check('AI responds to <@!BOT>', await fire(msg(`<@!${BOT_ID}> hello`)));
    check('AI responds to reply to bot', await fire(msg('and then?', { reference: { messageId: 'r' }, channel: { sendTyping: async () => { typed.push(1); throw new Error('stop'); }, messages: { fetch: async () => ({ author: { id: BOT_ID }, embeds: [{ title: 'AI Response', description: 'prev' }], content: '' }) } } })));
    check('AI ignores reply to someone else', !(await fire(msg('lol', { reference: { messageId: 'r' } }))));
    check('AI responds in DMs', await fire(msg('hi', { guild: null })));
    console.log(`\n${failures} failures`);
    process.exit(failures ? 1 : 0);
})();
