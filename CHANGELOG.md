# Changelog

All notable changes to GenesisTools will be documented in this file.

Version format: `YYYY.MM.DD.revision` (e.g., `2026.02.18.1`)

## 2026.10.23.1

2063 commits since 2026.09.04.1. User-visible changes only.

### hub (new)

- Added `tools hub`: one door for repo facts, PRs and review proposals, with `tools hub pr` for GitHub and GitLab (find, threads, reply, draft, resolve, publish), PR checks with the failing step's log, PR sessions and a PR head fetch without a worktree
- Added a resident `tools hub serve` that answers the app and its tools over a unix socket, so transcripts, agents, counts, forecasts, inbox reads, repo facts and usage sessions no longer start a Bun process each, and the usage daemon starts it when nothing listens
- Added `tools hub agents`, which lists every session's sub-agents, teammates and workers live (Codex sub-agents included) and marks a session an agent process holds as open
- Added session insights (per-prompt cost timeline, tool-call analytics), a stuck-agent detector, a handoff composer, an agent process monitor with orphan detection and a guarded stop, PR review readiness, a prompt library, digest, forecast, rules and transcript search
- Added PR notifications as a daemon task: each watched repo polls at its own cadence inside a one-minute tick, with a review-requested event posted once when a review is newly requested on GitHub or GitLab
- Added `tools hub dev monitor`, which streams the app's hangs, stalls, layout loops, link-relay trouble and crash reports in batches for the Monitor tool, and every `tools` run now writes a `[profile:cli]` line with wall time, CPU, memory and caller
- Added `tools hub open --commit` with `--pr` or `--repo`, so an agent can write every commit sha as a link into the hub
- Added PR list search and paging, hub reads that answer fresh unless `--max-cache-age` allows a cached one, `pr show` finding a PR page's local checkout, and `pr projects` listing every cloned forge project
- Fixed worktree move-aside so two concurrent moves or another local user can never win the same destination, and a PR write is never reported failed after it reached the remote
- Improved hub performance: one read resolves every watched session for the stuck check (234 to 31 ms CPU), and the notify tick reads git facts only for repos whose cadence has come

### markdown (new)

- Added the Genesis Markdown viewer inside GenesisKit, opened by GenesisTools as its `--markdown` face, with a vault index, tabs, outline, image hover previews and code-editor colouring
- Added git in the viewer: branch and state in the status bar, a change gutter against HEAD, a Changes mode per scope with a resizable git sidebar and git marks in the file tree
- Added file tree navigation: back and forward, a parent-folder link in the header, a "+" menu that names the target folder and "Show in Sidebar" that glides to the row
- Added `tools markdown resolve`, which writes `{{kind}}` include tokens into notes as refreshable excerpts, with private atomic backups that keep the note's mode
- Improved viewer performance: the file tree is an AppKit table (a third of the CPU when scrolling), the tab switch fades with Core Animation, and the folder watcher takes folder events so a build costs one path per changed folder
- Fixed code fences that need matching closing markers and Reduce Motion in the file tree

### browser-router (new)

- Added routing of links through GenesisTools.app with token locks, dead localhost links that start their server, one link that opens a tab bundle and status that reports preset drift
- Added configurable link hosts, installable presets, short-host dashboards with aliases, a `--browser` option so a Safari web app signs in itself, and a `routes` table with each preset's availability
- Added a `genesis-hub` preset that opens a hub link where only https is clickable
- Fixed the `genesis-md` preset to find Genesis Markdown by bundle id, and presets now warn when a chosen preset is unavailable

### browser-extension (new)

- Added the GenesisTools browser extension with a native host bridge to `tools`, and a shared layer for every GenesisTools extension with a stale-build badge and a verified route handoff
- Added "Open in GenesisTools", which shows a PR, its file or the checkout from the dock, popup, context menu or Alt+Shift+G
- Improved the popup and options cards with the dashboards' amber to cyan gradient, hidden empty sections and an update that names the commits it carries
- Added `tools doctor` reports of each extension's build and load state

### computer-use (new)

- Added an independent native stack for scripted desktop control, built on a native accessibility binary (`ax-tool`) that observes, acts and records
- Added `tools control` with an observe, act and readback contract, an admission gate, fan-out observe, whole-window scope and a plan runner that is scriptable
- Added an independent cursor, a drag that survives its own target moving, and `act --action drag --allow-outside` for dragging a window by its body or past its edge
- Added background actions that never take the user's focus: clicks, right-clicks, scroll with human-like trackpad phases, and filling a field
- Added driving of the iOS Simulator through the same observe, act and readback contract as macOS
- Added a ScreenCaptureKit recorder with isolated recorded windows, alpha and a border that frames only recorded windows
- Fixed the cursor label so it hides keys and text typed into a password field, and a right-click reports ok only when a menu is seen opening

### gitlab (new)

- Added `tools gitlab`, a GitLab client for any instance, with `gitlab pr <iid> review|comments|labels`, receive and give review modes, and threads read by sha
- Added review gates with `{tests}`, config-driven fetch-review, an impact scan, file links with line ranges, anchored drafts through the MR diff, image uploads and full pending drafts
- Added a judgements JSON check that reports misplaced keys and wrong types, and `review render` that links backticked paths
- Fixed `review --receive` and the skeleton to list plain MR comments written by someone else, so they agree with `comments list --unresolved`
- Fixed review id maps and posting ledgers to be refused when unreadable and to be partitioned by host and project, so ids never renumber and comments never post twice
- Fixed `draft-reply` to check the anchor or thread before uploading, and fixed every response body to parse strictly

### jev (new)

- Added `tools jev`, a command surface and dashboard over a shared evaluation layer, with a lab, an arena, a demo reel and a Probably Lang lab
- Added `jev route`, the goal loop, `watch` and the wake gate, plus `jev look`, which picks one OCR region for an intent
- Added `tools jev grep`, a budgeted search with a cache, evaluator, retrieval, MCP tool, API route and skill
- Added a browser surface that drives pages through the chrome-devtools page agent, with every run recorded for `tools jev replay`
- Added listening on a browser page over CDP, and made `typesafe` the default evaluation provider, with choices over 255 options run as a tournament
- Improved speed by overlapping independent suggestion batches, loading the dashboard server graph only when the dashboard opens, and limiting the app-list reads
- Fixed the wake gate to copy an unreadable `wake.json` aside before rewriting it

### compress (new)

- Added `tools compress`, which packs, unpacks, verifies, trials presets and searches a ledger, and skips data that a trial saves under 30% on
- Added a zstd toolset with seekable frames, folder archives and retention, read frame by frame because Bun 1.3.13 stops after one frame
- Added a once-a-day background pass that turns day logs and ai-proxy transcripts older than yesterday into seekable `.zst`, with every reader opening either form
- Improved speed by keeping the frame walker on Bun 1.4.x, and by keeping day logs plain for a week
- Added read-path, restore and preset benchmarks, and lowered binary and database presets to level 3

### ts (new)

- Added `tools ts skeleton`, which prints a file's API, its types, coverage and token stats, with `--rank`, `--max-tokens` and `--files-only` to order and budget files
- Added `tools ts duplicates` and `tools ts refactors` for finding repeated code and ranking refactor candidates
- Added `tools ts imports analyze|lazy|barrels|cycles`, which measures per-module import cost with attribution
- Added `tools ts profile`, which runs an entry under `bun --cpu-prof` and prints hot functions, call trees and per-thread busy work
- Added `tools ts sourcemaps`, which maps a deployed minified position to source for webpack, rsbuild, Vite and esbuild builds and finds the deployed commit by content
- Fixed a quoted glob argument to expand to its source files, and fixed a deployment identical to the base build to score as a perfect sourcemap match

### jenkins (new)

- Added `tools jenkins`, a REST CLI beside the MCP server, with TLS bail-out using PEM folders, monitor summaries and build URL parsing
- Fixed upstream-cause matching, trigger counting, stop ranges and rebuild numbers so malformed input is refused before anything is sent
- Fixed credentials to go only to the configured Jenkins, and stopped any automatic retry of a POST
- Fixed whole-build log fetch with cache reuse, `--grep` and alias resolution, and added a one-time login instead of three exported variables

### json2md (new)

- Added `tools json2md`, which renders JSON as Markdown with hand-edit detection and runtime validation of `defineDocument`
- Added `{{kind}}` token resolution in document builds
- Fixed `init` to refuse a `--data` path that does not exist, and fixed `--bullet` to be a closed enum

### domains (new)

- Added `tools domains`, which finds a domain name you can register at a normal price
- Changed `--ai` to pick a subscription account before a paid one and to warn when it must spend money

### services (new)

- Added `tools services`, which lists, restarts and idle-stops long-running servers and signals only verified pids
- Added `services up` and `services down` to start and stop every registered server
- Added notifications and step-by-step debug logs to the idle reaper, and gave its daemon task a 10 second timeout
- Fixed a netstat that does not parse to fall back to lsof instead of reading as idle

### video (new)

- Added timestamped frame evidence with difference review, and sampling of selected moments at their original timestamps
- Fixed evidence frames above 100 samples, which the ffmpeg parser had refused

### voice (new)

- Added cancellable dictation that needs no agent runtime, private text transforms through saved AI accounts, and safe account and model choices
- Fixed setup cancellation to be awaited and recording duration to be validated, and made permissions requested only through the elected owner

### node-repl (new)

- Added `tools node-repl`, a persistent node REPL with an MCP door, so a session keeps its bindings between calls

### link (new)

- Added `tools link`, which resolves `@genesiscz/utils` from outside the checkout

### wisprflow (new)

- Added `tools wisprflow`: a meetings, notes and calendar CLI with local speaker names and fixes for misheard terms

### GenesisHub

- Added the macOS agent hub with a review window and diff viewer: Inbox, Activity, PR and Agents modes, back and forward, a command palette (also from a button beside the gear), find in files, reorderable groups and worktree cleanup
- Added a live session screen: the open transcript follows the agent at work, shows what it does now, renders Edit and Write as diffs, and has Changes, Files and Decisions tabs and a context-window chart
- Added review window improvements: every review lives in one process so window cycling works, stored agent reviews attach by themselves, and the threads list shows the agent's proposed reply with its verdict
- Added optional app parts: a build makes only the installed parts, `tools hub` adds the hub, and Clicky and the hub no longer need each other because settings pages are plug-ins of each part
- Added a Settings window with Clicky, Widgets, Focus and Hub sections, an opt-in Native window style that follows General theme, four darker themes (Graphite, Midnight, Smoked glass, Dusk) and View > Look
- Added PR activity notification settings per project and a Background > Daemon page that shows every task's state, runs and output and edits its schedule
- Added PR and commit links that open any checked-out project or fork, with commit ranges and upstream paths, and a commit link that opens its PR with that commit selected
- Added a link relay journal, a windowless relay that stops links from activating hub windows, and fixes so local .html files open in the real browser and links reach the router in every window face
- Improved build and permission handling: live `swift build` progress, a build that keeps the installed app's signing identity, a notification when the keychain dialog stalls a build, and `codesign-trust` that ends the prompts for good
- Improved performance: the transcript, skeleton and working dots animate as Core Animation layers, a spare diff renderer is prepared in a quiet moment, polls pause while the hub is hidden, and a PR opens with its detail, threads and head fetched at once
- Fixed many PR view issues: stale PR caches, a missing host CLI reading as 'gh exited 127', GitLab drafts losing their first-seen time, and a 115 s layout freeze on the PRs view

