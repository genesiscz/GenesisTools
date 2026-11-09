# tools browser-extension

The GenesisTools browser extension (Chrome, Brave, Chromium; Manifest V3) and the local process it talks to. It adds
buttons to GitHub and self-hosted GitLab pages (open the file at its line in your editor, open the checkout in a
terminal or in GenesisTools, explain a diff hunk, review a PR with an agent), runs your own page actions from its
popup, and catches router links in the browser (see [browser-router](../browser-router/README.md)). This tool builds
the extension, registers its native host, and runs every page feature from the CLI too.

## Quick start

```bash
tools browser-extension build          # bundle the extension into dist/browser-extension in this checkout
tools browser-extension install-host   # register the native host for Brave, Chrome and Chromium
tools browser-extension status         # check the extension id, the launcher and each browser's registration
tools browser-extension config --init  # write the default config, then edit repoRoots if needed
tools browser-extension checkout https://github.com/owner/repo/pull/42   # which local checkout a page maps to
```

Then load the build once: `brave://extensions` (or `chrome://extensions`) > Developer mode > Load unpacked >
`dist/browser-extension`, and restart the browser once so it reads the host manifest. `tools browser-router status`
and `tools doctor --only extensions` report whether the extension is loaded, and whether a browser runs an older build.

## Commands

Every page command takes the page URL as the browser shows it. `--branch <name>` prefers the worktree on that branch
over the main checkout.

### Build, load and check

```bash
tools browser-extension build    # bundle into dist/browser-extension, then reload it in the browser over DevTools
tools browser-extension reload   # reload the extension in the running browser over DevTools (no click)
tools browser-extension dev      # build and reload once, then again on every change, until Ctrl-C
tools browser-extension verify   # load dist in a headless browser on a throwaway profile and check it works
```

- `build --out <dir>` writes another folder (default `<checkout>/dist/browser-extension`). A build into another
  folder never reloads the browser. `--no-reload` skips the reload. `--port <port>` is the DevTools port of the
  running browser (default `9222`).
- `reload --port <port>` (default `9222`) exits 1 when it cannot reload.
- `dev --port <port>` (default `9222`) watches `src/browser-extension/extension/` and `src/browser-extension/lib/`.
  It rebuilds once per burst of changes (300 ms quiet), runs one build at a time, and queues one more for a change
  during a build. A failed rebuild waits for the next change. When the first build fails, `dev` exits 1 and does
  not watch.
- `verify --dist <dir>` (default `<checkout>/dist/browser-extension`) prints one `ok` or `FAIL` line per check and
  exits 1 on any failure. The checks: the loopback grants are per port, the worker starts, the redirect rules install,
  and a router link reaches the route page (15 s each). It never touches your own browser.

### Native host and config

```bash
tools browser-extension install-host   # write the launcher and register it for Brave, Chrome and Chromium
tools browser-extension status         # extension id, launcher, per-browser registration, config and dist paths
tools browser-extension status --json  # the same as JSON
tools browser-extension config         # print the effective config (defaults filled in) as JSON
tools browser-extension config --init  # write the defaults when no config file exists yet
```

- `install-host` registers only the browsers whose user-data folder exists and lists the rest as skipped.
- `status` shows each browser as `registered`, `not registered`, or `registered for another id`.

### Page features (the same code the extension runs)

```bash
tools browser-extension checkout https://github.com/owner/repo
tools browser-extension open https://github.com/owner/repo/blob/main/src/app.ts#L12
tools browser-extension open https://github.com/owner/repo/pull/42 \
    --path src/app.ts \
    --line 12
tools browser-extension open https://github.com/owner/repo --terminal
tools browser-extension hub https://github.com/owner/repo/pull/42 \
    --path src/app.ts \
    --dry-run
git diff -U3 src/app.ts | tools browser-extension explain https://github.com/owner/repo/pull/42 \
    --path src/app.ts
tools browser-extension review https://github.com/owner/repo/pull/42 --dry-run
tools browser-extension action start-work-item "https://dev.example.com/org/project/_workitems/edit/42" \
    --field title="Fix the login form" \
    --dry-run
tools browser-extension route https://dashboard/
```

