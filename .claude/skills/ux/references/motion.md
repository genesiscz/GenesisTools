# Verifying motion

## Three instruments, in this order
1. **Window server truth**: `scripts/native/window-frames.swift` (swiftc -O it) prints a window's real bounds
   every 4 ms. It shows when a resize starts, how long it takes and whether it steps evenly.
2. **App truth**: every edge-panel transition logs
   `edge.transition … elapsed= callbacks= first= gap-max= work-total=` to ~/.genesis-tools/logs/app-perf.log.
   Healthy: first ≤ 30 ms, ~60 callbacks/s for the whole duration, no gap above 25 ms. `first=250ms` means the
   main thread built something heavy before the first frame; one big gap mid-transition means a teardown or
   rebuild landed inside the animation.
3. **Looks**: `widget-drive.ts record --seconds N --out <dir> "<t>:<command>" …` (ScreenCaptureKit, crop canvas),
   then `ffmpeg -ss <start> -t <len> -i recording.mp4 -vf "crop=…,scale=250:-1,tile=6x3" sheet.png`.
   ffprobe frame times show the bursts. Caveat: ScreenCaptureKit drops the intermediate sizes of a resizing
   window, so a recording can show a snap that the window server never did; trust instrument 1 for size.
   `--canvas display` films display 0 only; the default crop follows the windows.

## Shapes that caused jank here
- `.transition(...)` with no animation context is inert: the view vanishes at once.
- Content switched before the frame animation started leaves an empty card on screen.
- A fade that ends mid-resize moves the (expensive) teardown into the animation.
- Building a large SwiftUI tree on expand delays the first frame; make the content cheap, build it before the
  motion, or keep it alive if that costs nothing at idle (measure idle CPU).
- Decoding JSON snapshots on the main thread competes with animation frames.
