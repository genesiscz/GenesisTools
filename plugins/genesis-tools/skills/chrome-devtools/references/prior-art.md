# Prior art

Three earlier bodies of work fed this tool. Know them before building anything new.

## 1. The standalone skill (now this tool)

`~/.agents/skills/chrome-devtools/` was the original: 14 bun scripts, no repo dependency.
It is now a thin pointer to `tools chrome-devtools`; the scripts moved to
`src/chrome-devtools/` in GenesisTools, hardened after the 2026-08-25 CPU-leak incident
(`arm-cpu-leak.md` is the forensics). What changed in the port:

- `arm` became `record` (hidden alias kept); `watch` split into `record` (engine) +
  `follow` (live view).
- The unbounded `/tmp/cdp-arm-<port>.jsonl` became rotating 30-minute segments with a 4-hour
  window under `/tmp/GenesisTools/ChromeDevtools/<port>/`.
- Pidfiles now carry process identity (command + start time), so pid recycling cannot fake
  a live recorder and concurrent attaches cannot stack duplicates.
- The HAR builder is a TS port of chrome-har v1.3.1 with sessionId-aware entry keying;
  parity is pinned against upstream goldens in `src/chrome-devtools/lib/har/`.

## 2. GenesisTools youtube extension harness

`src/youtube/lib/devtools/` still owns extension debugging:

```bash
tools youtube extension dev                                  # watch + chrome.runtime.reload on change
tools youtube extension devtools launch --port 9333          # browser WITH the extension loaded
tools youtube extension devtools call <tool> '<json>'
```

Go there when the work is the YouTube extension itself. `tools chrome-devtools open
--extension <dist>` covers plain extension loading; the youtube tool adds watch-reload.

The generalized pieces live here now: `mcp` verb (programmatic chrome-devtools-mcp client
against any port), `grid` verb (pixel-coordinate screenshots), `open --extension`.

## 3. Vault: extension audit harness

`GenesisBrain/GenesisTools/Youtube/ext-audit-harness/` keeps 13 page scripts from the
2026-07-27 session that found 8 bugs: `audit.js` (CSSOM missing-Tailwind-class detector),
`realclick.js` (full pointer sequence; a bare `.click()` does NOT switch Radix tabs),
`loginfill.js` (sets values through the native `HTMLInputElement.prototype.value` setter so
React's onChange fires), and others.

Its hard-won gotchas: Chrome caches the extension loaded AT LAUNCH (rebuilding and
reloading the page re-injects the OLD content script); React batches state, so read results
in a SEPARATE call; never text-grep a built bundle for Tailwind classes (escaped arbitrary
values give false negatives).

## 4. Vault: network-panel reference

Folded into this skill as `net-panel-symptoms.md`, `net-capture-settings.md`,
`net-export-recipes.md`, indexed by `net-forensics-index.md`. Route via the trigger table
in SKILL.md. Still vault-only:

- `GenesisBrain/Dev/ChromeDevTools/AutoReloadDuringDev.md`, `BackgroundHotSwap.md`
- `GenesisBrain/Claude/Bugs/PlayWright-MCP-ParallelAndChromeConflict.research.md`

## 5. Upstream chrome-har

Clone at `../_Playgrounds/chrome-har` (sitespeedio/chrome-har, MIT). The TS port's golden
fixtures came from its `test/perflogs/`. Re-generate goldens against it if the port ever
changes shape.
