# Review an existing local video

Offline extraction does not replay UI actions or make a new recording.
For recording an animation and the exact top/side 36-tile ffmpeg layouts, see
[capturing-animations.md](capturing-animations.md). Prefer the existing video tool for timestamped
contact sheets; use the custom layouts only when that shape improves the inspection.

~~~sh
tools video probe /absolute/path/demo.mp4 --json
tools video frames /absolute/path/demo.mp4 --fps 2 --frames-per-image 16 --out /absolute/path/evidence --json
~~~

Choose 1, 2, 3 or 4 FPS and 1, 4, 8, 16 or 32 frames per image.
The JSON result includes contact-sheet paths, full-resolution PNG paths, requested/actual timestamps and
a manifest path. Read selected sheets first, then inspect full-resolution frames where necessary.

The --difference 0 setting retains all samples. A positive percentage skips candidates whose changed-pixel
percentage is strictly lower than that value, comparing with the last kept frame. The first sample stays.
A reduced selection is evidence filtering, not proof that omitted frames are unimportant.

To inspect different moments, run the command again with a different sampling density, using the original
video path. Every run creates its own immutable generation. Do not describe source frames as having
occurred at the requested time when the manifest reports a different actual timestamp.

Use references/capture.md for a new live screen capture and references/automation-playbooks.md for
recapturing an interaction. Recapture can repeat real actions, so first decide whether decoding the
existing video already answers the question. Do not replay actions just to make another contact sheet.

For isolated transparent video, use ProRes 4444 MOV. H.264 MP4 cannot carry alpha.
A black-looking player background does not prove transparency was lost: inspect decoded PNG
alpha, with a fully transparent background pixel and an opaque selected-window pixel as the
controls. The recorder's `geometry` history records the canvas and each selected window's
logical bounds, source backing scale and output pixels per point. Inspect frames before and
after a move/resize; the movie keeps fixed dimensions and aspect-fits the live canvas.