### Widget

- Added the native notch and side widget with live agent details on hover, animated edge panels, modules and session details, and a shared module registry with independent layouts per edge
- Added a media inbox with real thumbnails and previews for every image and video, video range selection, a capture shelf, and agent messages and screenshots from Claude, Codex and Grok in the inbox
- Added tasks that tick, add and edit in place, a decision ledger, durable inbox notification badges, unread counts on side-rail agents and replies delivered to the original Claude session through native peer sockets
- Added private voice notes with record, review and microphone permission errors, plus Focus and voice drafts connected to the shared runtime
- Added a setting that shows the top and side panels only after "Show the widget" is turned on (default off), and a passive test mode that opens panels without taking the keyboard
- Improved widget performance: panels open and close with a Core Animation outline, the working ring spins as a Core Animation layer (24% to 2% CPU), and session rosters refresh in a resident worker instead of a process every 16 s
- Fixed panel anchoring, hover intent, notch shoulders, top controls above the menu bar and short-display rail controls during expansion

### GenesisKit

- Added GenesisKitBase, a small library without external packages that a host-only app build links alone
- Added keyboard shortcuts as data with one keymap per app, so the viewer, hub, widget, Clicky and image viewer read their keys from it
- Added an image viewer that grows from the picture, zooms at the pointer, steps through a note and compares two images with a slider
- Added one permission dialog for every missing grant, a shared audit line for every permission gate, and Local Network as a permission kind that `tools macos permissions` shows
- Added building blocks for PostureWatcher and the Disk Manager: settings rows, bounded zoomable charts, matrix heatmaps, background tools runs, alerts and screen effects
- Added posture improvements: 3D shoulders, debug reports, tracking of the person nearest the camera, and forward-head detection that needs the face to grow
- Added GenMotion curve animation for settings sections, file trees, the cmux pane picker, session lists, Focus Studio and Flow history, and skeletons shaped like the result instead of spinners
- Added a shared file tree with off-main folder reads, flat lazy rows and Finder's file verbs, and `DefaultApp`, which opens a file at a line through `cursor://` or `vscode://`
- Improved transcript performance: the server client splits reply lines in linear time (an 8 MB line took 3.8 s), wrapped code blocks share converted text, and a cancelled server call stops at once on the server
- Fixed the transcript's "N new" pill, live follow and row anchor so they never fight the reader's scroll

### GenesisTools.app

- Added review window features: PR threads in the diff with reply, draft and resolve, markdown thread notes with linked commits, keyboard review, one Changes panel for many roots, and large diffs on one page
- Added a scope menu that picks the worktree and the PR's own diff, a Split or Unified button that persists, a drafts list with Next draft, and a forge badge with the author's avatar
- Added an orange Reload that says who pushed what, and comparison of two pushes without a rebase's upstream noise
- Improved review scrolling: the reader's line stays in place when the diff refreshes, the sticky file header stays above the rows, and threads appear without the 1.4 second spring stall
- Fixed review comment queues so a failed write is kept and edits are never replayed over newer ones
- Added Flow fixes for recorder and dictation ownership, private transcript removal, and credential reads limited to private files
- Added build identity recorded for the native preview

### Clicky

- Added a sound library shipped as a release asset, downloadable on request, with validation of external libraries and paired key samples
- Added interactive activity, key and rhythm dashboards with bounded activity buckets, physical key counts, typing-burst measurement and dictation savings estimates
- Added honest history recovery: unreadable typing history is preserved until an explicit reset and restored data can be retried
- Added actionable permission and quiet settings, shared native settings themes and activation banners while settings is open
- Fixed a settings snapshot so it never stores a recovery copy or migrated appearance keys
- Improved typing reports by preparing them off the main thread

### macos

- Added `tools macos eslogger`, which replaces `tools macos-eslogger` and reads the real eslogger schema
- Added `tools macos mail open`, a reminders doctor, one `macos doctor` pass and `permissions request`, which prompts and waits
- Added JSON output for clones reclaim apply, optimize apply and rollback, presets, config and daemon status, plus `clones --targets all`, size flags with units and `--worktrees-of`
- Improved app builds: privacy grants survive a rebuild, retired bundles are kept (the newest two as folders, the rest packed as zst) and incremental builds are faster
- Fixed the mail index so it no longer decrypts every account token and raises the vault-key approval
- Fixed one Dock icon for the app, and review, settings and link-relay faces are accessory apps

### ai

- Added the accounts core: `tools ai accounts login|logout|discover|list|show|who`, one provider plugin contract, one browser login flow shared by Anthropic, Codex and Grok, and claude, codex, grok, ai-proxy and ask as thin doors onto it
- Added one usage and spend system across claude, codex and grok: provider-neutral limits store, poll daemon with timed tick phases, one dashboard behind `tools ai|claude|codex|grok usage`, per-account billing anchors, renewal warnings and a prompt-cache clock on session rows
- Added one session list, one SQLite history index and one history CLI for every agent, with a single search path, a bounded content fallback and native transcripts as the source of truth
- Added `tools ai sessions` transcript features: sub-agent trees, whole spawn prompts, a live follow with an activity line (thinking, open tool call, waiting, idle), questions taken from each agent's question tool, a turn index for large sessions and a measured context size on each turn's cost
- Added `tools ai statusline`, an in-process Claude Code statusline at a tenth of the cost, `tools ai gate` with a Touch ID approval window, and a vault approval window in GenesisTools.app that shows why, what, who and which session
- Added one warmup for every provider (`tools ai|claude|codex|grok warmup`) that names why an account is refused, and automatic account picking by usage room (Claude first, then Codex, then Grok)
- Added Claude Haiku 5.5, Sonnet 5.5, Opus 5.5, GPT-6 Sol and Luna, GPT-5.6 Terra and Luna, GPT-6.1 Sol and grok-4.7 with their prices
- Improved session listing, discovery and transcript parsing: warm listings dropped from about 170-190 ms to about 110-120 ms, a 163 MB live rollout re-reads in 1-5 ms instead of 200 ms, and large sessions fold with bounded memory
- Fixed secrets and config safety: the master key, vault exports, account auth files, `~/.claude.json` and statusline settings are written atomically with backups, and a file that does not parse is never saved over
- Fixed usage polling: an account with no credential is no longer polled, a failing account warns once per streak, and a bad reset time or missing percent no longer crashes a renderer

### codex

- Added `tools codex migrate-home`, which unions other Codex homes into one, is dry-run by default, confirms with a danger prompt before any write and packs older backup runs into zst files
- Added patching of the Codex desktop app to show full tool output, with versioned backups and a safe lock
- Added warnings from `tools codex spawn` about what the sandbox stops, a `--write full` mode that is refused in a main checkout, and `--project` to file a worker's thread under a Codex Desktop project
- Added exact session targets for queue and steer, and made a Codex turn that ended on an API error report as failed with exit 4
- Added account-bound native terminals launched out of one shared home and a callback server for the Codex login on port 1455, so the browser no longer lands on an error page
- Fixed ask workers: read-only commands (including globs and escaped regexes) no longer wait for the lead, and file-change approvals name the files they write
- Fixed `tools codex tail`, `logs` and `wait`: `--tail 0` prints no past event, turns are numbered, a spawned worker's thread is followed, and app-server errors keep their nested message and code

### claude

- Added `tools claude run` account auto-pick and `--sdk`, which acts as the claude binary for apps that embed Claude Code
- Added `tools claude decide`, which records a decision in the session's log, and `tools claude anchor` for a billing anchor per account
- Added attestation of the sending session and its permission mode to `tools claude message`, with `--wait` acknowledging the send at once
- Improved the session list: the message count is the real line count, a cached tail usage is kept while a file is unchanged (1,136 ms to 591 ms of CPU), and a transcript moved by `/compact` reports where it continued
- Fixed focus, send and `who` after a cmux relaunch by joining on surface, workspace, pane and window UUIDs instead of refs
- Fixed `tools claude info` so reading account names no longer makes macOS ask about the vault key, and `tools claude start -m` passes a newer claude-* id through with a warning

### ai-spend

- Added a worker cost ledger: every worker turn books its price, login and label, its report prints one cost line, and `tools ai-spend workers` reads worker spend with `--backfill` and `--reprice`
- Added accounts as a dimension of transcript spend on the monitor, series and ccusage reports, with a series API, an incremental event cache and context-tier pricing
- Improved the monitor and reports: they report yesterday and the last 7 days, read only their window, load sources in parallel and write the event cache only when it changed
- Fixed pricing: Grok prices at xAI list rates, Claude one-hour cache writes bill at 2x input, and LiteLLM falls back only to the same model under another provider path or release date
- Fixed Codex counting: a call is counted once, a new turn ends mirror pairing, and a usage-less record no longer silences token counts

### ai-proxy

- Added `@account/<id>:<model>` refs for chat, realtime and speech-to-text on the account's own credential
- Fixed `clients add` so a failed add rolls its vault key back under the config lock, and a name conflict or invalid config is reported as itself
- Fixed subscription handling: structured calls rebuild responses, body reads are bounded by an idle deadline, WHAM SSE frames end at CR, LF or CRLF, and inspecting accounts never refreshes grants
- Fixed the cloudflared tunnel rule so a bare `/ai` stops swallowing the dashboard's routes, and unreadable ledger or config files are copied aside before being replaced

### grok

- Added `tools grok login`, which runs xAI's own OIDC browser flow and stores the grant in the vault, independent of the Grok CLI
- Added `tools codex|grok who` naming each session and its last activity through the agent's history adapter
- Fixed workers to run on the subscription login by default, run writable turns with `--always-approve`, and report the commits a turn made
- Fixed a malformed Grok auth file so it is logged by category and never with a parser message that quotes its tokens

### agents (rewritten)

- Added `tools agents hooks`: a shell guard with custom rules (`guard.customRules`), a rule picker, `rules check` with a corpus replay, Codex install and a per-harness doctor
- Added a Bash diff hook that looks like Claude Code's own diff and shows only the changes a session made itself, with per-session attribution, folded long and deleted files, move detection, secret masking in every patch, and an unpushed-commits reminder
- Added `genesis-tools-mods`, a Claude Code mod installed by `tools agents hooks mods`: it draws a cut diff in full under its call, folds each file behind a file list, and compacts an idle session 56 minutes after its last turn, before the cache expires
- Added per-session change capture with `tools agents changes` and `blame`, and a decisions hook
- Added `tools claude|codex|grok message`, which sends into a running session without typing, with `--wait`, durable session queues with explicit receipts, delivery to native Claude and Grok workers, and lookup by cmux tab title
- Added `tools claude|codex|grok wait`, which blocks until a session's turn ends, plus `agent_joined` and `agent_left` bus events, `tools agents leave`, and headline lines so a Monitor row reads as a message
- Added `--hide-worker-steps` and `--exclude-kinds` for agents output, and message JSON that starts with the body and sender
- Added one shared run, launch, resume and register core that Codex and Grok use as well
- Improved speed: `agents changes` reads transcripts in chunks (peak memory 2.6 GB to 1.2 GB on a 218 MB session), the agents tree reads only appended lines, and the diff hook's git status runs single-threaded
- Fixed the hooks installer losing a config file's permission bits, which left a private Codex `hooks.json` world-readable

