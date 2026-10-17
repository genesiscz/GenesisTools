# Camera, Vision and on-screen effects (PostureWatcher, 2026-10-14)

Lessons from making GenesisKit's camera, pose and screen-effect pieces cheap and correct on a real Mac with three
displays. Each line has the number that proved it and the commit.

## Camera frames
- Ask the video output for the size you analyse. The Studio Display camera has no 640 x 480 preset and delivered
  1920 x 1080, so every Vision request ran on 6.75 times the pixels: PostureWatcher took 22% of a core against a 3%
  budget. The output now asks for the active format scaled to 640 px on its longest side, keeping the aspect ratio
  (1d1c60be0). Check the delivered size in a saved frame, not the preset you asked for.
- Analyse only as often as the decision needs. Balanced watches a slouch at 4 frames a second instead of 10; the
  confirm delay still sees the recovery in time, and Responsive keeps 10 (313121c48).
- A wrong baseline costs CPU too: a calibration taken while the pose engine found no shoulders kept the state at
  "slouching" for hours, so the effect stayed up and Genesis sat near 20% of a core. Name the fix in the UI ("Shoulders
  not found", "Recalibrate to use shoulders", GenesisPlayground 9f6431a8, 8b00ff69) instead of tuning thresholds.

## Vision pose results
- A cached result is not a sighting. Merging the last 3D shoulders into throttled frames kept `hasPerson` true after
  the user left, and with no nose the scorer read a full head drop instead of "away". Cached joints count only on a
  frame with a confident 2D joint or face of its own (afbf2ebd6, test `testCachedShouldersDoNotKeepAPersonWhoLeft`).
- 2D body pose misses shoulders often (close to the camera, loose clothes); test with real frames. Genesis saves the
  exact analysed frames plus the pose sample with `genesis://posture/capture?label=<name>` (GenesisPlayground
  a057c1ee). Frames of the user's face stay out of git: they live in `src/macos/GenesisKit/Tests/PostureShots/`, which
  only the local `.git/info/exclude` hides, so stage exact paths.

## Screen-effect panels
- A clear window still costs WindowServer a blend of everything under it. Transparent drew only a message pill but put
  a clear panel over every display (2560 x 1440, 3440 x 1440, 2056 x 1329): WindowServer measured 104% with the
  effect running against 74.5% paused; with a 720 x 96 panel at the pill's place, 92.5% against 75.5% (one-off
  readings on a busy machine; the baseline alone moved between 64% and 83%) (f3dd3ff79). Size an overlay window to
  what it draws.
- Effect panels use `sharingType = .none`, so screenshots and window captures never show them. Verify placement with
  window bounds from `CGWindowListCopyWindowInfo`.
- A draggable overlay moves in its own `mouseDragged`, from each event's location, and saves on mouse-up.
  `performDrag(with:)` moved the panel only on the first drag of a show, and a standalone repro missed its targets
  (381, 81, 381 for 500, 200, 500) (5a700ebd1, 941db1c37). The ux skill's ledger has the full story.
- A unit test that gives a controller a `UserDefaults(suiteName:)` writes a real plist into ~/Library/Preferences.
  Remove the domain in a teardown block (`removePersistentDomain`); macOS still leaves an empty 42-byte file
  (9a11d77bd).
