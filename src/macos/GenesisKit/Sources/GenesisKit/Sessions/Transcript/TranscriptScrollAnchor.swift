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
    /// Within this of the content's end is reading the latest turn. The list ends in a 12 pt spacer
    /// under the last section's end marker, and scrolled fully down the live hub measured a gap of 39 to
    /// 51 pt (2026-10-01): at 40 a reader at the very end counted as scrolled up half the time.
    private static let endSlack: CGFloat = 80
    /// `atEnd` turns off only past this.
    private static let leaveSlack: CGFloat = 200
    /// The reader's last click in the list, and how long the growth after it stays theirs (the row
    /// opens on the next layout, its detail lands a few milliseconds later).
    private var readerClickAt: Date?
    /// The last left press began inside the list.
    private var pressInList = false
    private static let readerGrowth: TimeInterval = 1.5
    private var remeasureScheduled = false
    /// The distance from the end a reader at the latest turn keeps, while the follow waits for the pass.
    private var follow: CGFloat?
    /// Whether the viewport shows the content's end (within `endSlack`). Published only when it flips,
    /// so a list reads it for its "N new" pill without re-rendering per scroll step.
    @Published public private(set) var atEnd = true
    /// An animated follow to the end is on its way: growth meanwhile is still the reader's at the end.
    private var animatingToEnd = false
    /// The follow glides instead of jumping; off under Reduce Motion.
    private static let followDuration: TimeInterval = 0.2
    /// The content's width at the last resize. A change (a pane opened beside the list) wraps the rows
    /// again; at the latest turn the follow then jumps to the end instead of gliding there, since nothing
    /// new arrived (`--bench` `panes`, 2026-10-02: 644 pt in one step, not four frames of glide).
    private var documentWidth: CGFloat = 0
    private var widthChangedAt: CFAbsoluteTime = 0
    /// The row under a reader who is not at the latest turn, and how far the viewport's top sits below
    /// that row's top. Every resize keeps it there, whatever changed above or below: earlier turns
    /// prepended, the native scan's usage lines, a tool call's changes arriving, rows re-wrapping. The
    /// distance from the end that a prepend's hold keeps moved the reader whenever rows below grew in the
    /// same pass (hub bench `settle`, 2026-10-02: the row under the reader moved 409 and 1915 pt while a
    /// session filled in). A browser's scroll anchoring does the same. The row view is followed as an
    /// object, so rows inserted above it change its index, not what is anchored.
    private final class RowAnchor {
        weak var view: NSView?
        /// The row's top and the viewport's top when they were last in step. A keep moves the viewport by how far
        /// the ROW moved since then, so a reader's scroll in between is kept, not undone: an absolute position put
        /// the reader back on the anchored row while they scrolled (2026-10-07, row 8 held for 2 s, ±460 pt).
        var top: CGFloat
        var clipY: CGFloat

        init(view: NSView, top: CGFloat, clipY: CGFloat) {
            self.view = view
            self.top = top
            self.clipY = clipY
        }
    }

    private var rowAnchor: RowAnchor?
    /// Recent corrections by `keepRow`, newest last. Row heights that never settle make each correction
    /// start the next: the live hub logged 520 in 16 s on 2026-10-06, up to 8466 pt in one second, the reader
    /// unable to scroll up and the viewport finally 3158 pt past the content's end. Past `runawayPoints`
    /// within `runawayWindow` the anchor lets go, and the reader's scroll rules until `anchorBackoff` passes.
    private var corrections: [(at: CFAbsoluteTime, points: CGFloat)] = []
    private var anchorSuspendedUntil: CFAbsoluteTime = 0
    private static let runawayWindow: CFAbsoluteTime = 1
    private static let runawayPoints: CGFloat = 1500
    private static let anchorBackoff: CFAbsoluteTime = 2
    /// Posted by a scripted run (the hub bench) to scroll as a reader would: a glide stops, and the next
    /// move is the reader's.
    public static let readerScrolled = Notification.Name("GenesisKit.transcriptReaderScrolled")
    /// The reader's last wheel or key in the list: the viewport is theirs while it moves.
    private var readerScrollAt: CFAbsoluteTime = 0
    /// Until then the list itself scrolls (opening at the latest turn, a jump to a prompt): its moves
    /// pick a new anchor row instead of being undone.
    private var listMovesUntil: CFAbsoluteTime = 0
    /// `GENESIS_TRANSCRIPT_ROW_ANCHOR=0`: the old distance-from-the-end hold only, for A/B runs.
    private static let rowAnchoring = ProcessInfo.processInfo.environment["GENESIS_TRANSCRIPT_ROW_ANCHOR"] != "0"

    /// Call before rows are inserted above the viewport. Until `seconds` pass, or the reader scrolls
    /// or clicks in the list, the viewport keeps its distance from the content's end.
    public func holdForPrepend(seconds: Double = 0.5) {
        guard let scroll = resolve(), let document = scroll.documentView else { return }
        // Never below 0: right after a session switch the viewport can sit past the new content's end,
        // and holding that left a blank screen below the last turn.
        let gap = max(0, document.frame.height - scroll.contentView.bounds.maxY)
        // A reader away from the end is kept by the row under them, which also covers rows growing
        // below in the same pass; the distance from the end is for a reader at the latest turn.
        if Self.rowAnchoring, gap > Self.endSlack, rowAnchor?.view != nil {
            // The row keeps the reader, and during the prepend it must be kept INSIDE the resize: a keep one turn
            // later drew a frame at the old distance from the top, and a reader still scrolling was left at the
            // oldest turns (2026-10-07: "Load earlier turns" grew 1906 to 72190 pt, viewport 71069 pt from the end).
            prependUntil = CFAbsoluteTimeGetCurrent() + seconds
            return
        }
        held = gap
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

    /// The list scrolls itself now (a jump, the open at the latest turn, the Latest button): for
    /// `seconds` its moves are not undone, and the row it lands on becomes the anchor.
    public func listMoves(for seconds: Double = 0.6) {
        listMovesUntil = CFAbsoluteTimeGetCurrent() + seconds
        rowAnchor = nil
    }

    private var listMoving: Bool { CFAbsoluteTimeGetCurrent() < listMovesUntil }

    /// A wheel or key in the last 0.3 s, or the mouse held down after a press in the list (the scroller's
    /// knob, a drag). A press elsewhere (the split divider) is not the reader moving the list.
    private var readerMoving: Bool {
        liveScrolling || CFAbsoluteTimeGetCurrent() - readerScrollAt < 0.3 || (pressInList && (NSEvent.pressedMouseButtons & 1) != 0)
    }

    /// Between the scroll view's willStartLiveScroll and didEndLiveScroll: a trackpad gesture and its momentum. After
    /// its first event the scroll view tracks the gesture itself (responsive scrolling), so the later events never
    /// reach the event monitor, and without this every frame of the gesture read as someone else's move and was
    /// pushed back to the anchored row (2026-10-06: 520 corrections in 16 s, the reader unable to scroll up).
    private var liveScrolling = false

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
        liveScrolling = false
        scrollView = scroll
        guard let document = scroll.documentView else { return }
        documentHeight = document.frame.height
        documentWidth = document.frame.width
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
            center.addObserver(forName: NSScrollView.willStartLiveScrollNotification, object: scroll, queue: nil) { [weak self] _ in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    self.liveScrolling = true
                    self.releaseHold()
                    self.stopFollowing()
                    self.readerScrollAt = CFAbsoluteTimeGetCurrent()
                }
            },
            center.addObserver(forName: NSScrollView.didEndLiveScrollNotification, object: scroll, queue: nil) { [weak self] _ in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    self.liveScrolling = false
                    self.readerScrollAt = CFAbsoluteTimeGetCurrent()
                }
            },
            center.addObserver(forName: Self.readerScrolled, object: nil, queue: nil) { [weak self] _ in
                MainActor.assumeIsolated {
                    self?.releaseHold()
                    self?.stopFollowing()
                    self?.readerScrollAt = CFAbsoluteTimeGetCurrent()
                }
            },
        ]
        // A scroll, a click or a key in the list is the reader's: the viewport is theirs from then on. A key
        // counts while the list has focus (Page Up, the arrows, Home, End, space).
        inputMonitor = NSEvent.addLocalMonitorForEvents(matching: [.scrollWheel, .leftMouseDown, .keyDown]) { [weak self] event in
            MainActor.assumeIsolated {
                guard let self, let scroll = self.scrollView else { return }
                let reader = event.window === scroll.window && (event.type == .keyDown
                    ? (scroll.window?.firstResponder as? NSView)?.isDescendant(of: scroll) == true
                    : scroll.bounds.contains(scroll.convert(event.locationInWindow, from: nil)))
                if event.type == .leftMouseDown {
                    self.pressInList = reader
                }
                if reader {
                    self.releaseHold()
                    // A key moves the viewport as a wheel does (Page Up, Home, the arrows): a glide in flight stops too.
                    if event.type == .scrollWheel || event.type == .keyDown {
                        self.stopFollowing()
                        self.readerScrollAt = CFAbsoluteTimeGetCurrent()
                    }
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
        if abs(document.frame.width - documentWidth) > 0.5 {
            documentWidth = document.frame.width
            widthChangedAt = CFAbsoluteTimeGetCurrent()
        }
        // Also while the reader scrolls: the anchor is the row their last scroll step left at the top, and
        // content that arrives mid-scroll (a turn above, a tool call's changes) must not move it.
        if Self.rowAnchoring, before > Self.endSlack, !animatingToEnd, !listMoving, let anchor = rowAnchor, anchor.view != nil {
            // One turn later, outside the resize. Moved inside it, the rows on screen lost their height listener
            // and needed `remeasureVisibleRows`, which resets EVERY row to its estimated height: a live 18-row
            // window fell from 5207 to 1115 pt, the viewport was clamped and thrown, the rows measured again,
            // and the next keep started the next re-measure (2026-10-07, Agents › Main "jumping as fuck").
            if CFAbsoluteTimeGetCurrent() < prependUntil {
                // A prepend: rare and large, so the move happens inside the resize and pays for the re-measure.
                if keepRow(anchor) {
                    scheduleRemeasure()
                }
            } else {
                scheduleRowKeep(anchor)
            }
            updateAtEnd()
        } else if let held {
            keep(held)
            // Only this move inside the resize costs the rows on screen their height listener.
            scheduleRemeasure()
        } else if follow == nil, before <= Self.endSlack || animatingToEnd, !readerIsChanging, !readerMoving {
            // Not while the reader scrolls: a row arriving as they left the end glided them back down, again and
            // again, while their trackpad went up (Martin, 2026-10-07: "jumping like CRAZY", both directions).
            scheduleFollow(animatingToEnd ? 0 : max(0, before))
        } else {
            updateAtEnd()
        }
    }

    /// The reader's own scroll wins over a follow: a pending one is dropped and a glide stops where it
    /// is. Without this a glide in flight kept `animatingToEnd` set, each arriving row started the next
    /// one, and a reader who scrolled up mid-stream was pulled back down.
    private func stopFollowing() {
        follow = nil
        guard animatingToEnd, let clip = scrollView?.contentView else { return }
        animatingToEnd = false
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0
            clip.animator().setBoundsOrigin(clip.bounds.origin)
        }
    }

    /// Glides to the content's end (the "N new" pill); instant under Reduce Motion.
    public func scrollToEnd() {
        releaseHold()
        keep(0, animated: true)
    }

    /// `scrolled`: the viewport moved (the reader's scroll decides at `endSlack`, exactly where the follow
    /// stops). Otherwise the content changed under a still viewport.
    private func updateAtEnd(scrolled: Bool = false) {
        guard let scroll = scrollView, let document = scroll.documentView else { return }
        let gap = document.frame.height - scroll.contentView.bounds.maxY
        // A follow on its way is at the end: rows measure between the resize and the follow's pass, and
        // that gap (100+ pt for 20 ms) flipped the pill on and off. Growth under a still viewport keeps a
        // reader at the end up to `leaveSlack`; only their own scroll up takes them off it.
        let slack = scrolled || !atEnd ? Self.endSlack : Self.leaveSlack
        let next = animatingToEnd || follow != nil || gap <= slack
        if next != atEnd {
            PerfLog.mark(String(format: "transcript.anchor atEnd=%@ gap=%.0f doc=%.0f", next ? "yes" : "no", gap, document.frame.height))
            atEnd = next
        }
    }

    /// A reader at the latest turn follows the growth below the viewport's top one turn later, once per
    /// pass. The rows on screen keep their places meanwhile (the table keeps its top), so nothing jumps:
    /// the new rows appear a turn late. Moving inside the resize, as a hold must, left the rows on screen
    /// without their height listener and needed `remeasureVisibleRows` after every appended turn, which
    /// measured the table again: 2.1 s of the 2.75 s main thread a streamed session cost in
    /// `testStreamingCost`, and the most common main-thread stall of the live hub (2026-09-30: 179 of
    /// 273 stall stacks in 48 h, p50 1.3 s). A resize fires several times per pass as rows measure;
    /// the first one schedules the follow, which glides to the end (`keep(0, animated:)`).
    private func scheduleFollow(_ distance: CGFloat) {
        follow = distance
        DispatchQueue.main.async { [weak self] in
            MainActor.assumeIsolated {
                guard let self, self.follow != nil else { return }
                self.follow = nil
                // The reader started scrolling after the follow was scheduled: the viewport is theirs.
                guard !self.readerMoving else { return }
                // To the end itself (a glide, 2026-10-01): the few points the reader sat above it are
                // the list's spacer, and a glide to a fixed distance fell behind rows measured mid-way.
                // Rows that wrap again after a width change are not new content: no glide (0.6 s covers
                // the passes in which they measure).
                self.keep(0, animated: CFAbsoluteTimeGetCurrent() - self.widthChangedAt > 0.6)
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
        guard !adjusting else { return }
        if let held {
            keep(held)
            return
        }
        updateAtEnd(scrolled: true)
        guard Self.rowAnchoring, !animatingToEnd else { return }
        // Only the reader or the list itself picks the row. A move from the table on its own while content
        // grows at the latest turn once made a mid-growth row the anchor, and the reader stayed there
        // instead of following the end (hub bench `open`: 2903 pt from the end, 2026-10-02).
        if readerMoving || listMoving {
            // A keep still waiting for its turn would otherwise be measured against a row picked from the shifted
            // rows, and the shift would become the reader's new place.
            if rowKeepScheduled, !listMoving, let anchor = rowAnchor {
                // The reader's own move counts; the row's shift is still owed to the waiting keep.
                anchor.clipY = scrollView?.contentView.bounds.minY ?? anchor.clipY
            } else {
                recordRow()
            }
        } else if let anchor = rowAnchor {
            // Not the reader's move and not the list's (the table restoring an old offset between two
            // resizes): undone, so the row under the reader stays.
            keepRow(anchor)
        }
    }

    private var rowKeepScheduled = false
    /// Until then a resize is the prepend `holdForPrepend` announced.
    private var prependUntil: CFAbsoluteTime = 0

    /// Keeps the anchored row once per main-queue turn, after the resize that moved it has finished.
    private func scheduleRowKeep(_ anchor: RowAnchor) {
        guard !rowKeepScheduled else { return }
        rowKeepScheduled = true
        DispatchQueue.main.async { [weak self] in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.rowKeepScheduled = false
                // Also while the reader scrolls: rows measured above them must not move what they read. The list's
                // own jump and a glide to the end win; `viewportMoved` does not replace the row while this waits.
                guard !self.listMoving, !self.animatingToEnd, self.rowAnchor === anchor else { return }
                self.keepRow(anchor)
                self.updateAtEnd()
            }
        }
    }

    /// Puts the anchored row's top `offset` above the viewport's top again. False when nothing moved or
    /// the row is gone (then the next move picks a new one).
    @discardableResult
    private func keepRow(_ anchor: RowAnchor) -> Bool {
        guard let scroll = scrollView, let table = scroll.documentView as? NSTableView, let view = anchor.view else { return false }
        let row = table.row(for: view)
        guard row >= 0 else {
            rowAnchor = nil
            return false
        }
        let clip = scroll.contentView
        let maxY = max(0, table.frame.height - clip.bounds.height)
        let rowTop = table.rect(ofRow: row).minY
        let y = min(maxY, max(0, anchor.clipY + rowTop - anchor.top))
        anchor.top = rowTop
        anchor.clipY = y
        guard abs(clip.bounds.origin.y - y) > 0.5 else { return false }
        let now = CFAbsoluteTimeGetCurrent()
        guard now >= anchorSuspendedUntil else { return false }
        corrections.removeAll { now - $0.at > Self.runawayWindow }
        corrections.append((now, abs(y - clip.bounds.origin.y)))
        if corrections.reduce(0, { $0 + $1.points }) > Self.runawayPoints {
            PerfLog.mark(String(format: "transcript.anchor runaway: %d corrections, backing off %.0f s, doc=%.0f", corrections.count, Self.anchorBackoff, table.frame.height))
            corrections = []
            anchorSuspendedUntil = now + Self.anchorBackoff
            rowAnchor = nil
            return false
        }
        PerfLog.mark(String(format: "transcript.anchor row %d keep dy=%.0f doc=%.0f", row, y - clip.bounds.origin.y, table.frame.height))
        adjusting = true
        clip.scroll(to: NSPoint(x: clip.bounds.origin.x, y: y))
        scroll.reflectScrolledClipView(clip)
        adjusting = false
        return true
    }

    /// The row at the viewport's top becomes the anchor; none while the reader is at the latest turn,
    /// where the follow keeps them.
    private func recordRow() {
        guard let scroll = scrollView, let table = scroll.documentView as? NSTableView, table.numberOfRows > 0 else {
            rowAnchor = nil
            return
        }
        let clip = scroll.contentView
        guard table.frame.height - clip.bounds.maxY > Self.endSlack else {
            rowAnchor = nil
            return
        }
        let row = table.row(at: NSPoint(x: 1, y: clip.bounds.minY + 1))
        guard row >= 0, let view = table.rowView(atRow: row, makeIfNecessary: false) else {
            rowAnchor = nil
            return
        }
        rowAnchor = RowAnchor(view: view, top: table.rect(ofRow: row).minY, clipY: clip.bounds.minY)
    }

    /// Puts the viewport's end `distance` above the content's end. `animated`: an ease-out glide of
    /// `followDuration` (the follow of a reader at the latest turn and the pill), never under Reduce
    /// Motion and never for a hold, which must not move what is on screen.
    private func keep(_ distance: CGFloat, animated: Bool = false) {
        guard let scroll = scrollView, let document = scroll.documentView else { return }
        let clip = scroll.contentView
        let y = max(0, document.frame.height - clip.bounds.height - distance)
        guard abs(clip.bounds.origin.y - y) > 0.5 else {
            updateAtEnd()
            return
        }
        let target = NSPoint(x: clip.bounds.origin.x, y: y)
        PerfLog.mark(String(format: "transcript.anchor keep end-%.0f dy=%.0f doc=%.0f%@", distance, y - clip.bounds.origin.y, document.frame.height, animated ? " glide" : ""))
        if animated, !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
            // Every glide goes to the end (a follow or the pill); rows that measure meanwhile are
            // still the reader's at the end.
            animatingToEnd = true
            NSAnimationContext.runAnimationGroup({ context in
                context.duration = Self.followDuration
                context.timingFunction = CAMediaTimingFunction(name: .easeOut)
                context.allowsImplicitAnimation = true
                clip.animator().setBoundsOrigin(target)
            }, completionHandler: { [weak self] in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    self.animatingToEnd = false
                    scroll.reflectScrolledClipView(clip)
                    self.updateAtEnd()
                }
            })
            return
        }

        adjusting = true
        clip.scroll(to: target)
        scroll.reflectScrolledClipView(clip)
        adjusting = false
        updateAtEnd()
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
