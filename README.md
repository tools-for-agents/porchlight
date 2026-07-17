# hangar

**Nine bays. Press `+`, pick a folder, and a Claude agent starts there — live, in the tile.**

A small macOS desktop app for running several Claude Code agents at once and actually
watching them. Each bay is a real interactive terminal: you can read what the agent is
doing and type back into it. The folder's name becomes the bay's title, and every running
bay gets its own colour so nine of them stay tellable apart. Nine to a page; add and close
pages as you like. Your 5h and 7d limits sit in the footer.

Close hangar and reopen it: the bays come back and their agents start again.

<!-- screenshot: docs/hangar.png -->
![hangar with three agents running](docs/hangar.png)

---

## What a bay runs

```
claude --dangerously-skip-permissions
```

Exactly that, in the folder you picked, with your login shell's `PATH`.

**Read that flag before you use this.** It is Claude Code's own flag and it means the agent
never stops to ask: it edits files, runs commands, installs things and pushes, on its own.
That is the point of the app — nine unattended agents — and it is also nine blast radii. Point
a bay at a folder you would hand to an agent unsupervised, and not at your home directory.

The command is a constant in [`src/main.js`](src/main.js). The renderer cannot change it, and
nothing in the UI takes a command to run, so a bug in a tile cannot turn it into a shell.

## Auth and secrets

hangar has no accounts, no config, no API keys, and no network calls of its own. It spawns
your local `claude`, which authenticates itself exactly as it does in your terminal. Nothing
is sent anywhere, and there is nothing here to leak.

What it stores, in `~/Library/Application Support/hangar/state.json`: the folder paths you
picked and their titles. Nothing else. It is written atomically and the previous version is
kept beside it as `state.bak.json`; if the live file is ever unreadable hangar recovers from
the backup, keeps the bad one as `state.json.corrupt`, and refuses to write anything until
you make a deliberate change — an empty grid on screen is a display, an empty grid on disk
is your bays deleted.

## Install

Requires [Claude Code](https://claude.com/claude-code) on your `PATH` and Node 20+.

```sh
git clone https://github.com/tools-for-agents/hangar.git
cd hangar
npm install        # rebuilds node-pty against Electron — this is the slow step
npm start
```

To build a real `.app`:

```sh
npm run dist       # → dist/
```

## Using it

| | |
|---|---|
| `+` | pick a folder; the agent starts immediately |
| `⤢` | zoom this bay to the whole window (or double-click its title bar; `esc` comes back) |
| `⟳` | restart the agent in that bay |
| `✕` | stop the agent and empty the bay |
| `↗` | reveal the folder in Finder |
| page `+` | add another page of nine |
| page `✕` | close a page (hover a page tab; it asks first if agents are running) |
| `stop all` | kill every running agent |

Click into a tile and type — it is a real terminal, so `shift+tab` cycles permission modes,
`esc` interrupts, and `/` commands work.

Nine live TUIs on one screen is twelve rows each: enough to see that an agent is working,
not enough to work with it. So zoom (`⤢`, or double-click a title bar) gives one bay the
whole window and a full-height terminal; the other eight keep running behind it. Switching pages does not disturb an agent: the
process keeps running and the tile replays its output when you come back. Quitting hangar
stops every agent it started.

## Why it looks like this

Black and green, because a wall of terminals should look like terminals. The icon is the
same two colours as the window — a lit door with nine bays and one running — so the Dock
and the app say the same thing.

Colour means one thing here: **green is running.** Each bay also carries its own hue, but
only as an edge and a dot — the title stays white on near-black, because a tinted title bar
greys down the one word you scan nine of. hangar is part of
[tools-for-agents](https://github.com/tools-for-agents) and keeps the kit's 4px grid and
type scale — the palette is its own.

## The footer, and the bar that is not there

The tiles do not show Claude Code's status line. hangar hands each session a `--settings`
override whose `statusLine` command prints nothing, so the bar you would otherwise get
nine copies of — inside nine twelve-row terminals — is gone, and the two numbers it
carried are in the footer once instead.

The footer reads `claude -p "/usage"` on launch and every five minutes. That costs one
short background session per refresh and no tokens of yours beyond it; there is no API
key and nothing is sent anywhere.

### Notes for anyone reading the source

Four things in here cost real time and are worth knowing:

- **A GUI app does not have your `PATH`.** Launched from Finder, the process inherits
  `/usr/bin:/bin:/usr/sbin:/sbin` — not your shell's `PATH` — so `~/.local/bin/claude` is not
  there and `spawn claude` fails on a machine where `claude` works fine. hangar asks your login
  shell where it is, once, and caches it.
- **A `display:` rule beats `[hidden]`.** `.plus` and `.live` both set `display`, so the
  `hidden` attribute did nothing until the stylesheet said `.plus[hidden] { display: none }`
  out loud. Every empty bay painted its status header and every running bay painted a `+` over
  its terminal. Only looking at a screenshot caught it.
- **An interactive shell talks, and its chatter is on stdout.** `zsh -lic 'printf %s "$PATH"'`
  returns `Restored session: Fri Jul 17 12:22:46\n/Users/me/.local/bin:...` on macOS, because
  `/etc/zshrc_Apple_Terminal` announces itself. Taking that as `PATH` puts a newline inside the
  first entry and poisons every lookup downstream — `claude` still launched (hangar spawns it by
  absolute path) but its statusline could not resolve `node`, silently, with no error anywhere.
  hangar marks the value with a sentinel and only trusts what comes after it.
- **Claude Code does not run the statusline in a short terminal.** Measured: at 16 rows it
  runs; at 12 it is never invoked at all — and a bay in a 3×3 grid is 12 rows. The elegant
  plan (let the statusline the user already had feed the footer for free) cannot work in the
  one place it would be used. That is why the footer shells out to `claude -p "/usage"`
  instead. A statusline that never runs leaves no trace; it took a canary to see it.

## License

MIT
