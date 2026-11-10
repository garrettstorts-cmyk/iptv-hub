const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const context = vm.createContext({ window: {}, Date, channelCategories: c => c.categories || [] });
vm.runInContext(fs.readFileSync('js/epg.js', 'utf8'), context);
vm.runInContext(fs.readFileSync('js/sports.js', 'utf8'), context);
const now = new Date(2026, 10, 10, 12).getTime();
const make = (title, start, stop) => ({ title, start, stop, desc: '' });
const channels = [
  { name: 'Sports One', provider: 'A', categories: ['Sports'], epgChannelKey: 'A:1' },
  { name: 'General TV', provider: 'B', epgChannelKey: 'B:1' },
  { name: 'Sports Two', provider: 'B', categories: ['Sports'] }
];
const epg = new Map([
  ['A:1', { programmes: [make('NFL Replay', now - 3600000, now + 3600000)] }],
  ['B:1', { programmes: [make('NBA Basketball', now + 3600000, now + 7200000), make('Evening News', now + 7200000, now + 10800000)] }]
]);
for (const c of epg.values()) context.window.IPTVGuide.buildProgrammeIndex(c);
const state = { mode: 'now', sport: '', provider: '', query: '' };
const entries = changes => context.sportsEntries(channels, epg, { ...state, ...changes }, now);
assert.equal(entries({}).length, 1, 'only currently airing programming');
assert.equal(entries({ mode: 'today' }).length, 2, 'sports on general channels included, news excluded');
assert.equal(entries({ mode: 'today', provider: 'B' })[0].programme.title, 'NBA Basketball');
assert.equal(entries({ mode: 'today', sport: 'Football' }).length, 1);
assert.equal(entries({ mode: 'today', query: 'basketball' }).length, 1);
assert.equal(entries({ mode: 'tomorrow' }).length, 0);
assert.equal(entries({ mode: 'channels' }).length, 2, 'sports channels without EPG remain available');
assert.equal(entries({ provider: 'B' }).length, 0, 'guide remains provider scoped');
const midnight = new Date(2026, 10, 11).getTime();
assert.equal(context.sportsWindow('tomorrow', now)[0], midnight);
assert.equal(context.sportsWindow('today', now)[1], midnight);
console.log('Sports Hub: 10 assertions passed');
