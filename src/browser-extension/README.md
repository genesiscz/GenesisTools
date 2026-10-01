# browser-extension

The GenesisTools browser extension (Chrome, Brave, Chromium; Manifest V3) and the local process it
talks to. It adds buttons to GitHub and self-hosted GitLab pages (open the file at its line, open the
checkout in a terminal or in GenesisTools, explain a hunk, review a PR), runs your configured page
actions from its popup, and catches router links in the browser (see `src/browser-router`).

## How the extension talks to GenesisTools

An extension cannot run programs. Chrome's one built-in way out is **native messaging**: the
extension names a "native host", and the browser starts that program and talks to it over stdin and
stdout.

```
extension (browser)  --connectNative-->  browser starts the host  -->  host (Bun, this repo)
 background.ts                            NativeMessagingHosts/*.json   src/browser-extension/host/main.ts
                                                                              |
                                           tools <tool> ... / open -b com.genesiscz.genesistools <url>
```

1. **Registration.** `tools browser-extension install-host` writes
   `com.genesiscz.genesistools.browser_extension.json` into each browser's `NativeMessagingHosts`
   folder (for Brave: `~/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts/`).
   It names the program to start and the only extension allowed to start it: the id
   `nhjllpnekfohbnljgelfpcdfhagbojne`, pinned by the `key` in `extension/manifest.json`
   (`hostManifest()` in `lib/host/install.ts`).
2. **The launcher.** That program is `~/.genesis-tools/browser-extension/native-host.ts`, a generated
   two-line Bun script: it sets `PATH` (the one of the shell that ran `install-host`, so `git`,
   `claude`, `cmux` resolve) and imports `src/browser-extension/host/main.ts` **from this checkout**.
3. **A request.** `callNative()` in `extension/background.ts` opens one connection per request. The
   browser starts the launcher, both sides exchange JSON messages each prefixed with its 4-byte
   length (`lib/host/protocol.ts`), and the host exits when the connection closes.
4. **What the host may do.** Only the commands in `HOST_COMMANDS` (`lib/host/messages.ts`), each a
   named-parameter handler in `lib/host/dispatch.ts`; there is no command that runs a caller's argv.
   Commands that change something (config, page actions, router routes, a rebuild) are accepted only
   from the extension's own pages (`EXTENSION_PAGE_COMMANDS`), never from a content script inside a
   web page.

`tools browser-extension call <command> '<json>'` sends one request through the same dispatcher in
process, which is the quickest way to test a handler.

## How a change reaches what

| You changed | Live after |
|---|---|
| host code (`lib/**`, `host/**`) | nothing to do: every request starts a new host process, which imports the checkout's current code |
| extension code (`extension/**`) or the router's hosts (`link-host`, aliases, `dashboard-names`) | `tools browser-extension build`: it rebuilds `dist/browser-extension` and reloads the extension in the running browser over DevTools |
| the repo location, the `bun` binary, or a new directory the host's children need on `PATH` | `tools browser-extension install-host` again (it rewrites the launcher) |

Nothing is copied into `~/.genesis-tools` except that launcher. `tools browser-extension dev`
rebuilds and reloads on every save.

**When the browser has no DevTools port**, the extension notices by itself: on every browser start
it asks the host (`extension.status`) whether it is behind, and shows a `!` badge on its toolbar
icon. The popup then offers **Reload** (`dist` is newer than what runs) or **Rebuild and reload**
(the sources or router config changed since `dist` was built; the host runs the build).

How it knows: each build compiles a random build id into the bundles (`__GT_BUILD__`) and writes
`dist/browser-extension/build.json` with that id and a content stamp. The host compares that stamp
with a build of the current sources into a scratch folder.

## Commands

```bash
tools browser-extension build        # build dist, then reload in the browser (--no-reload to skip)
tools browser-extension reload       # reload in the running browser over DevTools (--port, default 9222)
tools browser-extension dev          # rebuild and reload on every change, until Ctrl-C
tools browser-extension verify       # load dist in a headless browser: worker, rules, a router link
tools browser-extension install-host # register the native host for Brave, Chrome and Chromium
tools browser-extension status       # extension id, launcher, per-browser registration
tools browser-extension config --init
```

Page features have CLI doors that run the same code as the extension: `checkout`, `open`, `hub`,
`explain`, `review`, `action`, `route`.

First install: `build`, `install-host`, then `brave://extensions` > Developer mode > Load unpacked >
`dist/browser-extension`. `tools browser-router status` and `tools doctor --only extensions` report
whether it is loaded, and an older build.

## Config

`~/.genesis-tools/browser-extension/config.json` (`tools browser-extension config --init` writes the
defaults):

- `repoRoots`: folders searched for local checkouts of a GitHub or GitLab project.
- `gitlabHosts`: self-hosted GitLab hosts (bare names, such as `gitlab.example.com`). The extension
  registers its page script there once you grant it access to that host.
- `actions`: popup buttons, each a URL match, fields read from the page by selector, and a command.

## Shared code for every GenesisTools extension

The YouTube extension (`src/youtube/extension`, built with Vite) and this one share:

- `src/utils/browser-extension/registry.ts`: both extensions (sources, `dist`, id, build and reload
  commands). An extension without a pinned `key` gets its id from its folder path;
  `unpackedExtensionId()` computes it the way the browser does.
- `src/utils/browser-extension/build-info.ts`: build id, content stamp, `build.json`, and
  `missingManifestFiles()` (a missing file makes Chrome show a blocking dialog, so every build and
  launch checks first).
- `src/utils/browser-extension/profiles.ts`: which browser profiles load an extension, and whether it
  is an older build, read from each profile's `Secure Preferences` (read-only).
- `src/utils/browser-extension/runtime/`: browser-side, no Bun: the freshness decision, and the dev
  auto-reload client (`dev-reload.ts`) with its server in `dev-reload/server.ts`. A dev build's
  worker keeps a WebSocket to the server, which says either `tabs` (re-inject the content script,
  the page stays) or `runtime` (reload the extension).
- `src/chrome-devtools/lib/extensions.ts`: `reloadExtension()` over DevTools, `launchWithExtension()`
  (headless, throwaway profile; Brave, since current Chrome ignores `--load-extension`), and
  `launchHeadedWithExtension()` (visible, with a DevTools port, for driving by hand).

Ports are never literals: a GenesisTools server's port comes from `src/utils/ui/dashboards.ts`, a
browser's DevTools port from `src/utils/net/ports.ts`.
