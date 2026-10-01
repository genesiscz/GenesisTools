import AppKit
import SwiftUI

/// Keeps the open transcript still while earlier turns are inserted above what the reader sees.
///
/// A session opens on its newest turns, and the host's fill (GenesisTools: Hub/HubSessionDetail.swift) prepends the
/// earlier ones in chunks. The transcript's `List` is an NSTableView that keeps its scroll offset from
/// the top, so every chunk pushed the rows on screen down by the inserted height, and the scroll back
/// to the previous first row came a pass later and put that row at the top instead of where the
/// reader was: a transcript opened at its latest turn ended 4000 to 10000 pt above it after six or
/// more jumps (`--bench` `open`, 2026-09-25). Rows inserted above the viewport leave everything below
/// it alone, so this holds the viewport's distance from the content's end instead, inside the same
/// layout pass as the insert: nothing on screen moves. While a hold lasts, a move of the viewport
/// that is not the reader's (the table restoring its old offset between two resizes) is undone too.
///
/// A reader at the latest turn also stays there when the content grows below the viewport's top: a
/// tool row whose changes arrive, a turn the live tail appends. The table kept its top, so the latest
/// turn slid out of view by the growth (369 pt once in the bench).
///
/// Growth right after the reader's own click in the list is theirs (a tool call they opened, "… +N
/// lines"): the rows keep their places and the content grows below, so what they clicked stays under
/// the pointer. Pinned to the end, a call opened near the bottom slid its header off the top of the
/// list by the height of its output.
///
/// It also measures the rows on screen again after a hold's move (`remeasureVisibleRows`): its own move
/// inside an insert stops AppKit re-measuring them otherwise. A reader at the latest turn is followed a
/// turn later instead (`scheduleFollow`), which needs no re-measure.
@MainActor
public final class TranscriptScrollAnchor: ObservableObject {
    /// A view in the list's frame (`TranscriptScrollAnchorProbe`), to find the list's scroll view by.
    fileprivate weak var probe: NSView?
    private weak var scrollView: NSScrollView?
    nonisolated(unsafe) private var observers: [NSObjectProtocol] = []
    nonisolated(unsafe) private var inputMonitor: Any?
    /// The viewport's end as a distance from the content's end, held through an insert above.
    private var held: CGFloat?
    private var release: DispatchWorkItem?
    /// The content's height at the last resize: the distance from the end before the next one.
    private var documentHeight: CGFloat = 0
    /// Set while this moves the viewport, so its own move is not taken for someone else's.
    private var adjusting = false
    /// Within this of the content's end is reading the latest turn (the list ends in a 12 pt spacer).
    private static let endSlack: CGFloat = 40
    /// The reader's last click in the list, and how long the growth after it stays theirs (the row
    /// opens on the next layout, its detail lands a few milliseconds later).
    private var readerClickAt: Date?
    private static let readerGrowth: TimeInterval = 1.5
    private var remeasureScheduled = false
    /// The distance from the end a reader at the latest turn keeps, while the follow waits for the pass.
    private var follow: CGFloat?

