---
status: Accepted
date: 2026-11-18
---

# Track physical seats independently of call membership

A person can leave the call and keep speaking through a microphone in the room. Store physical occupancy as
half-open intervals with gaps and changes of side. Preserve legacy whole-meeting room strings and existing
remote entries and microphone groups. Intersect mapped occupants with the line span. Taking the bounds of a
roster stay as the bounds of a seat would lose speech before joining or after leaving.

`.claude/plans/2026-11-18-MeetingsRoomAndCallPresence.md`, "Interface freeze", "P1R: R1. Timed seats in records, RPC and the editor".