### cmux (rewritten)

- Added `tools cmux capture` and `restore` for terminal workspaces, and `restore-after-restart --in-place`, which resumes each tab's session in the tabs cmux reopened, chosen by the surface journal
- Added `tools cmux agents new|list|close` and `session agent new|list|close` for Claude, Grok and Codex, with one status table, live titles and local-time activity
- Added show-in-chat links on every decision that scroll the live Claude transcript to where it was first asked, plus a `claude-find` preset with a free-text route that asks for confirmation unless this Mac minted the link
- Added layered agent trees, pins, and `launch` and `open-session` doors
- Changed every window, workspace, pane and surface to be named by UUID, because a cmux relaunch renumbers the refs, and made restore, close, rescue, focus and send refuse a tab that now holds another session
- Fixed restore resuming the wrong session or typing into the wrong prompt: it keeps the account and flags the session started with, drops `-m/--model`, and resumes only a session seen after the tab's command started
- Fixed the session journal growing to 19,000 lines, by writing a line per prompt only when the tab changed or 30 minutes passed
- Fixed `focus`, `send` and `read` for sessions running inside tmux, and quoting of the tmux attach command
- Fixed `cmux launch` asking for the vault key before the new surface did

### babysit skill (rewritten)

- Added the babysit skill: Grok or Codex workers fix a PR's review findings, and the lead session judges, corrects, cherry-picks and pushes
- Added run scripts: a run card and ledger that records every prompt, reply, verdict and push, `integrate`, `round-ready --wait`, `watch-reviews` as a Monitor source, `watch-workers`, `land.ts`, `pick-unified`, `restack`, `plant.ts`, `review-brief.ts` and `swift-slot` and `swift-typecheck` for Swift work
- Added a two-phase `/tmp` and TMPDIR reclaim that never touches live sessions, open files, sockets or git checkouts, with a disk watcher and `--own-session` to reclaim a session's own build output
- Added approval drivers that approve read-only command chains, scoped `fable-replace` edits and the briefs' own test commands, and refuse pager and `sed` tricks that write files
- Changed Codex workers to default to Sol, with Astra only for a named PR or a finding Sol missed twice
- Fixed reviews counting at a head they predate a force-push, replies skipped on deferred threads, and a restacked round needing a hand push
- Fixed the worker watcher replaying finished turns, and printing partial hidden-call counts

### question

- Added decisions and todos as question items with one schema, a locked store, a decisions inbox with context, rationale and code excerpts, delivery to live sessions, and MCP `question_post`, `question_poll` and `question_update`
- Added agents recording chat answers and superseding decisions with a link, a `number` on a decision post so the log matches the chat, and inline tokens that resolve when an item is saved
- Added blocking asks with pending forms, banners with yes/no answer buttons, image answers over MCP and the inbox CLI, and media context kept beside typed answers
- Added decision banners that open the hub at the decision, with posting to the log as opt-in
- Changed the native question tool to be for real blockers only, with a widget-off post stored for later while the agent also asks in its reply
- Fixed the read model failing with SQLITE_BUSY, and a failed config read replacing the question config

### mcp-manager

- Added a loopback OAuth gateway for MCP servers with launchd supervision, detached logins and tokens kept out of the config, and a gateway that serves the genesis-tools MCP in its own process
- Added Codex MCP sync across extra homes, `disable` and `enable` for servers a Claude or Codex plugin provides, Grok `disabled_mcp_servers` support, and `enable --clear-project-overrides`
- Fixed secrets showing in config diffs and logs, including `--access-token=` args, prefixed tokens and TOML multiline strings
- Fixed provider config writes being truncated on a full disk, by making them atomic
- Fixed a global Claude disable, so it denies the server in `settings.json` and no longer rewrites every project's list
- Fixed the relay and discovery to bound buffered bodies, SSE events and backlogs, and to stream responses

### daemon

- Added `tools daemon stats` with per-task failure rates, duration distributions and failures with stderr, as a menu or `--json`
- Added task priority (child QoS and start order) and a missed-run policy (asap, on-wake, retry-at, skip), `tools daemon config set`, and `tools daemon run` for one task now
- Fixed a DarkWake being counted as scheduler silence, which killed a healthy daemon
- Fixed the run-log prune freezing the scheduler for up to 82 seconds on a slow disk, and keeping logs past `maxAgeDays` because of the zone offset
- Fixed low-priority tasks failing with ENOENT on Linux, and a task that registers again losing the priority and policy the user set
- Improved the stats timeline, which walks at most the last 400 buckets

### plugin and skills

- Added the area-rules hook, which adds an area's rules when a search or shell command touches it, and maps tsconfig import names to folders
- Added worktree locks: a running session locks every linked worktree it uses so another session's `git worktree remove` refuses, and release removes a worktree whose only lock is its own
- Added a shared config for research and wrap-up, and web research that goes to haiku at xhigh effort with a confidence set by proof and a `check-ledger.ts` that confirms the quoted proofs
- Fixed hooks pinning the wrong account for resumed Codex and Grok sessions, and a UTF-8 account name breaking across journal chunks
- Fixed a session edit that waited out the tracker lock being lost, and two waiters both breaking a stale lock
- Fixed agents-talk hints so Codex is told never to use the skill

### github

- Added `tools github review` comment replies in a thread or comments on a line, and `tools gitlab pr review`, which ports the review report
- Added `merge --squash` defaulting the subject to the PR title and the body to one bullet per commit
- Fixed `merge --rebase` so it pushes only the merged PR's branch, restacks from the right tips and fetches in 8 s instead of timing out at 300 s
- Fixed notifications `--mark-read` and `--mark-done` and review thread replies to use the gh login, since the env token cannot write them
- Fixed the URL parser to read blob or tree after the repository name and to keep dots in repository names

### git

- Added `tools git fsmonitor`, which turns git's file monitor on globally and records every worktree a daemon watches
- Added `tools git rebranch` plan, apply and verify, which classifies commits against path groups and builds one branch per group
- Added `tools git worktree config|init|sync-plans`, driven by a post-checkout hook
- Added `tools git merged --prune` for remote-only branches, and stale-draft detection when the base rewrote every file the branch holds
- Added discovery and ranking of local checkouts
- Fixed `rebase-cascade --status` to print a plan whose target branch was deleted, and `merged` to handle a prunable worktree

### artifact

- Added a kit gallery that demos every component by family with a search box, opened with `tools artifact gallery [name]`
- Added the TimeSeries chart with zoom, pan, brush, markers, span lanes, split panels and synced charts
- Added the roadmap components Gantt, CapacityGrid, FilterChips, SortableList, Wizard, EditableTable, ChangeLedger, FieldDiff and a shared Tooltip, plus form controls
- Added an `auto` template that follows the system scheme, an opt-in ThemeToggle, StatGrid deltas and `init --starter roadmap`
- Added `serve --detach`, which starts the server in its own session and prints the real URL
- Improved start-up by deferring compiler and server imports, and fixed Tabs and TimeSeries to share the URL hash

### chrome-devtools

- Added perf `load`, `record` and A/B runs, emulation, request interception with source maps, storage and React probes, SPA navigation, and a grant command for Local Network Access
- Added a page agent that reads a tab in one isolated-world script and acts by label, and a tab driver that Spotify, YouTube and Jev now use instead of chrome-devtools-mcp
- Added `net-panel`, which reads the open DevTools network log, and `inspect eval --timeout`
- Added `open --user-data-dir` for a persistent profile, and support for Chrome 144+ consent mode on `attach`
- Added a separate-profile browser that opens on an unused display without taking the keyboard
- Fixed headless Chrome to quit through `Browser.close`, so it no longer leaves a 1.4 GB app copy behind
- Fixed the main-profile guard to read switches and argument boundaries the way Chromium does

### azure-devops

- Added a `comment` command (list, add, edit, delete) and a `wiki` command to list, read, search and diff pages
- Added posting a work item's fields in one patch, reading a team's capacity, cross-team history search and a query's work items as a parent tree
- Added a global `--config` option and `AZURE_DEVOPS_CONFIG`
- Changed `wi -f md` to print rendered markdown, and added an unbounded ancestor walk and a two-pass mention search
- Fixed `history activity` to accept a time on `--from`, and fixed config writes to be atomic
- Fixed the token to go only to the configured organization

### dev-dashboard

- Added a React Native mobile client with pairing, terminals, todos and the QA surface, plus the cloud side it pairs against
- Added `/ai/accounts`, an AI usage live channel and drag-to-reorder account blocks
- Added a Decisions tab on `/qa` with pick-then-send, and shared notes that render images, attachments, linked notes, code and `<details>` folds with secrets masked
- Improved the idle home page and the mobile terminal with fewer renders and year-long asset caching
- Fixed config saves to refuse a file that does not parse, and fixed new tmux panes to drop test markers inherited from a stale server

### mcp-web-reader

- Changed to one library core behind the CLI and a zod-validated MCP door, with built-in main-content extraction replacing Readability, mdream and readerlm, and three dependencies removed

### du

- Added `tools du index` build, update, query, diff and schedule over a persisted SQLite directory-size index
- Added measuring iCloud and File Provider content by stat only, plus `downloaded` and `evict` verbs, with an osascript fallback when no Swift compiler is present

### stash

- Fixed apply, unapply and continue to recover renames, failed and half-finished applies, and every affected path on abort
- Fixed continue to never replay executed regions, and fixed walk state to be written atomically and refused when unparsable
- Fixed region rewrites to be confined to verified regular files

### clones

- Added `reclaim` that projects freeable bytes from APFS private sizes, rewrites bun store duplicates on request and reports unreferenced store entries
- Added an auto-marked reclaim plan that the daily scan runs within byte and file limits, with a per-run report in the daemon run log
- Improved the cache prune so it checks a seventh of the rows per daily run

### doctor

- Added `tools doctor cpu`, temp-leaks and app-bloat analyzers, and `tools doctor act`, which trashes or deletes findings by id with confirm phrases and a manifest
- Added a security warning when the terminal app that runs builds is not on the Developer Tools list

### Timely, Clarity and todo

- Fixed Timely apply receipts to be kept as durable state outside the clearable cache, and fixed caches to be scoped
- Fixed Clarity to reach empty ADO weeks of the month, to never write an unchanged week, and to treat an invalid config as an error
- Fixed todo sync to be serialized before calendar objects are created

