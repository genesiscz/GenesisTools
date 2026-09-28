import AppKit
import SwiftUI

/// Keeps the open transcript still while earlier turns are inserted above what the reader sees.
///
/// A session opens on its newest turns, and the idle fill (Hub/HubSessionDetail.swift) prepends the
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
/// It also measures the rows on screen again after rows are inserted or removed
/// (`remeasureVisibleRows`): its own move inside an insert stops AppKit re-measuring them otherwise.
@MainActor
final class TranscriptScrollAnchor: ObservableObject {
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
    /// The table's rows at the last resize: an insert or a removal changes the count.
    private var rowCount = -1
    private var remeasureScheduled = false

    /// Call before rows are inserted above the viewport. Until `seconds` pass, or the reader scrolls
    /// or clicks in the list, the viewport keeps its distance from the content's end.
    func holdForPrepend(seconds: Double = 0.5) {
        guard let scroll = resolve(), let document = scroll.documentView else { return }
        // Never below 0: right after a session switch the viewport can sit past the new content's end,
        // and holding that left a blank screen below the last turn.
        held = max(0, document.frame.height - scroll.contentView.bounds.maxY)
        release?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.held = nil }
        release = work
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: work)
    }

    /// The reader or the list itself moves the viewport now (a scroll, a jump to a prompt).
    func releaseHold() {
        release?.cancel()
        release = nil
        held = nil
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
        scrollView = scroll
        guard let document = scroll.documentView else { return }
        documentHeight = document.frame.height
        rowCount = (document as? NSTableView)?.numberOfRows ?? -1
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
        } else if before <= Self.endSlack, !readerIsChanging {
            keep(max(0, before))
        }
        if let table = document as? NSTableView, table.numberOfRows != rowCount {
            rowCount = table.numberOfRows
            scheduleRemeasure()
        }
    }

    /// `keep` moves the viewport inside the resize of a row insert (the live tail appending turns while
    /// the reader is at the latest one, the idle fill prepending them under a hold). That move leaves
    /// each row view on screen without its automatic-row-height listener
    /// (`NSTableRowView._layoutEngineChangeListener`, set up again only for a row that scrolls into
    /// view). A row without it never reports a new height, and `noteHeightOfRows` returns the cached
    /// one: a tool call opened after the transcript followed a running session kept its closed height
    /// and its output drew under the rows below (Martin, 2026-09-28; `SessionTranscriptScrollTests`
    /// `testARowOnScreenWhenTurnsArriveStillOpensToItsOutput`). Measured with this remeasure off: rows
    /// streamed in under the move stuck 2 runs of 2, the same rows without the move opened 2 of 2.
    /// The move cannot wait a turn, or the rows on screen would jump for one frame. So after every
    /// change of the row count, automatic row heights go off and on: the rows on screen are measured
    /// again and get their listeners back, rows off screen keep their heights. On the next turn of the
    /// main queue, after the insert's own layout.
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
        let span = HubPerf.begin("transcript.remeasureRows", "\(table.numberOfRows) rows")
        table.usesAutomaticRowHeights = false
        table.usesAutomaticRowHeights = true
        span.end()
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
struct TranscriptScrollAnchorProbe: NSViewRepresentable {
    let anchor: TranscriptScrollAnchor

    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        anchor.probe = view
        return view
    }

    func updateNSView(_ view: NSView, context: Context) {
        anchor.probe = view
        anchor.attachSoon()
    }
}
