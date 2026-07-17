# Vitrinka publishing (optional dependency)

Board publishing for recordings — only when the user asks to share/annotate/discuss; never by default. Requires the `vitrinka` CLI + reachable server; everything else in this skill works without it.

## Division of labor

`vitrinka snap` is a single STILL per call (simctl/adb/`screencapture -x`/adopt-a-file) — NO video, multi-frame, or motion-diff capability. This skill owns MOTION; vitrinka owns publishing/annotation. For a single still that goes straight to a board, skip the capture runner entirely — `vitrinka snap` is the right tool (its `--region` takes global screen POINTS, not frame pixels — don't confuse with the runner's crop regions, which are FRAME retina pixels = points × scaleFactor).

## Direct publish from a capture plan

The capture runner publishes itself — add to the plan:

```json
"vitrinka": {
  "project": "<p>", "key": "<key>", "branch": "<b>",
  "board": "<slug>", "include": ["strip", "crops", "frames"]
}
```

`include` is an additive filter (crops/strip still computed regardless); shot titles derive from crop labels/timestamps; the runner inits/adds/pushes the set and imports to the board itself, relaying server URLs in its output. **Dead-publish guard:** when motion actions fired but peekaboo kept ≤1 frame, publish is refused — fix the plan rather than passing `vitrinka.force`.

## Manual publish (pick frames yourself)

```bash
mkdir -p <root>/shots && cp <session>/keep-000{2,3,4}.png <root>/shots/   # frames that tell the story
cd <root>
vitrinka remote-init --root . --project <p> --branch <b> --key <key>
vitrinka add --root . --file shots/<frame>.png --surface web --route <r> \
  --label "T+1.1s" --title "<state>" --note "<what this frame proves>" --action "<edge to next>"
vitrinka push --root . --title "<set title>"
vitrinka board-from-set --root . --slug <board-slug> --btitle "<board title>"   # → prints the board URL
```

Then one `compose_board` (MCP) batch for the findings section — callouts per finding + a decision callout with suggested fixes.

**Relay only server-printed URLs** (`board-from-set` / `push` output or the MCP response `url` field) — never hand-construct one (hand-built paths omit the workspace segment).