### spotify

- Added a Discover tab with four recommendation methods and an artist catalogue of unheard songs
- Changed `play` and `harvest --auto` to drive one Spotify tab through the CDP tab driver instead of chrome-devtools-mcp
- Fixed an unreadable profile registry to be refused, and kept silent weeks in timeline series

### say

- Added `--account` to pick the AI account that speaks, with its voice and model
- Fixed account usage to be booked once audio is produced, and fixed cached audio to be kept per account

### transcript and transcribe

- Added transcript rows where a Read call starts closed and Codex command, MCP and patch items open with full input and output
- Improved transcript code blocks and text selection to cost less to draw
- Added `transcribe` price quotes from a YouTube, X or media URL's duration, read-only, with hardened URL downloads

### telegram-bot

- Added `webhook status|set|delete|tunnel` commands and `start --webhook` with a secret token
- Fixed disallowed chats to be dropped silently, and fixed the rate limiter to apply and remember only commands with a cooldown

### youtube

- Added a single on-demand worker pool in place of 48 polling loops
- Moved the API server from port 9876 to 9886
- Fixed QA chunking to cut oversized segments and comments while keeping author prefixes

### Other tools

- Added `fable-replace` move-blocks to move a block between files, and fixed regex and import handling
- Added `tools tmux sessions create` as an alias of `tools tmux create`, and fixed `--command` to run through the login shell
- Added `tools hash` native streaming and `shasum -c` style verify, and `tools jwt` clipboard input
- Moved the `tools doctor` MCP checks under `tools mcp-manager doctor`
- Added `tools config` profiling `--edit`, `ms-teams` sync that keeps dropped history, and `handoff` recipient targeting
- Added a TypeScript port of Unreal Agent (`agent-harness`) with a Go oracle twin suite
- Added `tools transclude` inline tokens that resolve to real content with provenance, and a notification event id with action buttons
- Fixed `./tools` to never run `bun install` by itself in a linked worktree
- Fixed `cursor` options to accept spaced and equals forms, and `har-analyzer export --sanitize` to mask credentials fully

### Core / Utils

- Improved `genesis-tools-mcp` startup: Jev tools load only when exposed
- Added a shared atomic file writer and applied it to config, credential, plist, cache and notes files, so a crash or full disk leaves the old file intact
- Changed config loads so an unreadable or unparsable file is refused or copied aside instead of replaced with defaults
- Added `tools genesis-tools logs` and a per-day failures log, which record every failed tool run with its command, message, stderr, agent, session and model, with secrets masked
- Added fast file reads, with `fastWalk` using `getattrlistbulk`, `readFirstLines` and `readLastLines`, a `FileIdentityCache`, and a native-first `SafeJSON.parse`
- Improved CPU use by reading the process table, listening ports, CPU, memory, swap and disk through the kernel instead of spawning `ps`, `lsof`, `vm_stat` and `df`
- Added `toolCommand()`, TypeScript source and AST helpers, `openFiles()`, `withInterrupt`, bounded child processes and operation budgets
- Added per-turn session changes, and a bash guard rules package
- Added secret detection for Twilio, Resend, OpenAI, Anthropic, Stripe, OpenRouter, Google and fine-grained GitHub keys, and unquoted `.env` secrets
- Fixed OAuth and metadata fetches to pin the checked address and block more non-public ranges
- Fixed process handling so a timed-out command's TERM-ignoring descendants are killed
- Added `tools task stop`, which ends a process tree and signals only pids that still match their snapshot
- Fixed the logger so an error carries a bounded message and the hub roster refresh no longer writes about 230 MB of debug lines a day

### CI and tests

- Added an incremental typecheck that runs only for the projects a change can reach
- Added a commit-msg hook and `check-commits.ts` that hold subjects to one scope vocabulary and no PR numbers
- Added a check that every committed JSON file parses, a guard against `biome --unsafe`, and lint rules for busy-wait polls and Bun-only import paths
- Added `bun run test --profile`, which ranks test files by wall time, and a coverage report over the whole suite with `--gates safe`
- Improved the pre-push hook so it prints each stage's seconds and every guard has a deadline
- Fixed git hooks so they run as config hooks through `/bin/sh`, and so the post-commit and post-checkout hooks do nothing during rebases and non-worktree checkouts
- Fixed tests to use a private tmux socket, to stop finding the user's Obsidian vault, and to start kept fake executables
- Fixed a stalled test run to be killed after 15 minutes and to log what each worker waits on
- Fixed the pre-commit hook committing a moved Swift or Markdown file empty when biome printed nothing for it
- Fixed biome losing the project root when git runs the pre-commit hook from a linked worktree

### Removed tools

- Moved `fsevents-profile` to `tools fsevents profile`, `redact` to `tools secrets redact`, `last-changes` to `tools git changes`, `github-release-notes` to `tools github releases`, `git-rebranch` and `git-rename-commits` into `tools git`, `json-schema` into `tools json`, `usage` into `tools ask`, `macos-eslogger` to `tools macos eslogger`, and `mcp-doctor` and `mcp-debug` to `tools mcp-manager doctor`
- Removed the dead tools `agent-watch`, `aliases`, `apoptosis`, `boards`, `collect-files-for-ai`, `cursor-context`, `files-to-prompt`, `git-commit`, `git-last-commits-diff`, `hold-ai`, `instagram`, `mcp-ripgrep`, `mcp-tsc`, `regret-grep`, `repo-map`, `rohlik-spending`, `t3chat-length`, `time-machine`, `timer` and `types`

## 2026.09.04.1

174 commits since 2026.08.20.1. User-visible changes only.

### git (rewritten)

- Added `tools git merged`, which decides whether a branch or worktree is already in the base by content, so squash, rebase and recompose merges stop reading as unmerged; `--prune` removes only what it proved safe
- Added `tools git rebase-cascade` to move a parent branch and restack its children, with backup refs, an abort path, and an oracle route when the parent's work already landed upstream in another form
- Added `tools git base` and `tools git config`, naming the base branch plus the rule that chose it, and reading the per-repo `genesis-tools.config.json`
- Added typed git porcelain readers under `src/utils/git`, so tools stop re-parsing `status` and `for-each-ref` by hand
- Removed `tools git-rebase-multiple` and `tools git branch-gc`, superseded by rebase-cascade and merged

### monitor (new)

- Added `tools monitor`: watchers for http, tcp, dns, tls, json and command checks, with a wizard, notifications with delivery retries, uptime, silences, an HTTP server and a dashboard

### artifact (new)

- Added `tools artifact` to serve and build folders of loose HTML, TSX and Markdown, with a chart kit
- Fixed path containment and symlink escapes, and stopped the dev server serving the checkout itself

### chrome-devtools (new)

- Added `tools chrome-devtools` as a first-class cross-platform CDP debugging tool, including a zero-dependency chrome-har port pinned to upstream parity goldens
- Added one launcher shared by every CDP browser, used by the youtube devtools commands and the chrome-extension-dev skill

### grok (new)

- Added `tools grok`: a worker harness, history search, and TUI `--resume` through the shared session adapter
- Added a report when a turn changed nothing, so "turn completed" stops meaning "task done"

### ai-proxy

- Added pass-through for `/v1/messages` when the upstream speaks Anthropic natively, `:<effort>` suffixes on proxy model ids, per-client thinking rules, and Grok web search
- Added a launchd agent so the proxy survives reboot, scoped to the configured port
- Fixed grok's Anthropic spec gaps in SSE indices, tool calls, system hoisting and errors, and streamed replies faithfully from first content to true usage
- Fixed usage booking, transcripts, and catalog and model advertising

### claude

- Added `tools claude who`, listing live sessions with the account each one bills, plus account identity rename, a journal reader, and `doctor --identity`
- Added cmux `send`, `tree` and `open-session` to resume a session at any hierarchy level, and `--tmux` wrapping for start and run
- Added JSON transcript replay for Session Details, live sidechain transcripts, and Teams HTML-to-Markdown export
- Improved history search with ripgrep, search waves and prefiltering
- Fixed transport blips no longer feeding the usage-polling backoff ladder

### macos

- Added GenesisTools.app as the owner of the macOS privacy grants, with every service plist routed through it
- Added iMessage thread export to markdown with attachments, capped and validated
- Added SQL-level Mail filtering by date, sender and flags, an INBOX that lists every account, and `--account` that accepts the account email
- Added `calendar doctor`; calendar reads now fail loudly on Add Only or denied access instead of returning an empty list
- Improved clone detection to match duplicates across many roots, discover install trees, sibling worktrees and package-manager stores, and reclaim through a plan, apply and preset flow

### azure-devops

- Added sprint and iteration backlog commands with team scoping, and parent-chain walking for work items, singly and in batches
- Fixed settings being preserved within a project rather than across a switch, and a configure step that destroyed the Functions key

### clarity

- Added `tasks` and `mappings` with tree-backed recommendations, `--add` and `--remove`, and a receipt on every write
- Added dashboard recommendations backed by the same tree, with a hardened write path
- Fixed timesheet discovery to walk the carousel instead of a cached mapping id, and made `fill` refuse an incomplete month while posting a truthful weekly note

### cmux

- Added livelock rescue tooling: `doctor`, offline save, and a guided rescue
- Added restore-after-restart from a previous autosave, a live session or a profile, and resume inference for grok, claude and Codex
- Fixed a recycled pid reading as a surviving cmux, unbounded calls that never returned, and a stale workspace making `send` reject a real terminal

### ai and ai-spend

- Added `tools ai sessions tail` for Claude, Grok and Codex JSONL
- Added Claude Fable 5.1 to the catalog, made it the Fable launch default, and recommended it in handoff-to and ai-proxy
- Added an ai-spend monitor showing today and week spend in local time in under a second, a driver layer for codex and grok, and every ccusage report

### agents and workers

- Added one session-identity resolver across claude, codex, grok and GitHub Copilot CLI
- Added a unified worker event schema and verb set with a hardened pid and turn lifecycle
- Added handoff proof previews, the agents-talk protocol, and a main login stream that acts as the swarm inbox

### dev-dashboard

- Added a share command for public Obsidian note URLs
- Fixed public 502s on the tunnel origin, made proxied bodies retry safely, and hardened the DashboardApp launchd and preview lifecycle

### ms-teams

- Added live Teams IndexedDB repair without logout

### Plugin skills

- Added `gt:git`, `gt:tdd`, `gt:artifact` and `gt:chrome-devtools`
- Removed `git-rebaser` and `handoff-to-codex`, folded into `gt:git` and the handoff-to router

### Core, utils and CI

- Added a config-gated profiler with scopes and detail levels
- Added a placeholder consistency check that blocks a push on personal data, scanned in one `git grep` rather than one per needle
- Added CI guards that fail the run when a test imports a CLI entrypoint, and when the suite never terminates
- Improved startup with a lazy logger, a getattrlistbulk probe and deferred CLI imports
- Fixed four real bugs behind the Linux test failures, and sandboxed the real genesis-tools home for every test process

