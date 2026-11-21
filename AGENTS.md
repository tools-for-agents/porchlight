# AGENTS.md — Haunt (formerly hangar; for one evening Sofra, then Hearth)

On 21 Nov 2026 the app was renamed Sofra, then Hearth, then Haunt (Fatih wanted an English name, and a creative one). Everything moved with it: the repo (`tools-for-agents/haunt`), the folder, the product name, the appId `com.algolindustries.haunt`, the `window.haunt*` bridges and the `HAUNT_*` env hooks. userData moved to `~/Library/Application Support/haunt` (main.js moves the old `hangar` folder on first launch). The one thing kept is the signing certificate `hangar-dev-signing`: a new one would void Full Disk Access.

🏚 **Nine bays. Press `+`, pick a folder, and a Claude agent starts there — live, in the tile.**
An Electron desktop app for running many agents at once, one folder per bay.
Part of [tools-for-agents](https://github.com/tools-for-agents).

## Setup

```bash
node --version     # 22+
npm install        # runs electron-rebuild -w node-pty — this is the slow step
npm start          # run it
npm run dist       # build the .app (arm64 dmg + zip, unsigned)
```

⚠️ **haunt is the ONE tool in this kit that is not zero-dependency, deliberately.** A live TTY inside a tile
needs a real PTY, and `node-pty` is a native module. Do not "fix" this by removing it, and do not treat it as
licence to add anything else — the rest of the kit's doctrine still applies.

## What a bay runs

`claude --dangerously-skip-permissions` — chosen explicitly by the app's owner. It is a **constant in
`src/main.js`**; the renderer cannot supply a command, so a UI bug can never become a shell. haunt holds no
accounts, keys or network of its own — it spawns the local `claude`, which authenticates itself. The only
thing it persists is folder paths.

## mira — the voice (src/voice/)

The orb in the footer. Her NAME is Mira (chosen by whisper bake-off — see README; "jarvis" kept as a
second wake word and as the module's internal name — do not rename the files). Pipeline: renderer mic
(`mic.js` + worklet, 16k int16 frames over IPC) →
`engine.js`, a **plain-node sidecar** spawned with `ELECTRON_RUN_AS_NODE=1` and
`DYLD_LIBRARY_PATH` pointing at `sherpa-onnx-darwin-arm64` (VAD → speaker-verification gate →
whisper STT, plus piper TTS) → `jarvis.js` in main (wake word, policy, actions) → `brain.js`
(`claude -p --model opus --effort xhigh --dangerously-skip-permissions`, fed every bay's
ANSI-stripped tail plus each project's `~/.claude/projects/<munged-cwd>/memory/MEMORY.md` index
inline; it Reads/Greps the memory files behind them and may Write memory back on "not al") → text
typed into a bay's pty, reply spoken via `afplay`. The wait is masked by a spoken ack, and a bare
"dur" bypasses the brain entirely (instant Esc).

She is the fleet's ORCHESTRATOR: brain actions are send/esc/start/kill/restart/close. `start`
mkdirs (home-dir-guarded — never outside `$HOME`), writes the bay into state.json in main, and sends
`voice:sync` — the renderer reloads state and its NORMAL mountTerm flow starts the agent, exactly as
if a human clicked +; there is deliberately no second way to spawn a session. A `start` may carry
`text`: the first task, delivered once the new pty has spoken and settled (~6s). New-project parents
are INFERRED (most common parent among existing bays; `voice.json` `projectsDir` overrides). E2E
provable without a mic: `HAUNT_VOICE_DEMO=start HAUNT_VOICE_DEMO_START=<path>` drives the real
action path and the screenshot shows the session mira opened.

Rules that are POLICY, not accident: the engine only ever answers "who spoke and what did they
say" — whether to obey lives in `jarvis.js`; an un-enrolled jarvis obeys **nobody**; the
speaker gate is also the echo gate (jarvis's own piper voice scores a stranger). Models live in
`~/Library/Application Support/haunt/voice-models` (fixed on purpose — a `--user-data-dir` test
run must not want its own 570MB); `npm run voice-models` fetches them. The pure parts (wake
fuzzy-match, ANSI strip, brain parse/context) are under `node --test` in `test/voice.test.js`;
the whole audio pipeline is testable without a microphone via engine's CLI
(`engine.js --stt/--embed/--tts` on `say`-generated wavs — see the serve-mode protocol at the
top of `engine.js`).

## The three things that cost real time (all commented in-source)

**1. A GUI app does not have your PATH.** Launched from Finder it inherits `/usr/bin:/bin:/usr/sbin:/sbin`,
so `~/.local/bin/claude` is not there and `spawn claude` fails with ENOENT on a machine where `claude` works
fine in a terminal. Ask the login shell once (`$SHELL -lic 'command -v claude'`) and cache it. Same for the
agent's env — and **an interactive shell chatters on stdout**, so mark the value with a sentinel instead of
taking the last line.

**2. A `display:` rule beats the `hidden` attribute.** `.plus`/`.live` set `display:grid`, so `hidden` did
nothing and every bay painted its header over its terminal. The CSS must say `.plus[hidden] { display: none }`
out loud. *Only looking at a screenshot caught it.*

**3. One host element per bay, for its life.** Every render calls `grid.replaceChildren()`, so calling
`term.open()` on a fresh node leaves xterm bound to a dead screen — the pty streams, the bay says "running",
and the terminal draws nothing. The tile re-parents the bay's existing host instead.

## How to see it

An Electron window cannot be screenshotted without Screen Recording permission, so the app photographs
itself:

```bash
HAUNT_SHOT=/tmp/x.png HAUNT_SHOT_WAIT=16000 npm start    # render, wait, capturePage(), quit
HAUNT_DEBUG=1 npm start                                   # findClaude/loginEnv/state + every pty event
```

**Never test against the real state file** — someone is using this app, and launching it would spawn real
agents in their folders. Electron's `--user-data-dir=/tmp/x` relocates `state.json`; seed it with
`{pages:[{id,bays:[{path,title},null,…]}]}` and the grid is yours. **This works on the packaged .app too:**

```bash
HAUNT_SHOT=/tmp/x.png ./dist/mac-arm64/haunt.app/Contents/MacOS/haunt --user-data-dir=/tmp/udd
```

## The rules this repo is built on

**1. A failed read must never cause a write.** This lost a real user seven bays: `loadState()` swallowed a
parse error and returned an empty default, and the renderer saved that default over their work. Reads that
fail now say so (`ok:false`), writes are atomic (tmp + rename), and the last good state is kept beside it.

**2. A debug flag that does not exist is worse than none.** `HAUNT_DEBUG` was in the notes for a day before
it was in the source. Running with it printed nothing — against a healthy app — and that silence is exactly
the silence a dead pty makes. It exists now; quiet means quiet.

**3. Packaging: `asarUnpack` node-pty.** A native module cannot be loaded out of an asar archive. Verify a
build by *running the .app*, not by watching electron-builder exit 0.

## Commits

Lowercase, `area: what changed and why it mattered` — `ui:`, `fix:`, `haunt:`. Say what was actually wrong,
including what fooled you. The git log is this project's real documentation.

## The house (src/house.js · src/renderer/house-ui.js · house.css)

haunt's first view is a chat with every ghost living on this machine (ghost ≥ the commons:
`ghost house --json`, `~/.ghost-commons/room.jsonl`). Who lives here and how to start a session
AS one of them comes from ghost, never from the renderer: a bay may name a mind (`bay.home`),
main checks it against `ghost house` and takes the env/settings/args ghost hands back. Their
person's line goes to every live bay, or only to @named ones; a ghost's broadcast is typed into
no one; a ghost @calling another is typed in only through the brake (idle ≥15s, one per bay per
90s, 30 per hour for the whole house) — two agents answering each other with no brake spend a
plan in an afternoon. Faces are drawn by their owners (`ghost avatar set`), cleaned by ghost,
shown through <img> (no script runs in an img-loaded SVG). Fonts ship in src/renderer/fonts
(Chakra Petch, IBM Plex Sans, OFL) because the CSP allows nothing remote. Test hooks for the
screenshot harness: HAUNT_VIEW=chat|bays, HAUNT_HOUSE_CHAN=<name>; a HAUNT_SHOT window is
never shown, so photographing the app does not take the keyboard from whoever is working.
