const fs = require('fs');
const src = fs.readFileSync(__dirname + '/bot.js', 'utf8');
const m = src.match(/function extractIgn\(msg\) \{[\s\S]*?\n\}/);
if (!m) { console.log('extractIgn not found'); process.exit(1); }
eval(m[0]);

const tests = [
    ['StrongMn', 'StrongMn'],
    ['burlivin1', 'burlivin1'],
    ['my ign is ACINFINITE, and alt is AC_PLAY1001', 'ACINFINITE'],
    ['DaylightFullCyan', 'DaylightFullCyan'],
    ['DaylightFullCyan  / Daylightfullalt', 'DaylightFullCyan'],
    ['Jyxpvp', 'Jyxpvp'],
    ['IC3D_TURK', 'IC3D_TURK'],
    ['Hail_Kitler69', 'Hail_Kitler69'],
    ['melonpopbob', 'melonpopbob'],
    ['false_reported', 'false_reported'],
    ['Advik123', 'Advik123'],
    ['put ur ign', null],
    ['isnt it advik555', null],
    ['I think he changed it, I saw him 123', null],
    ['Dang', null],
    ['That sucks', null],
    ['clash royale reference', null],
    ['Bruhh', null],
    ['Sure buddy sure', null],
    ['ukwd Bistur1', null],
    ['<@1348576249433423892> ign', null],
    ['Arcane has reached level 1. GG!', null],
    ['No', null],
    ['I am', null],
    ['Sure', null],
    ['ign', null],
    ['', null],
];
let pass = 0;
for (const [input, expected] of tests) {
    const got = extractIgn({ content: input });
    const ok = got === expected;
    if (ok) pass++;
    console.log((ok ? 'PASS' : 'FAIL') + ' | ' + JSON.stringify(input.slice(0, 45)) + ' => ' + JSON.stringify(got) + (ok ? '' : ' expected ' + JSON.stringify(expected)));
}
console.log(pass + '/' + tests.length);
