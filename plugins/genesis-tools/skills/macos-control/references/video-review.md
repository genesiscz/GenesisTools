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

A sheet is at most 4096 px wide and a tile is the frame scaled down, never up: each sheet in the manifest
carries `tileWidth`, `tileHeight` and `scale` (how many times the tile shrinks the source). Pick the frames
per image from the source width so the scale stays at 2 or less: a whole Retina display (about 4100 px)
takes 4 per image, a 2560 px capture 8, a 1920 px one 16; 32 only fits a source under about 1400 px. The
widget's frame review starts there by itself. At a scale above about 3 no text of a screen recording
survives, and a reader shrinks a wide image once more, so judge text on the full-resolution frame of
that moment (`frames[].path`), cropped to the pane in question when the display is large.

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
