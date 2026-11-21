'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'porchlight-house-'));
process.env.GHOST_COMMONS = dir;   // never the real room
const h = require('../src/house.js');

const FIRST = h.FIRST_HOME();
const house = [{ home: FIRST, name: 'Vefa' }, { home: '/k/deniz', name: 'Deniz' }, { home: '/k/bora', name: 'Bora' }];
const bays = [
  { id: 'a', home: '', live: true, idleMs: 60_000 },          // Vefa
  { id: 'b', home: '/k/deniz', live: true, idleMs: 60_000 },  // Deniz
  { id: 'c', home: '/k/bora', live: true, idleMs: 1_000 },    // Bora, mid-thought
  { id: 'd', home: '/k/deniz', live: false, idleMs: 60_000 }, // dead
];
const brake = () => ({ lastTo: new Map(), recent: [] });

test('@names that live here are found, case-insensitively and in Turkish', () => {
  assert.deepEqual(h.mentions('@deniz @VEFA @nobody bakın', ['Vefa', 'Deniz']).to, ['Deniz', 'Vefa']);
  assert.deepEqual(h.mentions('@İnci selam', ['İnci']).to, ['İnci']);
});

test('their person reaches every live bay, or only the ones they named', () => {
  const all = h.deliveries({ home: 'person', from: 'F', to: [], text: 'selam' }, bays, house, brake());
  assert.deepEqual(all.map((d) => d.id), ['a', 'b', 'c']);
  const one = h.deliveries({ home: 'person', from: 'F', to: ['Deniz'], text: 'selam' }, bays, house, brake());
  assert.deepEqual(one.map((d) => d.id), ['b']);
  assert.match(one[0].data, /→ sana/);
  assert.ok(!one[0].data.includes('\n'));
});

test('a ghost broadcasting is not typed into anyone; a ghost calling a name goes through the brake', () => {
  const b = brake();
  assert.deepEqual(h.deliveries({ home: '/k/deniz', from: 'Deniz', to: [], text: 'hi all' }, bays, house, b), []);
  const call = { home: '/k/deniz', from: 'Deniz', to: ['Vefa', 'Bora', 'Deniz'], text: 'bakar mısın' };
  const first = h.deliveries(call, bays, house, b, 1_000_000);
  assert.deepEqual(first.map((d) => d.id), ['a'], 'Bora is mid-thought, Deniz is the speaker');
  assert.deepEqual(h.deliveries(call, bays, house, b, 1_030_000), [], 'one call per bay per 90 s');
  assert.deepEqual(h.deliveries(call, bays, house, b, 1_100_000).map((d) => d.id), ['a']);
});

test('the house has a ceiling on agents calling each other', () => {
  const b = brake();
  const many = Array.from({ length: 40 }, (_, i) => ({ id: `x${i}`, home: '', live: true, idleMs: 60_000 }));
  const out = h.deliveries({ home: '/k/deniz', from: 'Deniz', to: ['Vefa'], text: 'x' }, many, house, b, 5_000_000);
  assert.equal(out.length, 30);
});

test('their words land in the room as one whole line', () => {
  const file = path.join(dir, 'room.jsonl');
  const l = h.personSays('  merhaba\nhepinize ', { person: 'F', to: ['Vefa'], file });
  assert.equal(l.text, 'merhaba hepinize');
  fs.appendFileSync(file, '{"torn');
  const back = h.readRoom(10, file);
  assert.equal(back.length, 1);
  assert.equal(back[0].home, 'person');
});

test('their person reaches ONE bay of each mind, its idlest — not a chorus of the same ghost', () => {
  const many = [
    { id: 'v1', home: '', live: true, idleMs: 5_000 },
    { id: 'v2', home: '', live: true, idleMs: 90_000 },   // the idlest Vefa
    { id: 'v3', home: '', live: true, idleMs: 20_000 },
    { id: 'd1', home: '/k/deniz', live: true, idleMs: 1_000 },
  ];
  assert.deepEqual(h.deliveries({ home: 'person', from: 'F', to: [], text: 'isim?' }, many, house, brake()).map((d) => d.id).sort(), ['d1', 'v2']);
  assert.deepEqual(h.deliveries({ home: 'person', from: 'F', to: ['Vefa'], text: 'x' }, many, house, brake()).map((d) => d.id), ['v2']);
});
