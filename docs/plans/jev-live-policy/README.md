# Jev live policy — specs on top of PR #409

These contracts sit on `feat/jev-gateway-lab`. They do not redo phase 2
(semantic waits, recovery, rebind, host escalation, native OCR). They
add the bookmark layer: Jev as live policy on see/act.

| Feature | v1 | v2 | Implement in this PR? |
|---|---|---|---|
| listen | listen.v1.md | listen.v2.md | yes |
| wake-word | wake-word.v1.md | wake-word.v2.md | v1 stub + spec |
| route | route.v1.md | route.v2.md | yes |
| compact | compact.v1.md | compact.v2.md | yes |
| github-pr hook | github-pr-compact.v1.md | github-pr-compact.v2.md | spec only |
| observe / assist fan-out | observe.v1.md | observe.v2.md | yes |
| screen / verify | verify.v1.md | verify.v2.md | yes |
| watch | watch.v1.md | watch.v2.md | yes |
| goal loop (AX + browser) | loop.v1.md | loop.v2.md | yes |
| demo reel | demo.v1.md | demo.v2.md | yes |
| prefetch | prefetch.v1.md | prefetch.v2.md | yes |

Suggested order from the product note: observe, compact, listen, route,
watch, screen. Implementation may proceed in parallel as long as
`GoalSurface` and `LiveSttSession` stay the shared types.