    /// Call before rows are inserted above the viewport. Until `seconds` pass, or the reader scrolls
    /// or clicks in the list, the viewport keeps its distance from the content's end.
    public func holdForPrepend(seconds: Double = 0.5) {
        guard let scroll = resolve(), let document = scroll.documentView else { return }
        // Never below 0: right after a session switch the viewport can sit past the new content's end,
        // and holding that left a blank screen below the last turn.
        held = max(0, document.frame.height - scroll.contentView.bounds.maxY)
        release?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.held = nil }
        release = work
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: work)
    }

    /// The reader or the list itself moves the viewport now (a scroll, a jump to a prompt). A follow
    /// still waiting for its pass is dropped too, or it would pull the viewport back to the end.
    public func releaseHold() {
        release?.cancel()
        release = nil
        held = nil
        follow = nil
    }

    /// Finds the list once it is on screen, so a reader at the latest turn is kept there from the start.
    fileprivate func attachSoon() {
        guard scrollView == nil || scrollView?.window == nil else { return }
        DispatchQueue.main.async { [weak self] in _ = self?.resolve() }
    }

    /// The list's scroll view: the one with a table inside that covers the probe's frame the most.
    private func resolve() -> NSScrollView? {
        if let scrollView, scrollView.window != nil, scrollView.window === probe?.window {
            return scrollView
        }
        guard let probe, let root = probe.window?.contentView else { return nil }
        let target = probe.convert(probe.bounds, to: nil)
        var best: (scroll: NSScrollView, area: CGFloat)?
        func visit(_ view: NSView) {
            if let scroll = view as? NSScrollView, scroll.documentView is NSTableView {
                let overlap = scroll.convert(scroll.bounds, to: nil).intersection(target)
                let area = overlap.isNull ? 0 : overlap.width * overlap.height
                if area > (best?.area ?? 0) {
                    best = (scroll, area)
                }
            }
            view.subviews.forEach(visit)
        }
        visit(root)
        guard let found = best?.scroll else { return nil }
        attach(found)
        return found
    }

    private func attach(_ scroll: NSScrollView) {
        detach()
        // A follow measured on the previous list's content means nothing on this one.
        follow = nil
        scrollView = scroll
        guard let document = scroll.documentView else { return }
        documentHeight = document.frame.height
        document.postsFrameChangedNotifications = true
        scroll.contentView.postsBoundsChangedNotifications = true
        let center = NotificationCenter.default
        // No queue: the blocks run inside the resize or the move, before the frame is drawn.
        observers = [
            center.addObserver(forName: NSView.frameDidChangeNotification, object: document, queue: nil) { [weak self] _ in
                MainActor.assumeIsolated { self?.documentResized() }
            },
            center.addObserver(forName: NSView.boundsDidChangeNotification, object: scroll.contentView, queue: nil) { [weak self] _ in
                MainActor.assumeIsolated { self?.viewportMoved() }
            },
        ]
        // A scroll, a click or a key in the list is the reader's: the viewport is theirs from then on. A key
        // counts while the list has focus (Page Up, the arrows, Home, End, space).
        inputMonitor = NSEvent.addLocalMonitorForEvents(matching: [.scrollWheel, .leftMouseDown, .keyDown]) { [weak self] event in
            MainActor.assumeIsolated {
                guard let self, let scroll = self.scrollView, event.window === scroll.window else { return }
                let reader = event.type == .keyDown
                    ? (scroll.window?.firstResponder as? NSView)?.isDescendant(of: scroll) == true
                    : scroll.bounds.contains(scroll.convert(event.locationInWindow, from: nil))
                if reader {
                    self.releaseHold()
                    if event.type == .leftMouseDown {
                        self.readerClickAt = Date()
                    }
                }
            }
            return event
        }
    }

    private func documentResized() {
        guard let scroll = scrollView, let document = scroll.documentView else { return }
        let height = document.frame.height
        // The viewport has not moved yet: this is where its end sat before the resize.
        let before = documentHeight - scroll.contentView.bounds.maxY
        documentHeight = height
        if let held {
            keep(held)
            // Only this move inside the resize costs the rows on screen their height listener.
            scheduleRemeasure()
        } else if follow == nil, before <= Self.endSlack, !readerIsChanging {
            scheduleFollow(max(0, before))
        }
    }

    /// A reader at the latest turn follows the growth below the viewport's top one turn later, once per
    /// pass. The rows on screen keep their places meanwhile (the table keeps its top), so nothing jumps:
    /// the new rows appear a turn late. Moving inside the resize, as a hold must, left the rows on screen
    /// without their height listener and needed `remeasureVisibleRows` after every appended turn, which
    /// measured the table again: 2.1 s of the 2.75 s main thread a streamed session cost in
    /// `testStreamingCost`, and the most common main-thread stall of the live hub (2026-09-30: 179 of
    /// 273 stall stacks in 48 h, p50 1.3 s). A resize fires several times per pass as rows measure;
    /// the first one's distance is the reader's.
    private func scheduleFollow(_ distance: CGFloat) {
        follow = distance
        DispatchQueue.main.async { [weak self] in
            MainActor.assumeIsolated {
                guard let self, let distance = self.follow else { return }
                self.follow = nil
                self.keep(distance)
            }
        }
    }

    /// `keep` moves the viewport inside the resize of a row insert under a hold (the idle fill
    /// prepending turns). That move leaves
    /// each row view on screen without its automatic-row-height listener
    /// (`NSTableRowView._layoutEngineChangeListener`, set up again only for a row that scrolls into
    /// view). A row without it never reports a new height, and `noteHeightOfRows` returns the cached
    /// one: a tool call opened after the transcript followed a running session kept its closed height
    /// and its output drew under the rows below (Martin, 2026-09-28; `SessionTranscriptScrollTests`
    /// `testARowOnScreenWhenTurnsArriveStillOpensToItsOutput`). Measured with this remeasure off: rows
    /// streamed in under the move stuck 2 runs of 2, the same rows without the move opened 2 of 2.
    /// A hold's move cannot wait a turn, or the rows on screen would jump for one frame. So after it,
    /// automatic row heights go off and on: the rows on screen are measured again and get their
    /// listeners back. On the next turn of the main queue, after the insert's own layout. This measures
    /// far more than the rows on screen (about 230 ms per call in `testStreamingCost`), which is why
    /// the follow at the latest turn does not move inside the resize.
    private func scheduleRemeasure() {
        guard !remeasureScheduled else { return }
        remeasureScheduled = true
        DispatchQueue.main.async { [weak self] in
            MainActor.assumeIsolated { self?.remeasureVisibleRows() }
        }
    }

    private func remeasureVisibleRows() {
        remeasureScheduled = false
        guard let table = scrollView?.documentView as? NSTableView, table.usesAutomaticRowHeights else { return }
        PerfLog.span("transcript.remeasureRows \(table.numberOfRows) rows") {
            table.usesAutomaticRowHeights = false
            table.usesAutomaticRowHeights = true
        }
    }

    private var readerIsChanging: Bool {
        readerClickAt.map { Date().timeIntervalSince($0) < Self.readerGrowth } ?? false
    }

    private func viewportMoved() {
        guard !adjusting, let held else { return }
        keep(held)
    }

    /// Puts the viewport's end `distance` above the content's end.
    private func keep(_ distance: CGFloat) {
        guard let scroll = scrollView, let document = scroll.documentView else { return }
        let clip = scroll.contentView
        let y = max(0, document.frame.height - clip.bounds.height - distance)
        guard abs(clip.bounds.origin.y - y) > 0.5 else { return }
        adjusting = true
        clip.scroll(to: NSPoint(x: clip.bounds.origin.x, y: y))
        scroll.reflectScrolledClipView(clip)
        adjusting = false
    }

    nonisolated private func detach() {
        observers.forEach(NotificationCenter.default.removeObserver)
        observers = []
        if let inputMonitor {
            NSEvent.removeMonitor(inputMonitor)
        }
        inputMonitor = nil
    }

    deinit {
        detach()
    }
}

/// Put in the transcript list's background: tells the anchor where the list is.
public struct TranscriptScrollAnchorProbe: NSViewRepresentable {
    public let anchor: TranscriptScrollAnchor

    public func makeNSView(context: Context) -> NSView {
        let view = NSView()
        anchor.probe = view
        return view
    }

    public func updateNSView(_ view: NSView, context: Context) {
        anchor.probe = view
        anchor.attachSoon()
    }
}
