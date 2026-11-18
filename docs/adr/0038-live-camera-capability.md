---
status: Accepted
date: 2026-11-18
---

# Advertise camera changes only when the engine can apply them

The full recorder starts its camera with the take and currently has no live camera RPC. Keep camera on/off in
setup and show the reason it is unavailable during a take. A live toggle that only changed the bar would
misrepresent what was being captured.

`.claude/plans/2026-11-18-RecorderControlBar.md`, "The engine seam (two implementations, one protocol)", "P6: the full recorder on the bar".
