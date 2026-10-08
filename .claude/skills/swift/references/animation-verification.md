# Verifying animated native surfaces

Use this with measuring.md when replacing SwiftUI motion with AppKit/Core Animation or changing
an edge panel. These checks came from reproduced visual and measurement failures, not API guesses.

## Preserve geometry as well as motion

A stroked Circle uses its proposed rectangle as the path bounds; the stroke extends on either side.
Do not automatically inset a replacement CAShapeLayer path by half its line width. That matches an
inside stroke, not necessarily the original SwiftUI view. A 9-point widget spinner with a 2-point
stroke became a 7-point path after this inset, visibly shrinking it despite its lower CPU use.

Compare the exact view size, path radius, trim fraction, line cap, rotation direction, speed and color.
Render old and new side by side at the real small size; inspect magnified output only as an aid.
Check Reduce Motion from both the app preference and the system accessibility setting. Removing the
animation must leave a legible static indicator, and reattaching the view must restart only when allowed.

## Measure the work inside a frame

NSAnimation is not proof of timer-based scheduling. On the inspected macOS runtime its call stack
already used an AppKit display link. Replacing it with another display link would not remove expensive
NSHostingView layout caused by setFrame(display: true).

Instrument transition callbacks without adding a polling timer. Record callback count, gap distribution,
longest gap, callback work and interruption/completion outcomes. Attribute CPU with a trace before
changing scheduling. An open-close-open sequence must resume from the visible frame, finish at the
latest target and avoid a stale completion applying an obsolete frame.

## Separate three different measurements

- Callback cadence describes when application code ran.
- Compositor frames and hitches describe what the display pipeline produced.
- A recording's FPS describes the sampling rate of the evidence video.

None substitutes for another. The Core Animation FPS instrument was unavailable for macOS in the
tested xctrace configuration; a failed instrument is not a zero-drop result. Use supported trace data,
inspect the recording, and label callback timing as callback timing. Keep recording outside CPU A/B
samples because recording itself adds load.

## Prove which build was seen

Store the source commit, dirty status, native source digest, build time and binary hash in the preview
bundle. Before a screenshot, verify the process launched after that build. Include the exact PID,
window geometry and image hash in the screenshot receipt. A successfully compiled replacement does
not prove the already-running process contains it.

Reject a capture labeled expanded or hover if its measured geometry is still compact. A vertical
rail can be tall while still compact; check width as well as height. Use a fresh exact window identity
when several panels expose identical accessibility labels. Otherwise an action can open the top panel
while the saved side image remains compact.

Historical reconstructions keep their historical SHA after later rebases. Mark them reconstructed,
and disclose fixture timeouts or unavailable states rather than relabeling the closest image.

## Trace hygiene

Treat raw Instruments traces and exported table-of-contents files as private: they can include the
entire process environment. Do not print their headers or publish raw files. Export only the required
timing/stack tables or use an analysis tool's JSON-only output. Preserve raw evidence locally with
restricted permissions; distribute a timing-only report.
