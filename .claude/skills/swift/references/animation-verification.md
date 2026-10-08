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

## Hosting size and native panel anchoring — 2026-10-08 08:40

When an NSPanel owns its animated frame, disable NSHostingView's automatic window sizing with
`sizingOptions = []`. A fixed-size SwiftUI child otherwise competes with the panel's frame setter:
in the verified edge-panel fixture that moved the right edge by398points. Disabling automatic
window sizing kept the edge error at0points in three before/after pairs; native layout CPU fell
from6.647% to5.713% in that fixture. These are fixture results, not whole-app or display-FPS claims.
Anchor each intermediate frame after AppKit rounding, not just the final target, and keep visible
content and hit regions aligned. A generic comparison/settings window needs ordinary movable
window geometry; it must not inherit the edge panel's placement loop.

Put process ID and native window number in transition logs when multiple app faces share a file.
A nearby transition line is not proof of which app or panel performed it.

The native snapshot command inspected in this session returns an app's first AX window. That
window is not necessarily its key window. Verify keyboard focus with actual input and the
resulting sheet/state; do not infer it from the first window's title alone.

## Attached-sheet screenshots — 2026-10-08

A CG window-only capture can contain the dimmed parent while omitting its attached SwiftUI
sheet. A successful PNG write is not visual proof of the sheet. Inspect the image. The verified
licence-sheet capture used the live AX sheet's global rectangle with screen capture; its receipt
records those bounds, parent window ID, PID, installed build and PNG hash. Preserve rejected
parent-only captures separately instead of labeling them as the completed UI.

## Stable rail controls and narrow scroll viewports — 2026-10-08

A rail must not fill the expanding conversation's height. The joined Widget previously moved its
controls about 95 points when the window grew from 354 to 544 points. Keeping sideStripContents at its measured
compact height, centered beside the content, produced identical global AX control coordinates through
354 → 608 → 354 point windows. Check control rectangles, not only the window's anchored right edge.
Keep known session IDs in stable order while status and activity metadata refresh; an unchanged icon
position is unsafe if its underlying recipient silently changes.

SwiftUI's narrow vertical ScrollView can report a viewport 61 points wide for content 44 points wide when
scrollbar space is added. Check the actual NSScrollView bounds against its host and prove that the
last control remains reachable. OverlayScrollViewport uses an explicit sizeThatFits proposal, overlay
scroller and measured document height; WidgetRosterTests covers both sides, styles and short heights.
Do not copy the frame-owned window root's sizingOptions=[] onto the measured NSHostingView document:
its fitting height became 0 in this experiment. Retain document sizing and update its frame from fittingSize.

## Recent-message positioning and transcript preloading

Use separate scroll anchors for initial position, content-size changes and short-content alignment.
On macOS15+, LatestScrollAnchor opens a conversation at the bottom, follows new content only while
the reader is near the end, and keeps short conversations top-aligned. Reduce scroll geometry to an
Equatable Boolean so per-pixel changes do not invalidate the parent view. Keep a version-gated fallback.
See Apple's [scroll anchor roles](https://developer.apple.com/documentation/swiftui/scrollanchorrole)
and [scroll geometry callback](https://developer.apple.com/documentation/swiftui/view/onscrollgeometrychange%28for%3Aof%3Aaction%3A%29/).

A first scrollTo can stop short while lazy rows still have estimated heights. Reuse
ScrollViewPositioning for an explicit jump; it preserves the existing Hub's bounded layout passes.
Verify the actual native viewport reaches the target after layout, rather than asserting merely that
its offset became positive. Test both initial latest-message placement and preservation of a reader
who scrolled up. A successful single-test run does not rule out ordering effects between hosted views.

SessionTranscriptCache bounds hover preloading to three recent envelopes for15seconds. Its key includes
recipient identity, provider, transcript query/path and requested limit. Preserve the envelope's
nextOffset when starting the live tail, so intervening turns are caught up. Decode off the main actor,
coalesce hover/open loads, cancel unused work, and reject late results even if a loader ignores cancellation.
Measure the added CLI work and resident memory as well as time removed from a click; a cache hit is not
a rendered-frame or FPS measurement.
