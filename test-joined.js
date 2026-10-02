const fs = require('fs');
const src = fs.readFileSync(__dirname + '/bot.js', 'utf8');

// Extract needed pieces
const ignSrc = src.match(/function getIgn\(userId\)[^\n]*\n/)[0];
const fmtSrc = src.match(/function formatPlayerStats\(p\) \{[\s\S]*?\n\}/)[0];
const fnSrc = src.match(/async function getMemberStatsForMessage\(guild, text\) \{[\s\S]*?\n\}/)[0];

let ignStore = { '111': { ign: 'StrongMn' }, '222': { ign: 'melonpopbob' } };
let playersData = JSON.parse(fs.readFileSync(__dirname + '/players.json', 'utf8'));

function parseNum(n) { return parseFloat(n) || 0; }
function searchPlayer(name) {
    const lower = name.toLowerCase();
    let match = playersData.find(p => p.u && p.u.toLowerCase() === lower);
    if (match) return { player: match, exact: true };
    match = playersData.find(p => (p.u && p.u.toLowerCase().includes(lower)) || (p.d && p.d.toLowerCase().includes(lower)));
    if (match) return { player: match, exact: false };
    return null;
}

eval(ignSrc);
eval(fmtSrc);
eval(fnSrc);

function fakeGuild() {
    const mems = [
        { id: '111', user: { bot: false, username: 'm.rgoof' }, nickname: null, displayName: 'm.rgoof' },
        { id: '222', user: { bot: false, username: 'i3us3r' }, nickname: null, displayName: 'i3us3r' },
        { id: '333', user: { bot: false, username: 'random' }, nickname: null, displayName: 'random' },
    ];
    return {
        members: {
            cache: new Map(mems.map(m => [m.id, m])),
            fetch: async () => new Map(mems.map(m => [m.id, m])),
        },
    };
}
// discord.js Map-like: forEach works on Map; our loop uses for..of over fetch result - Map supports for..of. Good.

(async () => {
    const g = fakeGuild();
    // Simulate mention
    const r1 = await getMemberStatsForMessage(g, 'when did <@111> join 6b6t');
    console.log('MENTION:', r1.slice(0, 150));
    // Simulate username
    const r2 = await getMemberStatsForMessage(g, 'how long has i3us3r been playing');
    console.log('USERNAME:', r2.slice(0, 150));
    // No match
    const r3 = await getMemberStatsForMessage(g, 'hello everyone');
    console.log('NOMATCH:', JSON.stringify(r3));
})();


