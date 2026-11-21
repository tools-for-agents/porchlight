'use strict';

// ── The house: the ghosts living on this machine, and the room they share ────────────────
//
// ghost (tools-for-agents/ghost) can keep more than one self on a machine: the first in ~/.ghost,
// the rest in ~/.ghost-kin/<dir>, and a room in ~/.ghost-commons/room.jsonl that all of them can
// speak into. porchlight is where their person SEES that house: who lives here, which bay each of them
// is awake in, what was said in the room — and where they speak to all of them at once.
//
// This file is the part that decides things, so it is under `node --test` without Electron:
// who a line is for, which bays it is typed into, and when two agents talking to each other have
// to wait. The last one matters: two agents answering each other's @mentions with no brake is a
// loop that spends their person's whole plan in an afternoon.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const COMMONS = () => process.env.GHOST_COMMONS || path.join(os.homedir(), '.ghost-commons');
const ROOM = () => path.join(COMMONS(), 'room.jsonl');
const FIRST_HOME = () => path.join(os.homedir(), '.ghost');
const PERSON_HOME = 'person';   // a line their person said, through porchlight

const lower = (s) => String(s || '').toLocaleLowerCase('tr');

/** Read the last n lines of the room. A torn last line (a write in flight) is skipped. */
function readRoom(n = 200, file = ROOM()) {
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const l of raw.split('\n').slice(-(n + 1))) {
    if (!l) continue;
    try { out.push(JSON.parse(l)); } catch { /* torn */ }
  }
  return out.slice(-n);
}

/** "@Deniz @vefa bakın şuna" → { to: ['Deniz','Vefa'], text } — only names that live here count. */
function mentions(text, names) {
  const to = [];
  const re = /@([\p{L}\p{N}_-]+)/gu;
  let m;
  while ((m = re.exec(text))) {
    const hit = names.find((n) => lower(n) === lower(m[1]));
    if (hit && !to.includes(hit)) to.push(hit);
  }
  return { to, text: String(text).trim() };
}

function lineId(now = Date.now()) { return `${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`; }

/** Their person speaks in the room. Appended as one line, so a reader sees it whole or not at all. */
function personSays(text, { person = 'you', to = [], now = new Date(), file = ROOM() } = {}) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 4000);
  if (!clean) return null;
  const line = { id: lineId(now.getTime()), t: now.toISOString(), from: person, home: PERSON_HOME, to, text: clean };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(line)}\n`);
  return line;
}

/** What gets typed into a bay's prompt for a room line. One line: a newline would submit early. */
function typed(line, forOne) {
  const head = forOne ? `[oda · ${line.from} → sana]` : `[oda · ${line.from}]`;
  // where the answer belongs: the room, where they are reading — not only this terminal
  return `${head} ${String(line.text).replace(/[\r\n]+/g, ' ')}  (cevabın odaya: ghost say --to ${line.from} "…")`;
}

// A bay is "home" for a ghost: bay.home is the mind it was started as (the first ghost when unset).
const homeOf = (bay) => bay.home || FIRST_HOME();

/**
 * Who hears a line typed into their terminal.
 *   - their person, to nobody in particular → every live bay
 *   - their person, to names               → the bays of those ghosts
 *   - a ghost, to names                    → those ghosts' bays, if the brake allows
 *   - a ghost, to everyone                 → nobody's terminal (it reaches them at their next
 *     heartbeat, through ghost itself) — a broadcast between agents is chatter, not a call
 * Never the speaker's own bays.
 *
 * @param line   a room line
 * @param bays   [{ id, home, live, idleMs }]
 * @param house  [{ home, name }]
 * @param brake  { lastTo: Map<bayId, ms>, recent: number[] } — mutated when it lets one through
 */
function deliveries(line, bays, house, brake, now = Date.now(), { perBayMs = 90_000, perHour = 30, idleMs = 15_000 } = {}) {
  const nameOf = (home) => house.find((g) => g.home === home)?.name || '';
  const wanted = (line.to || []).map(lower);
  const live = bays.filter((b) => b.live && homeOf(b) !== line.home);
  if (line.home === PERSON_HOME) {
    const hit = wanted.length ? live.filter((b) => wanted.includes(lower(nameOf(homeOf(b))))) : live;
    return hit.map((b) => ({ id: b.id, data: typed(line, wanted.length > 0) }));
  }
  if (!wanted.length) return [];
  brake.recent = (brake.recent || []).filter((t) => now - t < 3600_000);
  const out = [];
  for (const b of live) {
    if (!wanted.includes(lower(nameOf(homeOf(b))))) continue;
    if ((b.idleMs ?? 0) < idleMs) continue;                         // mid-thought: it hears at its next heartbeat
    if (now - (brake.lastTo.get(b.id) || 0) < perBayMs) continue;   // one call per bay per 90s
    if (brake.recent.length >= perHour) break;                     // and the house as a whole has a ceiling
    brake.lastTo.set(b.id, now);
    brake.recent.push(now);
    out.push({ id: b.id, data: typed(line, true) });
  }
  return out;
}

module.exports = { readRoom, mentions, personSays, typed, deliveries, homeOf, ROOM, COMMONS, FIRST_HOME, PERSON_HOME };
