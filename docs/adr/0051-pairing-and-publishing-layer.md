---
status: Accepted
date: 2026-11-26
---

# Put pairing and publishing in the shared package and keep the tools as doors

The first share server (2026-11-26, commit 2c03700fc5) lives inside one tool: `src/dev-dashboard/lib/share/` holds
the targets, the drivers, the device store, the upload check and the server. The owner asked on 2026-11-26 01:20
for a harness that every tool can publish through ("the artifact (tools artifact) and tools dev-dashboard will be
just consumers of this harness"), with one host that serves `/md/<id>` and `/artifact/<id>`. Plan
`.claude/plans/2026-11-26-PairingAndPublishing.md`.

The mechanism moves to `@genesiscz/utils` in three layers. `src/utils/device-pairing/` holds the trust between two
machines: a one-time code (8 characters, 10 minutes, dropped after 5 wrong tries) is traded for a token of 256 random
bits, the server keeps only its SHA-256, the client keeps it as a `SecureRef`. `src/utils/publish/` holds what a
published kind is (`definePublishedKind`: an id that is also the URL namespace, an upload limit, the file names a
snapshot may hold, a check of the uploaded files), the server half of a kind (`serveKind`), the snapshot store with
its bounded unzip and atomic swap, the server with its admin socket, and the transports behind one interface and
one table: `paired` (HTTPS, or HTTP to a private address such as a WireGuard one), `ssh-rsync` and `mac-live`.
`src/utils/genesis-tools/publish/` binds it to GenesisTools: the store under `~/.genesis-tools/publish/`
(targets nested by transport, and a ledger of what was sent where and when), `publisher(kind)` and the command
functions in `src/utils/genesis-tools/tools/publish.ts`. Every kind gets freshness from the same two places: the
manifest's `snapshotAt` and `sourceModifiedAt`, and the ledger's sync record per target.

The server's composition root stays the dev-dashboard command (`tools dev-dashboard share-server`), because the md
page is rendered by dev-dashboard's own route code and the shared package cannot import a tool. The artifact kind
serves a file, so its server half lives in the shared package and the root imports no second tool.
`tools artifact publish` and `tools dev-dashboard share` are thin callers of `publisher(kind)`. No neutral
`tools publish` is added: it would need a new tool-to-tool import. Main disadvantage: a server that also serves
artifacts carries the name of one tool, and a second rendered kind owned by another tool forces that choice again.

Pages are `<origin>/<kind>/<id>`. Each kind keeps its upload API below its own namespace
(`/<kind>/_api/snapshots`), where the deployed server already has it for md, so a client of the new layer still
publishes md to a server that was not updated. Pairing, health and whoami are server-wide under `/_api/`. The live
page of the Mac's own dashboard stays on its own host and path; the always-on host is a second server. This is the
planner's reading of "i want the server to keep it on mac" together with "share…/md/<shareid>".

Saved shapes that already exist are migrated, never dropped: the `share` block of the dev-dashboard config and the
per-note targets move into the publish store at the first mutating command (the store wins when both hold a
target, a status command never writes), and the server moves `<data>/<id>/` into `<data>/md/<id>/` when it starts.

Not chosen: static pages rendered on the client (the server would need no tool code, but the asset, source and
download views of a note would need a new snapshot format, and the deployed server could not take it); one
versioned API root for all kinds (cleaner, but it needs a fallback in every client while an old server runs); an
opaque-origin sandbox for artifact pages (the artifact kit reads `localStorage`; any paired device is the owner's,
so a page is as trusted as its uploader); a snapshot owner per device and per-address rate limits (all devices
belong to one person; a minimum of free disk refuses an upload that would fill the host).
