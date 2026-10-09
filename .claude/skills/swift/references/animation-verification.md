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
in the verified edge-panel fixture that moved the right edge by 398 points. Disabling automatic
window sizing kept the edge error at 0 points in three before/after pairs; native layout CPU fell
from 6.647% to 5.713% in that fixture. These are fixture results, not whole-app or display-FPS claims.
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

## Top-edge panels must pass the system hit-test (2026-10-08 19:56)

A window-only screenshot can show a perfect top notch while macOS routes the same screen point to `AXMenuBar`. Verify the center of an observed button with `tools control hittest --at <x,y>` before treating a hover/click refusal as stale automation. Negative display origins are valid coordinates; retain the observed window, point, and hit-test receipt.

For a panel occupying the menu-bar band, choose its final level after setting `isFloatingPanel`. In the measured AppKit path, setting `isFloatingPanel = true` reset a previously assigned status-bar level back to floating (raw 3), below the main menu (raw 24). The regression passed only when `.statusBar` was assigned afterward. Side panels keep `.floating`; do not raise every window to solve one top-edge hit-test bug. Also verify normal system menus remain usable outside the notch.

A compact-to-preview expansion can move child controls away from a stationary pointer and emit child `onHover(false)` followed by another container hover. Keep the last agent hover identity through that reflow; clear it on leaving the whole surface, opening a destination, collapsing, dragging, or stopping. Cover the sequence with different hovered/selected sessions so an accidental selected-session preload cannot pass. Log the cache identity, not only “30 turns”, when correlating the UI with the read.

## Icons stay anchored during expansion

Keep the control rail in its own edge-aligned overlay, with its own measured height. Expanded body
content may grow beside it; it must not determine the rail's position. Anchor every rounded native
frame to the same screen edge, and disable automatic hosting-window sizing only at that frame-owned
root. Measured scroll documents still need their own fitting-size behavior.

A panel can have correct settled geometry while controls leave its bounds during animation. A fixed-width body and rail in one centered HStack overflow the intermediate native window width. Test the actual hosted control frame during interrupted open/close, not just window edges or the final AX tree. The widget regression sampled 38 frames per side: the old stack wandered across 137 pt / 280.5 pt; a rail independently overlaid at the edge stayed within 0.5 pt. Keep one owner of frame animation; an additional implicit SwiftUI layout animation can fight AppKit's window interpolation.

## The top notch resizes to fit its contents

Badges that change the necessary chrome size belong in measured layout, not offset overlays outside fixed allocations. Measure intrinsic, unproposed child sizes, round to whole points, reject unchanged measurements, and defer native-window updates until after the SwiftUI transaction. Reserve symmetric wings around a physical camera cutout. Do not feed the current animated window width back into its desired intrinsic width.

The live badge-arrival check grew the top bar from 283 × 39 pt to 307 × 39 pt while its center
and top edge stayed fixed. Verify both arrival and removal, empty and crowded content, cutout and
non-cutout displays. Intrinsic size is the target; the native frame controller animates toward it.
A first or last icon outside the shape is a layout failure even if the window is correctly centered.

## Drag a moving window using screen coordinates

A gesture's window-local translation is unstable when that gesture moves the window. Capture the mouse-down and subsequent event positions in screen coordinates, preserve the rail's current height while dragging, and clamp only the final normalized position. A native NSView handle can own mouse-down/drag/up without a tracking poll. Give it its own accessibility identity; identifying the decorative image underneath it makes hit tests disagree. Verify real pointer input as well as injected coordinate arithmetic. A screenshot-based drag tool may deliberately reject moving windows, so record that refusal separately from application behavior.

## Intrinsic targets versus intermediate layout proposals

A top bar needs two widths: its unproposed intrinsic target and the width available in the current
animated native frame. Cache the target from child intrinsic sizes, but let sizeThatFits respect the
smaller proposed width during expansion. Place controls against the current bounds rather than the
future frame. Returning the full target at every frame made a hosted button start at x=-53 and x=-33
in a 120/160-point host; the corrected layout keeps its minimum x at zero. The regression deliberately
restores the wrong sizeThatFits result and must fail those actual hosted-view assertions.

When no physical cutout is reserved, keep control groups next to each other. Positioning the second
group against the final right edge makes it jump ahead of the animated frame. Defer intrinsic-size
notifications until after the SwiftUI transaction and ignore unchanged whole-point measurements.

## Reconfigure retained panels

Changing module membership should reconcile panels by stable surface identity and display. Replace
only surfaces whose identity/display changed; update an existing NSHostingView root and animate its
new geometry. Hiding and recreating every controller for one toggle discards animation continuity.
Verify native window IDs survive both insertion and removal, and restore the exact original preference.
The live fixture retained its top/side IDs through 360↔393-point width and 239↔278-point height changes.

## Interactive chart verification

A horizontal scroll view does not prove mouse-drag support on macOS. Verify wheel/trackpad scrolling,
direct mouse dragging, zoom buttons, and changing plot style separately. Keep drag origin stable for a
gesture, clamp to the data domain, and clear it on cancellation. An injected drag refused by automation
is neither a passed interaction nor proof of an application bug. The verified direct mouse drag moved
the timeline start from23:29 to23:07; a preceding background attempt was refused before input.

Bound marks before handing data to Swift Charts, select visible ranges with binary search, and bin
counts without changing their sum. Use Calendar boundaries for daily bins over daylight-saving changes.
Preserve sparse samples: a single point needs a visible mark, and an unrecorded interval is not known zero.
Publish coalesced snapshots rather than copying growing dictionaries per keystroke. Clearly label sample
data and keep its reference day fixed so a midnight change does not turn its summary into a false zero.

## Window-only recording and controlled motion

Screen-region recording captures whichever application covers the region. It does not isolate the
intended window. A selected-window recording was verified behind another foreground window; inspect
actual decoded frames, not merely successful ffprobe output. Attached sheets may still need their own
selection. Preserve logical-point bounds, actual pixel dimensions and native build identity.

Keep the recorder alive until its real completion and dispatch the intended interactions inside that
same bounded capture interval. A detached child can be terminated when its tool invocation ends; model
round trips can also outlast a short movie. A clean recording with no action in it proves no animation.
When the user is interacting concurrently, record that limitation and repeat in a quiet interval before
attributing hover or window changes to a layout regression. Record callback timing separately from
movie FPS; neither establishes compositor frame delivery.