## 2026.08.20.1

1064 commits since 2026.05.18.2. User-visible changes only.

### ms-teams (new)

- Added `tools ms-teams` to read New Teams desktop IndexedDB, ingest a local SQLite cache, and export chats as markdown, JSON, or HTML
- Added natural queries such as `show "conversation with Ada from DATE to DATE"`, plus `search`, `conversations`, `people`, `files`, `calls`, `meetings`, and an MCP server
- Added inline image extract from the Teams Chromium disk cache so markdown and HTML point at local files instead of unauthenticated Skype URLs
- Added read-only `doctor`, unique attachment names, HTTPS origin allowlists, a 50 MiB download cap, and stricter HTML sanitizing

### ai-proxy

- Added `tools ai-proxy` as a local multi-provider gateway with OpenRouter, Grok, and per-model provider routing
- Added an Anthropic Messages API so Claude Code can run proxied models
- Added upstream cost booking, thinking/pass-through fixes, and account detection that does not spend one-shot grants

### ai

- Added a v4 account/config/secret store, `tools ai config` (account, default, link, secret), doctor, and a TUI
- Added OpenRouter as a first-class plugin with a shared model/price catalog
- Added grok-sub and env-referenced keys, image-generation usage recording, and an AI SDK v5 → v7 / Zod v4 upgrade
- Fixed exact per-token pricing, cache-token double-counting, and provider refs resolved by billing-mode-free name

### claude

- Added `tools claude cmux` to reopen recent sessions as cmux workspaces, plus `cmux focus` to jump to the pane that already has the session
- Added `exec` (run a command with a pinned account OAuth token), `doctor` for pinned sessions that silently bill the keychain, and `extract-shell-quirks`
- Added usage TUI headroom, renewal countdown, observed-burn pace, and refusal to launch a weekly-dead account
- Fixed keychain resume, lapsed-plan false health, org-403 treated as expired subscription, and teammate wrapper identity sweeps

### youtube

- Added ask/queue/transcripts/config CLIs, a curated MCP server, and extension chapters, search, shares, presets, and activity
- Added settings, operator gating, and billing atomicity on the hosted routes
- Fixed channel-handle normalisation, index budgets, ask-session uniqueness, and transcript export parsing

### spotify (new)

- Added `tools spotify` for harvest, playback through the web player, reports, a dashboard on 3075, and a user-facing plugin
- Added `plan rm` so a wrong ownership guess is not permanent, with a reason when there is nothing to do

### instagram (new)

- Added `tools instagram` to view public profiles anonymously and stories with your own session

### macos / clones / du (new)

- Added APFS clone-aware duplicate detection, optimize/rollback, a scan daemon, and `tools macos clones`
- Added `tools du` (`clonesize`, `volume`, `clones`, `bench`) so clonefile trees report real unique bytes instead of `du` overcount
- Added clonefile hashing, getattrlistbulk, and Windows-resilient recursive delete helpers used by the scanners

### control (new)

- Added `tools control` for Accessibility automation: list/tree/find/click/type/hotkey/scroll/screenshot/ocr/capture
- Added draw/annotate, screenshot compare, and wait/assert/record-plan

### agents / agent-watch (new)

- Added `tools agents` for cross-agent messaging over a per-session feed (login, message, discover, listen)
- Added `tools agent-watch` to notify when background agents finish, stall, or need input

### stash (new)

- Added `tools stash` for named code overlays you can apply across sibling clones, with surgical unapply

### boards / dashboards / task

- Added spatial board compose/arrange, journeys, questions, scrape, and live SSE canvas updates on the dev-dashboard
- Added a shared `DashboardApp` shell (access banner, QR, localhost-aware open) and migrated dashboards onto it
- Added `tools task` PTY-aware run/wait/tail, session GC, and mosaic session UI
- Added `tools dashboards` as the port/launch registry

### Other new tools

- Added `tools apoptosis` to flag zero-signal dead code after a grace window (never deletes)
- Added `tools repo-map` for a token-budgeted symbol map
- Added `tools regret-grep` to warn when the working tree repeats a bug you already fixed
- Added `tools learn-from-fable` to distill Fable working style from local session transcripts
- Added `tools loc`, `tools hash`, `tools jwt`, `tools qr`, `tools tz`, `tools envdiff`, `tools secrets`, `tools redact`
- Added `tools aliases` to mine shell history for alias candidates
- Added `tools scripts` (MCP scripting), `tools mcp-doctor`, `tools ai-spend`, `tools time-machine`, `tools tradingview`, `tools wakeup`, `tools cmux`, `tools tmux`, `tools codex`

### Core / Utils

- Folded logger into `src/utils` and published `@genesiscz/utils` as the shared package
- Added pidfile records that survive pid recycling, with identity checks before signal/kill
- Added a two-layer logger/`out` facade, `runTool` bootstrap, and swappable prompt backends
- Added SecretStore (AES-256-GCM vault), keychain guards, and `env.tools` path routing
- Added shared table helpers, image annotation, OAuth helpers, and file-lock steal of orphaned locks
- Fixed Windows-resilient `removeRecursive`, in-memory DB directory skips, and turndown-gfm row-less table crash

### CI / Testing

- Replaced six GritQL plugins with an ast-grep checker
- Added hardcoded-path CI guard and logging-guard
- Fixed standalone `apps/eve` install before the test sweep and serialised flaky task/tests

## 2026.05.18.2

### CI

- Added a cross-platform test-discovery matrix: Ubuntu always, Windows opt-in via PR title/label or manual dispatch, with per-OS step timeouts and a bun install cache (`~/.bun/install/cache`)
- Improved CI cost/speed: folded lint + typecheck into the Ubuntu test job (no separate runner), pinned setup-bun to 1.3.13, and excluded the dashboard/Internal/shops workspaces from the bun-test glob

### Core / Utils