| Command | Flags | What it does |
|---|---|---|
| `checkout <url>` | `--branch` | JSON: the project, the page kind, and its local checkouts, best first |
| `open <url>` | `--path`, `--line`, `--branch`, `--terminal` | a file at its line in the editor, or a terminal |
| `hub <url>` | `--path`, `--branch`, `--dry-run` | the page in GenesisTools (`--dry-run` prints the target as JSON) |
| `explain <url>` | `--path`, `--line`, `--branch` | a diff hunk from stdin, explained by the headless agent |
| `review <url>` | `--branch`, `--dry-run` | an agent session that reviews the PR or MR |
| `action <id> <url>` | `--field name=value` (repeatable), `--dry-run` | one configured page action |
| `route <url>` | | a router link handed to GenesisTools.app |
| `call <command> [params]` | | one request through the host's dispatcher, in process |

- `open` takes a file page (`/blob/`) with a `#L12` or `#L12-L20` line, or a diff anchor `#diff-<hash>R12`. A PR page
  needs `--path`. A page without a file opens the checkout. The file must exist in the checkout and stay inside it
  after symlinks. A branch name with slashes in a file URL is split against the local branch names, longest first.
- `hub` selects `owner/repo#42` (GitLab: `group/project!42`) in the PRs mode, and `--path` opens that file in the PR's
  review. Any other page opens the Worktrees mode on its checkout. It never builds GenesisTools.app: an older app
  still opens, and a missing one says how to build it. It prints `Asked GenesisTools to show ...`, which means the
  app got the request, not that it found the target.
- `explain` reads the hunk from stdin (1 to 20,000 characters). The agent may read the checkout but not edit, run or
  commit, and answers in at most 12 short lines.
- `review` refuses unless `tools hub status --json` exits 0 (the GenesisTools.app review window is installed). For
  GitLab it also needs `tools gitlab pr <iid> review`. The agent follows the `gt:review-proposal` skill and is told
  never to post, approve or merge: every comment waits in the review window for you. It prints the session and the
  prompt file. `--dry-run` prints the gate and the prompt as JSON.
- `action --dry-run` prints the filled command without running it. `--field` stands in for a value the popup would
  read from the page with the action's selector.
- `route` accepts only the router's link host, its configured hosts (with no port), and the loopback address of a
  server that allows a plain browser navigation. It refuses a typed loopback address that would start its server:
  the route page does that in its own tab (`router.ensure`). It hands any other link over at once, even one that runs
  a program; only the route page asks for a click first. A link the router would only send back to the browser comes
  back as `"handled": false` and is not handed over. When `open -b com.genesiscz.genesistools` fails, it runs
  `tools browser-router open <url>` instead.
