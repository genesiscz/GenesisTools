---
paths:
  - "src/**/*.ts"
  - "src/**/*.tsx"
  - "plugins/**"
---

# Links to GenesisTools apps, and code that needs GenesisTools

Loaded by Claude Code when you read, write or edit TypeScript under `src/` or any file under `plugins/`.

A `https://<link host>/…` link (genesis.tools here) opens something only when all of these hold on the Mac that
clicks it: GenesisTools.app is installed, macOS gives https links to it, the router config has a route for that
path, and the app or command the route names is there (Genesis Markdown for `/md/`, the `tools` CLI and cmux for
`/claude/find/`). Miss one and the click goes to the browser, onto a page that does not exist. A `genesis-md://` or
`genesis-tools://` link needs its app. Never write such a link without the check below.

- **`tools genesis-tools probe`** answers it for this Mac: the CLI, the app, the router, Genesis Markdown, cmux, and
  for each link kind (`md`, `finder`, `hub`, `claude-find`) whether a click opens it, by the real router config.
  `probe md finder` exits 1 when one of them is missing and prints the fix command; `--url <url>` checks one link;
  `--json` is for code. It reads only.
- **In `src/`**: build a link with `routerLink()` (`src/utils/browser-router/router-link.ts`), which gives the
  fallback with a coded reason when the link would be dead. The lint rule `no-raw-genesis-link` fails a literal
  anywhere else. Code that needs the whole picture calls `probeGenesisTools()` or `linkState(url, facts)` from
  `src/utils/genesis-tools/probe.ts`.
- **In a plugin**: the marketplace installs a plugin without the GenesisTools checkout, so `tools` itself may be
  missing, and a plugin file cannot import `src/`. The mods plugin asks `plugins/genesis-tools-mods/hooks/genesis.ts`:
  it runs `tools genesis-tools probe --json` once per 30 minutes (a failed spawn means no CLI, so no links and no
  `tools` commands), builds every link from the probe's link host, and returns undefined for a kind that does not
  open. A feature that runs `tools …` checks `(await genesisProbe(host)).tools` first and shows no control that
  would run it. Something that needs no router does it directly: a Finder reveal is `open -R <path>`.
- **The fallback is part of the feature.** No md link: a note gets `cursor://file<path>:<line>` or its plain path.
  No finder link: a folder stays text (a plain folder path opens nothing useful). No hub or decision link: the SHA
  or the `❓ DECISION n` stays text.
- **A new link kind** is an entry in `LinkTargets` (`src/utils/app-links/targets.ts`) and its routing in
  `router-link.ts`, a router preset that writes its route (`src/utils/browser-router/presets.ts`), and a kind in
  `GENESIS_LINK_KINDS` (`src/utils/genesis-tools/probe.ts`) plus the plugin's `LINK_KINDS`. `finder` (2026-10-23)
  was only a hand-made route on one Mac until it got its preset.
- **Ask Launch Services, not Spotlight, whether an app is installed.** `appPathForBundleId()`
  (`src/utils/macos/launch-services.ts`) is the lookup `open -b` and a scheme click use. On 2026-10-23 `mdfind
  kMDItemCFBundleIdentifier == …` found no app on a Mac with indexing on, so the genesis-md preset read "needs app"
  while Genesis Markdown opened every link.