- Added cross-platform path helpers in `utils/paths` — `tmpdir`/`tmpPath`/`makeTempDir` (single temp-root abstraction) and `toPosixPath` for separator-stable keys and output
- Added Windows-resilient `removeRecursive`/`removeDbFile` in `utils/fs` with a self-implemented EBUSY retry loop (Bun's `rmSync` ignores `maxRetries`)
- Fixed `attachReadonly` to work without the SQLite URI-filenames build flag, with balanced connection-scoped read-only enforcement (no leak to later writes)
- Fixed in-memory databases to skip directory creation (Windows ENOENT), and added `isPortInUse` for safe port pre-checks
- Added a centralized test skip/opt-in gate module (`utils/test/skip`) and a preload that stops `process.exit()` from aborting the shared test run

### indexer

- Fixed Windows path separators bleeding into Merkle hash keys, code-graph edges, tsconfig alias targets, and search output (now POSIX-normalized at the source)

### doctor

- Fixed `parsePsOutput` to be line-ending agnostic (CRLF-safe) and the doctor path constants to be deterministic forward-slash cross-platform

### daemon

- Fixed `runTask` to kill the whole process tree on timeout and never hang on stream drain (a runaway child no longer pins a CPU core)

### reas

- Fixed `reas --dashboard` to pre-check the port and bail with an actionable error instead of spinning at 100% CPU when the port is occupied

### Testing

- Improved the test suite to run green cross-platform: skip/opt-in gates for macOS-binary, live-credential, audio-device, and Unix-only suites; temp-DB cleanup routed through the Windows-resilient helpers; and POSIX-stable assertions

## 2026.05.18.1

### dashboard (new)

- Added `tools dashboard` — a personal productivity dashboard (TanStack Start + Turborepo monorepo, SQLite/Drizzle data layer with migrations, Node-runtime SSR)
- Added server-side WorkOS auth with per-user data isolation (GitHub/Google OAuth, route guards, email-verification gate)
- Added a timer engine (stopwatch / countdown / pomodoro) with cross-tab + SSE sync and pop-out
- Added Focus Mode + Daily Planner, an AI assistant chat with MCP server (tasks/timers), and an assistant view (blockers, handoffs, decisions, critical path)
- Added Quick Notes + Bookmarks (live-preview markdown, SSRF-safe metadata fetch), home/settings/health pages, and per-route error/pending boundaries
- Added the `tools dashboard` launcher: starts the dev server and opens the browser, auto-installs deps when missing, `--prod` (PM2), `--no-open`, `-p <port>`
- Updated the dashboard to Vite 8 / `@vitejs/plugin-react` 6 and aligned commander to v14

### shops (new)

- Added `tools shops` — a Czech e-shop price aggregator: API clients for 17 shops, catalog/sitemap crawlers, SQLite DB + migrations, ingest/match/watchlist/analytics/orders pipelines, an SSE-driven React dashboard UI, and a shops MCP server

### dev-dashboard (new)

- Added `tools dev-dashboard` — a personal Pulse dashboard (system/weather/Claude-usage/daemon/containers/todos collectors + panels)
- Added an Obsidian share with a public `/share/:slug` renderer, and a ttyd tunnel proxy (Bun.spawn-based, in-memory port registry) so terminals work over a Cloudflare tunnel
- Added a mobile terminal shell with ttyd/cmux focused UI + rename, and a per-account multi-bucket Claude usage history chart
- Fixed Button hover legibility, focused empty-state chrome, and a ttyd readiness race

### transcribe

- Added Deepgram-native diarization (utterances, speaker segments, SRT/VTT, CLI flags)
- Added local sherpa-onnx diarization (CAM++ multilingual embedding) with whisperX speaker alignment
- Added consecutive-run repetition cleanup and a speaker-label normalizer
- Added an xAI transcription provider with model selection and a quiet non-TTY spinner
- Fixed ffprobe JSON parsing strictness and CLI speaker-count validation

### jenkins-mcp (new)

- Added `tools jenkins-mcp` — an MCP server + CLI for daily Jenkins ops (builds, queue, log tailing)
- Improved log fetching with incremental whole-build tailing, decoration stripping, and a `/api/json` fallback when run status lags build completion

### claude

- Added a shared Claude-usage cache so all consumers hit Anthropic at most once per 30s, with `claude-usage-poll` run-log retention

### daemon

- Added optional per-task run-log retention and improved `listRunsForTask` performance
- Improved polling robustness and log timestamps

### search

- Fixed sqlite-vec loading stability and a double-preload warning (process-global `setCustomSQLite` guard)

### indexer

- Improved reliability: orphan-vector self-healing, paired counts, single-call ast-grep registration

### debugging-master

- Added a live cyberpunk dashboard with SSE streaming

### say

- Added automatic fallback to macOS TTS when the cloud provider fails

### Core / Utils

- Added a shared `@ui` component library (shadcn-based primitives + blocks) under `src/utils/ui`, reusable repo-wide
- Added a WebView pool, an `ApiClient`, and bun/async/string helpers under `src/utils`
- Improved `macos-mail` search export output; `apple-calendar` now tries all sources and falls back to a writable calendar
- Extracted audio probe/split/converter/format-detection into reusable `src/utils/audio` modules
- Fixed all biome lint + the vendored-shadcn `noDocumentCookie` warning for green CI (root + dashboard biome, `tsgo --noEmit`)

### ui (design system)

- Un-flattened the shared primitives + `DashboardLayout` (nexus theme, cyber-grid, glass) so clarity/shops/reas render the themed surface again instead of a flat grey one
- Added the design-system contract (`design-system.md`) + an 8-dashboard catalog, a raw-palette guardrail (`check:ui-palette`), and a shared token-driven `AuthLayout`
- Replaced ~590 raw `zinc`/`white` utilities with theme tokens across clarity/shops/reas; shops gained branded glass auth (login/register)
- Converged the youtube UI onto the shared `AppShell` + `AppSidebar` (override slots + theme class), retiring its bespoke sidebar/topbar
- Added `GlowOrbsNexus` ambient variants (`subtle`/`rich`/`playful`/`rich-animated`) and a central dashboards registry with port-conflict detection
- Aliased deep-relative imports to `@app`/`@ui` across 69 files

## 2026.05.04.1

### claude-history-dashboard

- Fixed crash on every page (`Module "node:os" has been externalized for browser compatibility. Cannot access "node:os.homedir"`); root cause was a top-level `node:os` import in `src/utils/string.ts` reaching the browser bundle via the SessionTimeline import chain — moved `matchesGlob` (the only consumer) into `src/doctor/lib/safety.ts`
- Fixed React hydration mismatch on date labels — replaced `toLocaleDateString` / `toLocaleString` with deterministic `formatShortDateTime` / `formatLongDateTime` in `src/lib/utils.ts` (Node small-icu vs V8 diverge on "at"); removed leftover `suppressHydrationWarning`
- Fixed CI biome failure caused by 4-space indent committed under the dashboard's tab-only biome config

### utils/ui

- Fixed "You appear to have multiple instances of Solid" warning across dashboards via `resolve.dedupe: ["solid-js"]` in the shared Vite config (TanStack devtools ship a nested 1.9.12 alongside the hoisted 1.9.11); React/react-dom dedup already covered by the existing `pinNodeModules` plugin

### githooks

- Added `.githooks/pre-push` mirroring `.github/workflows/ci.yml` exactly: `bun run lint`, `bun run lint:dashboard`, `bun run typecheck:all` — closes the gap where pre-commit's `--staged` mode skipped the dashboard's separate biome config
- Pre-push auto-recovers fresh worktrees: when `typecheck:all` fails (missing `node_modules`), runs `bun install` once and retries; lint steps untouched (their failure mode is real violations, not missing deps)

### say

- Added cloud TTS cache for repeated phrases under `~/.genesis-tools/say/cache` — sha256-keyed by canonical text + provider + voice + model + rate + language + format; threshold-gated (5 misses by default), LRU-evicted under 50 MB cap, skipped when `--stream` is set, self-healing on missing audio files, TOCTOU-safe
- Added per-text provider overrides — substring match (case-insensitive) routes phrases like "Permission needed" to a chosen provider regardless of profile; voice/model cleared on the override copy unless explicitly passed on the CLI
- Hardened `index.json`: shape-validates on read (rejects valid-JSON-but-wrong-shape payloads instead of casting blind), atomic tmp+rename on write so a crashed write can't leave a half-file behind
- Removed misleading "salted hash" wording on `IndexEntry.text`
- Added config v2 with per-app profiles, xAI TTS polish, normalized `--rate` (#157)

### mail (macos)

- Fixed authoritative date filter in FTS path — `getMessagesByRowids` now re-applies the full filter so out-of-range messages can no longer leak through
- Fixed Czech / Unicode mailbox name resolution — Mail.app stores `mailboxes.url` as percent-encoded UTF-8 NFD; resolve in JS (`decodeURIComponent` + `.normalize("NFC")` + `.toLowerCase`), then filter via `m.mailbox IN (...)`
- Added stale-chunk prune wired into Phase 4 of indexer sync via the new optional `IndexerSource.pruneStale` hook; deletes content rows whose Mail ROWID is hard-deleted, soft-deleted, or has a divergent `date_sent`
- Added date-range coverage advisory: `mail search --from/--to` prints a stderr advisory when the requested window falls outside indexed coverage (skipped for `--jxa` / `--without-body`)
- Fixed draft visibility: 56 of 62,748 live messages have `m.sender = NULL` (unsent drafts in Drafts / [Gmail]/All Mail) — switched 5 sender JOIN sites from INNER to LEFT JOIN, marked sender fields nullable, render `(no sender)` / `—` / `unknown-sender` fallbacks at downstream consumers
- Added ATTACH-pushdown FTS search — emits `c.source_id IN (SELECT CAST(m.ROWID AS TEXT) FROM mailapp.messages ...)` so date/mailbox/account/receiver filters get pushed into the FTS query (7-55ms vs 300ms broken pipeline at limit=50)
- Added Spotlight body fallback (`mdfindMailRowids`) when the FTS index is missing; `sanitizeSpotlightQuery` strips NSPredicate metacharacters while preserving Unicode letters incl. diacritics
- Added rich body extraction: `parseEmlxBodyPartsFromFile` returns `{raw, html, markdown, text}` surfaced via new `bodyHtml`/`bodyMarkdown`/`bodyRaw` columns in `mail show` / `mail search`
- Centralized SQL helpers (`escapeLike`, `LIKE_ESCAPE_CLAUSE`, `MESSAGE_SELECT`, `buildFilters`) into `src/utils/macos/mail-sql.ts` — regression-guarded by `sqlite-escape.test.ts`

### clarity

- Fixed silent ADO/Clarity/TimeLog auth failures — surfaced auth errors in CLI and UI instead of swallowing them
- Suggest device-code `az login` flow that works for users without subscriptions

### indexer

- Added `INDEXER_MIGRATIONS` list (source_id index, FTS5 `unicode61` `remove_diacritics 2`, `metadata_json` column) applied via the generic migration engine on read-write opens
- `searchIndexReadonly` accepts `{filters, attach, metadataFilters}` — ATTACHes external read-only DBs via `file: ... mode=ro` URI for cross-DB pushdown, AND-merges typed and ad-hoc filters before BM25/cosine
- Added per-source typed metadata columns — `applySourceMetadataSchema` diffs declared vs persisted columns and runs ALTER + CREATE INDEX; `backfillMetadataColumns` pages distinct source_ids; shared `coerceMetadataValue` (bool→0/1, Date→epoch ms)
- `buildMetadataPredicate` emits `c.<col> {=|<=|>=|BETWEEN|IN|LIKE} ?` for filter pushdown

### db / migrations

- Added generic SQLite migration engine at `src/utils/database/migrations.ts` (id + description + isApplied + apply contract, `_migrations` journal scoped per `(id, tableName)`, atomic BEGIN/COMMIT around each apply, `Migrator` adapter consumed by `MacDatabase` subclasses via `getMigrator()`)
- Migrated raw `bun:sqlite` to Kysely across foundation + ask + automate + mail (#159)

### macos / infra

- Added `tools macos swap` — per-process swap leaderboard (#160)
- `MacDatabase`: `PRAGMA busy_timeout = 5000` + `onDbOpened` hook so readonly connections to live macOS DBs (Mail, Messages, …) don't throw `SQLITE_BUSY` when the owning app holds a write transaction
- Fixed `tools macos mail index` reporting bogus `Embedded: 0/N` — new `countActiveEmbeddings(db, tableName)` picks the active embedding table (sqlite-vec `_vec` vs legacy `_embeddings`)
- `UsageDatabase`: replaced deprecated Kysely `orderBy(array)` / `groupBy(array)` with chained calls (was spamming every `tools macos mail` invocation)

### tests / logging

- `bunfig.toml` `[test].preload` runs `wipeAllTestIndexes()` once before any test file imports — covers every `gt_*` / `phase2-*` prefix tests own
- Test prefixes renamed to `gt_*` (`gt_e2e_test_`, `gt_indexer_test_`, `gt_integration_test_`, `gt_bench_`) for collision resistance with real user index names
- `isQuietOutput()` helper for non-table output formats (JSON/TOON), wired through `mail search` so `--format json` is pipeable
- Logger writes day-stamped files under `~/.genesis-tools/logs/` instead of the repo's `/logs/` dir
- CLAUDE.md: added Database Infrastructure section documenting Storage, MacDatabase, Migrator, INDEXER_MIGRATIONS, and metadata-schema

## 2026.04.29.3

### Bun runtime / JSX
- Fixed `tools claude usage` (and any React/Ink TUI) crashing with `Invalid hook call` / `Rendered more hooks than during the previous render` after the doctor (Solid) and youtube (React) tools were merged
- Root cause: `@opentui/solid/preload`'s Bun plugin matches every `.tsx` (`/\.(js|ts)x(?:[?#].*)?$/`) and runs `babel-preset-solid` on it, rewriting React JSX into Solid runtime calls
- Replaced the upstream preload with a scoped wrapper at `src/utils/bun/preload-solid-scoped.ts` whose filter is path-restricted to `src/doctor/` only — files outside go through Bun's native react-jsx loader untouched

## 2026.04.29.2

### youtube (MAJOR)
- Major buildout: CLI, library, server, React/Vite web UI, browser extension (~17,960 insertions across 182 files)
- Added routes for jobs, settings, videos, with WebSocket client and Vite config-middleware plugin
- Server-entry, ws-client, styles, settings/jobs/videos pages

### ai/xai (NEW)
- Added xAI voice provider — REST + WebSocket transports for both STT and TTS
- `AIXAITextToSpeechProvider`, `AIXAITranscriptionProvider`, shared `XAIClient` with full test coverage

### ai (synthesizer)
- Added shared `Synthesizer` task class for per-task TTS provider routing
- Per-task TTS/STT provider refactor — config now binds providers to specific tasks
- Added `audio/playback` utility with playback queue + tests
- Moved `TranscriptionManager` into `utils/ai/transcription/`
- Removed inline voice-memos transcription code in favor of shared synthesizer/transcription tasks

### indexer
- Fixed `no such module: vec0` crash on `tools macos mail index` — `Database.setCustomSQLite()` now runs at `IndexerManager.load()` and `MailSource.create()` so it wins the race against the first `bun:sqlite` Database (was happening too late inside `createIndexStore`, leaving Bun bound to Apple's extension-less SQLite)

### tools (CLI runner)
- Added auto-recovery: when a child tool fails with duplicate-React / missing-module signatures (Invalid hook call, more than one copy of React, Cannot find module …), the wrapper runs `bun install` automatically with full output. Set `TOOLS_SKIP_AUTOINSTALL=1` to opt out
- Stdout/stdin stay inherited (TUIs and prompts still work); only stderr is teed for pattern detection

### Core / Build
- Added `.tanstack/` to `.gitignore` for TanStack Start build artifacts

## 2026.04.29.1

### doctor (NEW)
- Added `tools doctor` — macOS dev-machine diagnostic CLI with TUI (OpenTUI/Solid) and plain modes
- 12 analyzers: battery, brew, dev-caches, disk-space, memory, network, processes, security, startup, system-caches, plus core/remaining
- Findings drawer, prompt host, executor with safety guards + timeouts, history cache, JSON/log/plain renderers
- Generic + per-analyzer view registry, status strip, modal/toolbar/error boundary

### cmux (NEW)
- Added `tools cmux profiles save / view / restore / list / delete / edit / path` for terminal-multiplexer state snapshots
- Snapshots cwd, env, shell, and history via shell-probe; restore-tree planner with focus guard
- Programmable socket transport with cmux protocol types

### todo (NEW)
- Added `tools todo` — project-scoped task management for LLM workflows (#142)
- add / edit / list / sync / done commands with TodoStore, link parsing (URL/PR/issue), reminder time parsing
- Calendar/Reminders sync via DarwinKit; `--at` flag for explicit event time
- Fixed 4 sync bugs: one calendar event with multiple alerts (was N events), URL pass-through to event, alert offsets computed from reminder times (was hardcoded 10 min), reliable Reminders via DarwinKit
- `syncTodo` now returns `SyncResult` with per-target outcomes; `SYNC_FAILED` lines + non-zero exit on failure

### indexer (NEW MAJOR)
- Added end-to-end code/document indexer with FTS5 BM25 + vector search, Merkle hashing, AST chunker (#117)
- Hybrid search drivers: sqlite-vec ANN and Qdrant; RRF fusion 3× over-fetch with min-score threshold
- 16 AST languages with chunking overhaul (overlap, 2000-char cap, minified detection, merge/sub-chunk)
- 3-phase streaming pipeline raised throughput from ~8/sec to ~300/sec; resumable sync, batch embedding (32/req), task prefixes, parallel file I/O
- MCP server for AI assistant access; per-mode search stats; pretty/simple/table search formatters with confidence + highlighting
- Kotlin/Scala/C# imports, circular-dependency detection, rich Mermaid graphs, CoreML batch, Google provider, graph persistence, tsconfig aliases
- `.genesistoolsignore`, infrastructure-aware watcher backoff, context artifacts, auto-resume
- AST grammars install on-demand (saves ~658 MB) — selective, interactive prompt, in-flight Promise dedup
- Search backend: sqlite-vec ANN, Qdrant hybrid, `migrate-vec`, IndexerStorage, ModelRegistry, benchmark integration
- Critical safety: lock ordering, `shouldRetry`, DarwinKit alignment, Ollama dimensions, watcher events
- Verify command, xxHash64, guardrails, date filtering, sync command, store routing fixes
- Search output redesign + Qdrant Docker (#136), GPU-first embedding, Ollama auto-pull, interactive remove, model selector

### mail (NEW)
- Added Apple Mail indexing — incremental sync, emlx extraction, DarwinKit auto-select (#117)
- FTS/hybrid search with FTS5 native `snippet()` excerpts; account listing, show with pagination, monitor command, columns selection, multiple output formats (#131)
- Opens Envelope Index directly (avoids EPERM copy on macOS); helpful error message on Full Disk Access denial

### ai (NEW)
- Added `tools ai` CLI — translate, summarize, classify, models, config
- Unified `AIConfig`, `AIAccount`, resolver registry, `ProviderManager`, `ChatEngine`, with config migration
- ModelRegistry replaces hardcoded maps; cache detection and default model management
- OpenAI Codex / ChatGPT subscription support via WHAM backend — `OpenAISubResolver`, `CodexOAuthClient` PKCE, import from `~/.codex/auth.json` or browser auth
- Live WHAM `/models` endpoint instead of stale `KNOWN_MODELS`; `store=false` provider option for openai-sub
- Auto-detect openai-sub accounts in provider discovery; bare `--provider` opens interactive picker
- Added GPT-5.x, gpt-5.3-codex, o3, o3-mini, o4-mini to `KNOWN_MODELS`
- Ollama LLM chat for summarize and translate; retry wrappers for Transcriber/Summarizer/Translator
- HuggingFace stack on-demand install (saves ~4.5 GB) with shared `ensureHuggingFaceTransformers()` helper
- Shared `embedding-selection.ts` utility (provider detection + interactive model selection)
- Diarization + word-timestamp options on `TranscribeOptions`; `Embedder.dimensions` from ModelRegistry
- WhisperTextStreamer progress, corrupt-cache retry, warning suppression
- `embedBatch()` on Cloud, Local, DarwinKit, Ollama, CoreML providers + retry with backoff
- Fixed: required `instructions` field for WHAM Responses API; stale OpenRouter default model ID; Codex auth.json official-CLI format; infinite fallback loop in TranscriptionManager

### ask
- Added @file mention expansion for inline file context
- Added Read, Grep, Bash tools for file access and shell execution
- Added /context, /tools, /history, /system chat commands
- Added markdown rendering for streaming output via mdast → terminal
- ⏺ Claude-Code-style icon for tool signatures; suppressed websearch chatty logs; blank lines between tool blocks
- `ConversationManager` storage moved to `~/.genesis-tools/ask/conversations/` (was cwd-relative)
- Routes streaming output through agents `TerminalRenderer` (`AskStreamRenderer` bridges ChatEvent → FormattedBlock)
- Provider creation delegated to resolver registry

### claude / claude-history / cc
- Added Sessions tab + History fix + commit search fix (#137)
- Added `tail --list-sessions` + Claude-Code-style formatter (#132); display agent progress events in tail output (#120)
- Added `cc tail` for live session/agent output streaming (#113)
- Added `claude export` — full/mini/raw formats, file output, include spec, project filtering
- Added warmup service, multi-account usage, memory command, AIConfig integration
- claude-history-dashboard: glass-card UI with sidebar, markdown rendering, syntax highlighting; pages and Tailwind v4 fixes
- 429 bypass via token refresh + poll coordination (#82)
- Auto-refresh history/rates + scroll fix (#78); preserve account order + plan label fix (#83)
- Optimized `--commit` search speed (#85)
- Subscription OAuth + tail enhancements (#129)

### reas
- Added React dashboard — routes, components, Vite config (#147)
- Added API clients, data layer, analysis, and core lib
- Added `backfill` subcommand for historical sold listings
- Added unit and E2E test suites

### timely
- Added `create` command — generate time entries from auto-tracked memories (plan/apply, #155)
- Added `categorizer`, `event-corpus`, `plan-build`, `plan-apply`, `flatten-memories` utilities
- Added `dayOfWeek` to Timely entries

### clarity
- Added granular 3-section StatusCard (Clarity PPM, Azure DevOps, TimeLog)
- Added Settings page with ADO configure (URL paste), TimeLog configure (auto-fetch API key + team-member picker), Clarity auth (cURL paste)
- Added timesheet notes — comment popup + mandatory post-fill review dialog with weekly summary builder (Czech day names, grouped by date)
- Added `granular-status`, `configure-ado`, `configure-timelog-key`, `configure-timelog-user`, `team-members` API routes
- Carousel forward navigation for last partial week (offset +1) + DRY `parseCarouselEntry` helper
- Date shift fix: `parseUTCDate()` strips time to avoid UTC/local off-by-one
- Work item links use org URL instead of orgId GUID
- Compute `clarityTotalMinutes` from all timesheet entries (was ADO-matched only)
- Show Clarity-only tasks; handle inaccessible work items; surface enrichment errors in API response
- Vite SSR `watchExternalDirs` plugin for server-side hot-reload; smaller work-item title font; fixed Status column width
- Czech date format fix; allow initial setup from UI (no CLI required); orgId auto-derive

### azure-devops
- Team-member picker replaces manual GUID entry in timelog configure
- Real org GUID from `connectionData` endpoint with api-version 5.0-preview (7.1 returns 400)
- Extracted reusable ADO/TimeLog config lib (`lib/ado-configure.ts`, `lib/timelog-configure.ts`) so CLI and Clarity UI share logic

### macos
- Added `tools macos voice-memos` with SQLite reader and ONNX device detection
- Added iMessages database, contacts resolution, and CLI commands
- Added `tools reminders` (list / search / add / remove) and `tools calendar` (list / search / add / update / delete) with full DarwinKit/EventKit CRUD
- Migrated to `@genesiscz/darwinkit` package (#100), bumped to 0.7.4 (#152)
- Rewrote Calendar/Reminders utils — DarwinKit replaces JXA; extracted shared JXA helpers for apple-notes
- Added `runDarwinkitGuarded` wrapper with per-request timeouts, disconnect/error rejection, diagnostic-report + stderr capture, surfacing `DarwinkitTimeoutError` / `DarwinkitCrashError` instead of hangs

### transcribe / youtube
- Added `tools transcribe` CLI with multi-provider support
- Added `tools youtube transcribe` with captions and audio fallback
- Pipeline polish, LLM gating, usage tracking, UTC timestamps

### say / notify / timer
- Added `tools say` with volume, dynamic voices, speak alias
- Added `tools notify` with terminal-notifier support
- Added `tools timer` with countdown, pomodoro, notify/say integration
- Added multi-channel notification system with dispatcher (`utils/notifications`)

### daemon
- Added scheduler `--notify` flag, `restart` command, launchd-aware `stop`

### benchmark
- Added `tools benchmark` with hyperfine integration
- Added `show`, `edit`, `history`, `--cwd`, `--env`, complete hooks, modular structure (#140)

### port
- Enhanced listings, commands, and polish internals

### zsh
- Added `tools zsh` shell enhancement manager (#103)
- Tab completion; fixed notify escaping and `...` recursion

### darwinkit
- Added interactive CLI tool for DarwinKit (#104)

### cursor
- Added `tools cursor` wrapping Cursor Agent CLI with stream-json NDJSON parser
- Defaults to `--mode=ask` with live streaming; `--raw` for clean output
- Routes through `TerminalRenderer` for colorized tool calls

### github
- Added Actions billing analysis — workflow runs, costs, billable minutes, failure waste, cross-repo scanning, run management (#106)
- Worktree integration for review/pr commands (#128)
- Replaced `--save-locally` with `--save [path]`
- Added commit URL support to `tools github get` (#81)

### update / raycast / shell-fix
- update: install/update marketplace; discard `bun.lock` before `git pull` to avoid merge conflict
- raycast: bash command fix script (#139); fixed paste command
- shell-fix: preserved quoted newlines and command-group separators (#148)

### Plugins / Skills / Commands
- Renamed plugin prefix `genesis-tools:` → `gt:` and expanded README (#115)
- Added `gt:research` skill with MCP-availability protocol (and PR #153 review fixes)
- Added `genesis-tools:explore` agent (#84)
- Added `genesis-tools-server` security audit plugin with `security-audit-linux-server` command (#101)
- Added `/question` answer-only mode (already in 03.03 entry; refined here)
- Refactored genesis-tools skills, commands, and descriptions (consolidated SKILLs into commands/)
- Optimized trigger descriptions for 4 plugin skills
- Added writing-plans, debugging-master skills (session reuse, LAN IP, server sharing #138)
- Telegram conversation memory + assistant v2 (#77); routes notifications through dispatch system

### agents (UI framework)
- Added unified formatter layer with terminal and web renderers
- Added React UI components for session rendering with dark theme
- `ClaudeSessionFormatter` wraps the new format pipeline; reuses `session-helpers`

### UI framework / shared components
- "Wow" theme + custom components + theme-aware Card (#147)
- Added shared shadcn components (alert-dialog, alert variants, textarea), graphs, dashboard layout
- Consolidated sub-package deps into root `package.json` to eliminate duplicate React; pinned react/react-dom to exact 19.2.0 then aligned to 19.2.5
- Added `PROJECT_ROOT` constant in `utils/paths.ts`; `--strictPort` for clarity vite spawn

### search (utils)
- `SearchEngine` with `VectorStore` / `TextStore`, pluggable `IndexerSource`, `MailSource`, `TelegramSource`
- Added `Embedder` task class shared across mail/indexer (#112)
- FTS5 native `snippet()` propagated through `SearchResult` / `IndexStore` / `searchIndexReadonly` for context-aware excerpts
- ModelRegistry, LanceDB

### prompts (utils)
- Added zsh-style file-path input with tab completion
- Voice-memos interactive transcribe UX with shared prompts
- Added `prompts/p/` backend abstraction (clack, opentui) with `offer-install` flow
- Replaced `@inquirer/prompts` with clack `searchSelect` to avoid signal-exit crash (#102)

### utils infrastructure
- Atomic config update, `Stopwatch`, `formatBytes`, lazy logger binding
- Locale-aware `formatDateTime()` with system locale detection (`utils/date`)
- Shared `ApiClient`, cache utility, lazy logger binding (`utils/tools`)
- Added on-demand package installer (`isPackageInstalled` / `ensurePackage` / `ensurePackages`) with rejection-list persistence and TTY prompt
- Replaced `JSON.parse/stringify` with `SafeJSON` (json5/comment-json) (#95)
- Storage: throw on corrupt config instead of silently returning null
- `parseVariadic` moved into `cli/` to unblock `Executor` export

### dependency hygiene
- Removed dead deps: eslint stack, diff2html, md-to-pdf, node-notifier
- Removed react-devtools (Electron app, saves ~451 MB)
- Vector DB clients install on-demand (saves ~206 MB)
- HuggingFace ML stack on-demand (saves ~4.5 GB)
- AST grammars on-demand (saves ~658 MB)

### Windows
- Windows compatibility for azure-devops, clarity, shared utils (#123)
- `install.sh`: setx/PowerShell PATH on Git Bash/MSYS2/Cygwin, stale-path replacement
- `tools.cmd`: CMD/PowerShell wrapper for tool invocation
- `.gitattributes`: enforce LF for `*.sh`/`tools`, CRLF for `*.cmd`/`*.ps1`
- Avoid leading semicolon when user PATH is empty
- cURL DevTools step-by-step instructions for non-technical users; orgId auto-derive

### Tests / CI
- Added E2E test suite and unit tests for all new tools
- Pre-commit hook now mirrors CI checks (biome + tsgo)
- Added type stubs for on-demand packages so tsgo accepts dynamic imports
- Indexer E2E pipeline, SearchEngine integration, Qdrant hybrid, watcher debounce, chunker edge cases, graph cycles
- ASK websearch tests, AIChat retry tests, todo sync tests, darwinkit guard tests

### Fixes
- mcp-manager: pass `space` param in strict `SafeJSON.stringify`; non-TTY guard (#127)
- ask: use `.chat()` for OpenAI v5+; enable file logging (#86)
- claude-usage: prevent OAuth token loss on crash (#75) — atomic persistence + keychain fallback
- Clarity SSR/Vite fixes; date utils; robust auth handling; routeTree generation
- Externalize `bun` in Vite config + `notFoundComponent` for clarity root
- Upgraded `signal-exit` to v4 to fix Bun ESM resolution for `foreground-child`
- Resolved all biome lint/format errors and TypeScript errors across codebase

### docs (CLAUDE.md)
- Documented `SafeJSON` requirement (`JSON` is biome-restricted); strict/jsonl modes

## 2026.03.03.1

### clarity
- Added Clarity PPM integration with `tools clarity` CLI (configure, timesheet, fill, link-workitems, ui)
- Added web dashboard with cyberpunk theme (export, import/fill, mappings, settings pages)
- Added cURL-based auth extraction, timesheet CRUD, and ADO-to-Clarity work item linking
- Added fill command for importing ADO timelog hours into Clarity timesheets with dry-run preview

### claude
- Added interactive Ink TUI dashboard for usage monitoring with 4 tabs (Overview, Timeline, Rates, History), SQLite persistence, rate calculation, and macOS notifications
- Fixed OAuth token loss on crash — tokens now persisted atomically with file lock immediately after refresh
- Added keychain fallback recovery for permanently invalid refresh tokens

### daemon
- Added general-purpose background task scheduler with interval scheduling, retry on crash, JSONL log capture, macOS launchd integration, and interactive clack UI

### azure-devops
- Added `--images` flag to download inline images from work item descriptions and comments, with local path rewriting in generated markdown
- Added `timelog export-month` library function and CLI command
- Added cached work item enrichment service with type definitions

### watchman
- Added `--temporary` flag to auto-unwatch paths on process exit

### migrate-to-codex
- Overhauled scope detection, plugin directory symlinks, and namespace handling
- Improved edge case handling for plugin migration

### UI Framework
- Extracted shared UI component library (`src/utils/ui/`) from claude-history-dashboard
- Added `createDashboardApp` factory, `DashboardLayout`, base Vite config factory, and `@ui/` alias
- Migrated claude-history-dashboard to shared UI framework and TanStack Start server routes

### Skills & Commands
- Added `/question` command for answer-only mode with refinement loop
- Added writing-plans skill
- Added living-docs parallel dispatch documentation
- Moved debugging-master skill into genesis-tools plugin

### json
- Improved format detection matching

### Core
- Added Clarity PPM API client, type definitions, and comprehensive API/auth documentation
- Added cURL command parser utility for cookie/header extraction
- Resolved all TypeScript errors across codebase
- Resolved all Biome lint/format errors and added pre-commit hook
- Added shared Ink component library (`src/utils/ink/`) with reusable UI components and hooks

## 2026.02.26.3

### ask (AIChat SDK)
- Added `AIChat` programmatic SDK for provider-agnostic LLM chat with session management, streaming, and persistence
- Added `ChatTurn` class that is both awaitable (buffered) and async-iterable (streaming)
- Added `ChatSession`, `ChatSessionManager`, `ChatEvent`, `ChatLog` library components with full test coverage
- Refactored CLI single-message mode to use AIChat — removed stdout monkey-patching

### telegram
- Fixed stdout leakage by replacing subprocess calls with in-process AIChat

### azure-devops
- Added automatic Remaining/Completed Work updates after logging time

## 2026.02.26.2

### Skills
- Added git-rebaser skill

## 2026.02.26.1

### ask
- Migrated to @clack/prompts and picocolors

### claude
- Added unified CLI with usage monitoring and multi-account config
- Added OAuth login and watch mode notification rewrite
- Added `migrate-to-codex` command

### telegram
- Added Telegram MTProto client with history and semantic search
- Added Telegram bot with macOS Mail tool and automation framework

### github-pr
- Added analysis report with Explore agents before thread selection

### github
- Fixed review reply truncation, added PR-level comments and author filter
- Preferred `gh` CLI token for `resolveReviewThread`

### Skills & Tools
- Added debugging-master skill
- Migrated 8+ tools to Executor pattern
- Added comprehensive unit tests for `src/utils/`

### azure-devops
- Fixed infinite loop in reporting API pagination
- Split utils into domain modules

### Core
- Tightened Biome lint rules
- DRY consolidation of shared utilities

## 2026.02.18.1

### github
- Added repository search with `--type repo`
- Added notifications and activity feed with browser utility
- Added auto-fallback for `resolveReviewThread`

### claude-history
- Added `summarize` subcommand with 7 LLM-powered modes

### azure-devops
- Added history activity command with cache refactor

### claude-skill-to-desktop
- Added new tool to sync skills to desktop apps

### Tools Browser
- Added interactive tools browser with markdown-cli enhancements

### Skills
- Added delegate PR review replies to background haiku agent

## 2026.02.15.1

### har-analyzer
- Added new HAR analyzer tool

### Core
- Added JSON schema inference utility (`src/utils/json-schema.ts`)

### github
- Enhanced review tool

### claude-history
- Added full metadata extraction, ripgrep search, and auto-reindex

### azure-devops
- Added batch work item downloads and `buildUrl` utility

## 2026.02.13.2

### github
- Added consolidated PR review system

### claude-resume (cc)
- Added session finder tool

## 2026.02.13.1

### azure-devops
- Added work item attachment listing and download
- Added batch API with parallel comments fetching
- Added unified `getWorkItems` function

### github
- Overhauled reactions system — generic sums, split body/comment filters, search support

### timelog
- Added 3-tier child prioritization and cross-work-item queries
- Added delete command

### timely
- Added `--force` cache bypass
- Added `--since`/`--until` aliases

### markdown-cli
- Added new tool for rendering markdown to terminal

### Core
- DRY consolidation of shared utility modules
- Biome linter setup

## 2026.02.07.1

### azure-devops
- Added work item history tracking with WIQL queries

### timelog
- Added natural language time logging
- Added Timely sync skill

### timely
- Added memory caching, day-grouped output, and app name resolution

## 2026.02.06.1

Internal improvements only.

## 2026.02.04.1

### azure-devops
- Added full timelog system: configure, list, types, add, import, interactive mode
- Migrated to Commander subcommands
- Added query name resolution with fuzzy matching
- Increased cache TTL

### git-rebranch
- Added new tool for branch rebasing workflows

### git-rebase-multiple
- Added conflict detection, git pull, and divergence detection

### github
- Added advanced search with deduplication
- Added code search and issue/PR search
- Added pagination for >50 comment threads in PR reviews

### rohlik-spending
- Added new command

### react-compiler-debug
- Added AST prettification with `--with-original` flag

### mcp-manager
- Added config-json, env/headers, non-interactive mode, and safe writing with preview

### mcp-web-reader
- Added pluggable engine system with ReaderLM support

### claude-history
- Added session ID support, relevance scoring, advanced filters
- Added SQLite caching and dashboard with analytics

### json
- Added passthrough for invalid input

### Core
- Migrated all tools from enquirer/minimist to @inquirer/prompts + Commander
- Added `--readme` flag for all CLI tools
- Added @clack/prompts and picocolors
- Set up Biome linter/formatter
- Various type safety and ReDoS fixes

## 2026.01.11.1

### Initial Release
- Added `azure-devops` skill for work item management
- Added `claude-history` tool and skill for conversation search
- Added `github-pr` command for PR review workflows
- Added `jenkins-mcp` server
- Added `setup` command for installation
- Added Raycast `kill-port` extension
- Added Claude Code marketplace plugin infrastructure