- `call ping` and `call checkout.resolve '{"url":"https://github.com/owner/repo"}'` test a handler directly. It runs
  in process, so it skips the origin check and the extension-page rule (see
  [How the extension talks to GenesisTools](#how-the-extension-talks-to-genesistools)).

## How it works

### What the extension adds

The dock appears only on a page whose project has a local checkout (see `repoRoots` and `repos` under
[Configuration](#configuration)). The other page features answer with the reason when there is none.

- **The dock** on a GitHub or granted GitLab page:
  - **Open locally** (file pages only): the file at its line in the editor.
  - **Open in GenesisTools**: a PR or MR in the hub's PRs mode, any other page in its Worktrees mode.
  - **Review with agent** (PR and MR pages only).
  - **Terminal**: a terminal at the checkout.
  - The `GT` toggle collapses the dock to a badge and remembers it. `×` hides it until the tab reloads.
- **The selection bar**, when you select at least three characters on a PR, file, folder or commit page: **Explain**,
  **Open locally**, and **Open in review** (a PR page, when the selection is inside a file of the diff).
- **The context menu** on every GitHub page and every granted GitLab page: Open in GenesisTools, Open locally in the
  editor, Open the checkout in a terminal, Explain the selected hunk, Review with agent.
- **The shortcut** `Alt+Shift+G` (`⌥⇧G`): Open in GenesisTools for the active tab. It does nothing on a tab without
  the page script (anything but GitHub or a granted GitLab host).
- **The popup** (toolbar icon): the host's state (`host 0.1.0` or `host down`), the page's project and local checkout,
  the same page buttons, your configured page actions for this URL, and an update offer when the build is behind.
- **The options page**: the config as JSON (saved through the host, which validates it), an example action, and one
  **Grant `<host>`** button per entry in `gitlabHosts`. The page script runs on a GitLab host only after that grant.
- **Router links**: link-host links, alias hosts, dashboard names and some typed loopback addresses go to the
  extension's route page before any request leaves the browser (see
  [Router links and typed loopback addresses](#router-links-and-typed-loopback-addresses)).

### Where its data lives

- `~/.genesis-tools/browser-extension/config.json`: the config (see [Configuration](#configuration)).
- `~/.genesis-tools/browser-extension/native-host.ts`: the launcher that `install-host` writes.
- `~/.genesis-tools/browser-extension/prompts/`: one file per agent session prompt (Review with agent and page
  actions), named `<time>-<kind>-<id>.md`. Page text goes only into this file; the agent's command line names the
  file and nothing else. Explain writes no file: it sends its prompt to the headless agent on stdin.
- `<checkout>/dist/browser-extension/`: the build that the browser loads, with its `build.json` (build id, content
  stamp, commit) and `router-hosts.json` (the router hosts the build catches).
- `~/Library/Application Support/<browser>/NativeMessagingHosts/com.genesiscz.genesistools.browser_extension.json`:
  one host manifest per browser. `<browser>` is `BraveSoftware/Brave-Browser`, `Google/Chrome` or `Chromium`.
- `~/.genesis-tools/logs/<day>.log`: the host's log lines (components `browser-extension/host`, `/checkout`,
  `/actions`, `/router` and others).
- Read, never written: the router config `~/.genesis-tools/browser-router/config.json`, and each browser profile's
  `Secure Preferences` (to report where the extension is loaded).

### How the extension talks to GenesisTools

An extension cannot run programs. Chrome's one built-in way out is **native messaging**: the extension names a
"native host", and the browser starts that program and talks to it over stdin and stdout.

```
extension (browser)  --connectNative-->  browser starts the host  -->  host (Bun, this repo)
 background.ts                            NativeMessagingHosts/*.json   src/browser-extension/host/main.ts
                                                                              |
                                           tools <tool> ... / open -b com.genesiscz.genesistools <url>
```

1. **Registration.** `install-host` writes `com.genesiscz.genesistools.browser_extension.json` into each browser's
   `NativeMessagingHosts` folder. It names the program to start and the only extension allowed to start it: the id
   `nhjllpnekfohbnljgelfpcdfhagbojne`, pinned by the `key` in `extension/manifest.json` (`hostManifest()` in
   `lib/host/install.ts`).
2. **The launcher.** That program is `~/.genesis-tools/browser-extension/native-host.ts`, a small generated Bun
   script. Its shebang pins the `bun` binary. It sets `PATH` to the one of the shell that ran `install-host`, so
   `git`, `claude` and `cmux` resolve, and it imports `src/browser-extension/host/main.ts` **from the checkout that
   ran `install-host`**. Browsers start a host with a bare `PATH`, which is why it is pinned.
3. **A request.** `callNative()` in `extension/background.ts` opens one connection per request. The browser starts
   the launcher, both sides exchange JSON messages each prefixed with its 4-byte length (`lib/host/protocol.ts`), and
   the host exits when the connection closes. A request may be up to 4 MiB and a reply up to 1 MiB. The extension
   waits 60 s for a reply, or 30 minutes for `hunk.explain`, `review.start`, `action.run` and `router.route`.
4. **Who may call.** The host answers only when the browser names the pinned extension as the caller
   (`host/main.ts`).
5. **What the host may do.** Only the commands in `HOST_COMMANDS` (`lib/host/messages.ts`), each a named-parameter
   handler in `lib/host/dispatch.ts`; there is no command that runs a caller's argv. Commands that change something
   (config, page actions, router routes, a rebuild) are accepted only from the extension's own pages
   (`EXTENSION_PAGE_COMMANDS`), never from a content script inside a web page.

Values from a page are checked before they reach a command (`lib/values.ts`): 1 to 200 printable characters, never
starting with `-`, a positive line number, and a plain repository-relative path (no `..`, no leading `/`). A branch
name may hold only ASCII letters, digits, `.`, `_`, `/` and `-` (up to 200), with no `..` or `//`, no leading `-`
or `/`, and no trailing `.` or `/`; `--branch` refuses any other name with "branch is not a valid branch name". A
`{name}` placeholder fills exactly one argv element, and nothing runs through a shell. An argv that starts with
`tools` runs through GenesisTools' own `execTool`, never a bare `PATH` lookup.

### Router links and typed loopback addresses

The worker installs redirect rules (`main_frame` only) that send a navigation to the route page (`extension/route.ts`)
before any request leaves the browser: the router's link host, its alias hosts and dashboard names (from the build's
`router-hosts.json`), and typed `http://localhost:<port>` and `http://127.0.0.1:<port>` addresses of registered
servers.

A router host without a dot (a dashboard name such as `dashboard`) typed alone in the address bar is a search, not a
URL. When a search on Google (`google.com`, `google.cz`), Brave Search, DuckDuckGo or Bing has exactly that name as
its whole query, the extension opens the route page for `http://<name>/` instead.

A typed loopback address, or a dashboard name such as `https://artifact-library/`, starts its server only when the
router config's `service` routes for that port carry `allowExecuteByPlainBrowserNavigationMightBeDangerous: true`
(`tools browser-router presets sync` copies it from `src/utils/ui/dashboards.ts`: every dashboard has it, no web
service does). A page can move the top frame without the user meaning to start a process, so that flag is the only
authorization, and it is read live:

- The worker downloads the service list from the host (`router.services`) when it starts (at most once per
  5 minutes, since a worker wakes for every tab load) and again on every navigation the route page decides. It
  catches only the ports whose downloaded flag is true AND whose two origins this build was granted. A navigation
  started by a page on a loopback origin (a dashboard's own links) is not caught.
- The host checks again: `router.ensure` re-parses the URL, asks the router, and runs
  `tools browser-router ensure <port>` only when the live entry for that exact port is true. Something already
  listening is left alone. The route page then continues to `http://localhost:<port>` plus the path in the same tab
  (one tab, the exact URL, 30 s), and never hands the URL to GenesisTools.app, which would open a second tab. A server
  that does not come up shows the error with its log path, and the dead page is not opened.
- A port whose flag is false is not caught, or loads as typed, and is never started from the browser. An external
  click (GenesisTools.app, the OS handler) is a different trigger and still starts it. A dashboard name whose flag is
  false waits for a click on the route page.
- Only `http:` with the host `localhost` or `127.0.0.1` written out literally, with a port, counts: no https,
  userinfo, trailing dot, suffix host, `127.0.0.2`, `0.0.0.0`, `[::1]` or `2130706433` (`lib/loopback.ts`).

The build grants `http://127.0.0.1:<port>/*` and `http://localhost:<port>/*` only for ports whose flag is true at
build time, never a loopback wildcard (that would let the extension fetch the AI proxy and the MCP gateway). A flag
flipped to false stops the start on the next download, with no rebuild; one flipped to true is caught after the next
`tools browser-extension build`. `tools browser-extension verify` checks the grants.

What the route page does with any other link it catches:

- A link the router would only send back to this browser: it says so and offers a one-time "continue" to the public
  site. That bypass covers this tab only and ends when the tab's next load completes, the tab closes, or 30 s pass.
- A link whose route runs a program or a tool: it shows what runs and waits for a click on **Run**.
- Any other routed link: it hands the link to GenesisTools.app, then goes back (or closes the tab) after 1.5 s.
- A link that GenesisTools.app sends straight back (within 5 s), or a tab that was just continued to the same address
  and came back (within 2 s), is not handed over again: the page names the `tools browser-router` commands to run.
- The route page refuses to work inside a frame.

### Is the running build current?

When the browser has no DevTools port, the extension notices by itself: on every browser start it asks the host
(`extension.status`) whether it is behind, and shows a `!` badge on its toolbar icon. The popup then offers **Reload**
(`dist` is newer than what runs) or **Rebuild and reload** (the sources or router config changed since `dist` was
built; the host runs the build), with the commits in between when it can count them.

How it knows: each build compiles a random build id into the bundles (`__GT_BUILD__`) and writes
`dist/browser-extension/build.json` with that id and a content stamp. The host compares that stamp with a build of
the current sources into a scratch folder.

### What it needs, and what costs money

- macOS, Bun, and Brave, Chrome or Chromium 120 or later.
- The editor driver is Cursor and the terminal driver is cmux; they are the only drivers today.
- GenesisTools.app for **Open in GenesisTools**, for router links, and (with its review window) for **Review with
  agent**.
- `verify` needs Brave or Chromium installed, since current Google Chrome ignores `--load-extension`.
- `reload`, and the reload after `build` and in `dev`, need a browser that serves DevTools on the port.
- **Explain** and **Review with agent** run a Claude Code agent through `tools claude run --autopick`, which picks the
  saved Claude account with the most headroom and uses its quota. Page actions run the commands you configure. A
  page action also opens an agent session with `agent.interactive` unless it sets `"session": false`.

### Developing the extension

How a change reaches the browser:

- **Host code** (`lib/**`, `host/**`): live in the host at once. Every request starts a new host process, which
  imports the checkout's current code. `lib/page-url.ts`, `lib/loopback.ts` and `lib/host/messages.ts` are also
  bundled into the extension, so a change there also needs `tools browser-extension build` (`dev` watches `lib/`
  for that reason).
- **Extension code** (`extension/**`), or the router's hosts (`link-host`, aliases, `dashboard-names`): live after
  `tools browser-extension build`, which rebuilds `dist` and reloads the extension over DevTools.
- **The repo location, the `bun` binary, or a new folder the host's children need on `PATH`**: live after
  `tools browser-extension install-host` again, which rewrites the launcher.

No code is copied into `~/.genesis-tools` except that launcher. `tools browser-extension dev` rebuilds and reloads
on every save.

Shared code for every GenesisTools extension. The YouTube extension (`src/youtube/extension`, built with Vite) and
this one share:

- `src/utils/browser-extension/registry.ts`: both extensions (sources, `dist`, id, build and reload commands). An
  extension without a pinned `key` gets its id from its folder path; `unpackedExtensionId()` computes it the way the
  browser does.
- `src/utils/browser-extension/build-info.ts`: build id, content stamp, `build.json`, and `missingManifestFiles()`
  (a missing file makes Chrome show a blocking dialog, so every build and launch checks first).
- `src/utils/browser-extension/profiles.ts`: which browser profiles load an extension, and whether it is an older
  build, read from each profile's `Secure Preferences` (read-only).
- `src/utils/browser-extension/runtime/`: browser-side, no Bun: the freshness decision, and the dev auto-reload
  client (`dev-reload.ts`) with its server in `src/utils/browser-extension/dev-reload/server.ts`. A dev build's worker
  keeps a WebSocket to the server, which says either `tabs` (re-inject the content script, the page stays) or
  `runtime` (reload the extension). The YouTube extension uses it; this one reloads over DevTools instead.
- `src/chrome-devtools/lib/extensions.ts`: `reloadExtension()` over DevTools, `launchWithExtension()` (headless,
  throwaway profile; Brave first, since current Chrome ignores `--load-extension`), and
  `launchHeadedWithExtension()` (visible, with a DevTools port, for driving by hand).

Ports are never literals: a GenesisTools server's port comes from `src/utils/ui/dashboards.ts`, a browser's DevTools
port from `src/utils/net/ports.ts`.

## Configuration

`~/.genesis-tools/browser-extension/config.json`. `config --init` writes the defaults, and the options page edits the
same file. A missing key takes its default. A file that does not validate makes `config` and every page feature
fail with the reason.

| Key | Default | Meaning |
|---|---|---|
| `version` | `1` | the only version |
| `repoRoots` | the parent of the main GenesisTools checkout | folders scanned 3 levels deep for checkouts, worktrees |
| `repos` | `{}` | project web URL to local folder, for checkouts outside `repoRoots`; wins over the scan |
| `gitlabHosts` | `[]` | self-hosted GitLab hosts as bare names (`gitlab.example.com`, a port is allowed) |
| `editor` | `"cursor"` | editor driver for Open locally |
| `terminal` | `"cmux"` | terminal driver for Terminal and agent sessions |
| `agent.interactive` | `tools claude run --autopick --` | argv of the session agent; the prompt sentence is appended |
| `agent.headless` | the same, plus `-p --allowedTools Read,Grep,Glob` | argv of the explain agent; prompt on stdin |
| `agent.headlessTimeoutMs` | `180000` | explain timeout, at least 5000 |
| `actions` | `[]` | the popup's page actions, below |

The CLI treats any host whose name contains `gitlab` as GitLab without a `gitlabHosts` entry. The page buttons
appear only on hosts in `gitlabHosts` that you granted on the options page.

The interactive agent gets one prompt sentence, `Read the task in <file> and do it.`, and a plain `claude` works in
`agent` too when that CLI is logged in by itself.

### Page actions

A page action is a popup button for pages whose URL matches a pattern. It reads values from the URL and the page,
runs a command in a folder, and then (by default) opens an agent session in a terminal.

```json
{
    "actions": [
        {
            "id": "start-work-item",
            "label": "Start branch + session",
            "match": "^https://dev\\.example\\.com/org/project/_workitems/edit/(?<id>\\d+)",
            "fields": { "title": { "selector": "input[aria-label='Title']", "property": "value" } },
            "cwd": "~/Projects/app",
            "command": ["./scripts/worktree-init.sh", "{id}", "{title}"],
            "sessionCwd": "{stdoutLastLine}",
            "prompt": "Work item {id}: {title}. Read it and propose a plan."
        }
    ]
}
```

- `id`: unique, lowercase letters, digits and dashes (up to 64).
- `label`: the button text and the session title; it may use placeholders.
- `match`: a regular expression over the page URL. Named groups (`(?<id>\d+)`) become values.
- `fields`: values the popup reads from the page. A field name is letters and digits, starts with a letter, and has
  at most 32 characters; any other name fails with `"<name>" must be letters and digits`. `selector` is a CSS
  selector, `property` is `textContent` (default), `value` or `attr:<name>`, and `pattern` is an anchored regular
  expression the value must match.
- `cwd`: an existing folder the command runs in; `~` is expanded.
- `command` (optional): an argv template. `{name}` fills one element and never splits it. The command must exit 0.
  An action without `command` only opens the agent session.
- `sessionCwd`: the session's folder, default `{cwd}`. `{stdoutLastLine}` is the last non-empty line the command
  printed, so a script can print the worktree it created.
- `prompt`: the session's first prompt, default `Page: {url}`. It is written to a file, never onto a command line.
- `session`: `false` skips the agent session (default `true`).
- `timeoutMs`: the command's timeout, at least 1000, default `120000`.

Placeholders may name a URL group, a field, or the built-in values `url`, `cwd` and `stdoutLastLine`. A group or field
cannot take a built-in name, and an unknown placeholder fails when the config is saved, before anything runs.

### Environment

- `GENESIS_TOOLS_HOME` puts `.genesis-tools` under another home folder (tests use it). The launcher does not set it.
- `PATH`: the launcher keeps the one from `install-host`, so run `install-host` again after you change your `PATH`.

## For agents

- JSON on stdout: `status --json`, `config`, `checkout`, `hub --dry-run`, `review --dry-run`, `action`, `route` and
  `call`. The other commands print text.
- Exit code 1 on any failure, with the reason on stderr. `call` exits 1 when the reply is `"ok": false`, and `verify`
  when any check fails.
- A host reply is `{"ok": true, "data": ...}` or `{"ok": false, "code": ..., "error": ...}`. The codes: `invalid`,
  `no-checkout`, `unavailable` (a review gate, the router), `failed`, `unknown-command`, `too-large`.
- The host commands (`call <command>`): `ping`, `config.get`, `config.set`, `checkout.resolve`, `open.file`,
  `open.terminal`, `hub.open`, `hunk.explain`, `review.start`, `action.run`, `router.explain`, `router.route`,
  `router.services`, `router.ensure`, `extension.status`, `extension.build`.
- Use `--dry-run` on `hub`, `review` and `action` to see what would happen without opening or starting anything.
- There is no MCP tool and no plugin skill for this tool.

## Troubleshooting

- **The popup says `host down`, or a button fails with "Run: tools browser-extension install-host".** The native host
  is not registered for this browser, or the launcher is missing. Run `tools browser-extension install-host`, then
  restart the browser.
- **`status` says `registered for another id`.** That browser's host manifest allows another extension id. Run
  `install-host` again.
- **No dock on a GitHub page.** The page's project has no local checkout. `tools browser-extension checkout <url>`
  says where it looked; clone the project under a `repoRoots` folder, or map it in `repos`.
- **"... has this name but its origin is ..."** A checkout with the project's name has another owner in its
  `origin`: the repository most likely moved on the forge, which keeps redirecting git. Run
  `git -C <checkout> remote set-url origin <the new URL>`.
- **No dock on a self-hosted GitLab page.** Add the host to `gitlabHosts`, then click **Grant `<host>`** on the
  options page.
- **The browser runs your old code.** A `!` badge on the toolbar icon means the build is behind: click **Reload** or
  **Rebuild and reload** in the popup. `build` prints "Reload ... by hand: brave://extensions > Reload" when the
  browser serves no DevTools port.
- **The browser still runs host code from another checkout or worktree.** The launcher imports the host from the
  checkout that ran `install-host`. Run `install-host` from the checkout you want the browser to use.
- **A typed `http://localhost:<port>` loads as typed and does not start its server.** That port's flag is false, or
  this build was made before the flag was true. Run `tools browser-router presets sync`, then
  `tools browser-extension build`.
- **The route page says GenesisTools.app sent the link straight back.** The app did not route it. Run
  `tools browser-router status` and `tools browser-router explain <url>`.
- **Review with agent refuses.** The message names the gate: the GenesisTools.app review window is not installed
  (`tools hub status` exits 1), or `tools gitlab pr <iid> review` is not available for a GitLab MR.
- **A page action fails.** The message names the failing value (`title must be 1 to 200 printable characters`,
  `title must not start with "-"`, `title does not match ...`) or the command (`<command> exited <code>: <stderr>`).
  Try it with `tools browser-extension action <id> <url> --field name=value --dry-run`.
- **`verify` fails at "worker starts".** Brave or Chromium must be installed, and the build must load. Run `build`
  again and read its errors.
- **Anything else.** Read `~/.genesis-tools/logs/<today>.log` and search it for `browser-extension`. A page without
  a local checkout is logged at info level, not as a warning.

## Related

- [browser-router](../browser-router/README.md): the router config, link host, presets and `ensure` behind router
  links.
- [hub](../hub/README.md): the GenesisTools window that Open in GenesisTools and Review with agent open.
- [chrome-devtools](../chrome-devtools/README.md): the DevTools library behind `reload`, `dev` and `verify`.
- [doctor](../doctor/README.md): `tools doctor --only extensions` reports both GenesisTools extensions.
- [youtube](../youtube/README.md): the other GenesisTools extension, which shares the extension utilities.
- [claude](../claude/README.md): `tools claude run --autopick`, the default agent.
- [github](../github/README.md) and [gitlab](../gitlab/README.md): the review facts the review agent reads.
