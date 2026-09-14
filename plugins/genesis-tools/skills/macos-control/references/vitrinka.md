# Vitrinka publishing (optional)

Board publishing for screenshots and recordings. Only when the user asks to share, annotate
or discuss, never by default. It needs the `vitrinka` CLI and a reachable server. Native
Computer Use, Peekaboo and `tools control` all work without it.

Keep evidence local and view it yourself before publishing anything. Verify the image
contains the intended app and window, and no unrelated personal UI. Preserve any redaction
the user asked for.

## Division of labour

`vitrinka snap` takes a single STILL per call. It has no video, no multi-frame and no
motion-diff capability. This skill owns motion; vitrinka owns publishing and annotation. For
a single still that goes straight to a board, skip the capture runner entirely and use
`vitrinka snap`.

⚠️ `vitrinka snap --region` takes global screen POINTS. The capture runner's crop regions are
FRAME pixels, which is points times the scale factor. Do not mix them.

## Direct publish from a capture plan

The capture runner can publish itself. Add to the plan:

```json
"vitrinka": {
  "project": "<p>", "key": "<key>", "branch": "<b>",
  "board": "<slug>", "include": ["strip", "crops", "frames"]
}
```

`include` is an additive filter; crops and the strip are computed regardless. Shot titles
derive from crop labels and timestamps. The runner inits, adds, pushes the set, imports to the
board, and relays the server URLs in its output.

🛑 **Dead-publish guard:** when motion actions fired but the recorder kept one frame or fewer,
publish is refused. Fix the plan. Never pass `vitrinka.force` to silence it. Uploading a
picture does not validate the action that was meant to produce it.

## Manual publish (pick the frames yourself)

```bash
mkdir -p <root>/shots && cp <session>/keep-000{2,3,4}.png <root>/shots/
cd <root>
vitrinka remote-init --root . --project <p> --branch <b> --key <key>
vitrinka add --root . --file shots/<frame>.png --surface web --route <r> \
  --label "T+1.1s" --title "<state>" --note "<what this frame proves>" --action "<edge to next>"
vitrinka push --root . --title "<set title>"
vitrinka board-from-set --root . --slug <board-slug> --btitle "<board title>"
```

Then one `compose_board` MCP batch for the findings section: a callout per finding, plus a
decision callout with suggested fixes.

🛑 **Relay only server-printed URLs** (the `board-from-set` or `push` output, or the MCP
response `url` field). Never hand-construct a board URL; a hand-built path omits the workspace
segment. The runner's optional publishing fields are documented by
`tools control capture --help`.
