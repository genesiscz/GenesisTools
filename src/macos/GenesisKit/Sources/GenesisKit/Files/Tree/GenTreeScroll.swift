//
//  GenTreeScroll.swift
//  GenesisKit
//
//  A tree table's scroll handle and its reveal glide (first the markdown viewer's file tree; moved here 2026-10-30 with
//  `GenTreeTable`).
//

import AppKit

/// The tree's scroll view, set by `GenTreeTable`. A class, so setting it does not re-render the tree. It owns the
/// one glide that may write that scroll view's origin.
final class GenTreeScrollBox {
    /// The table scroll view whose clip origin a reveal may change.
    weak var scrollView: NSScrollView?
    /// The glide writing this scroll view, when one is running.
    private(set) var glide: GenTreeGlide?

    /// Stops the running glide and starts a new one. A second reveal replaces the first.
    func beginGlide() -> GenTreeGlide {
        cancelGlide()
        let next = GenTreeGlide()
        glide = next
        return next
    }

    /// Stops the glide. A new reveal, a re-root, a header reveal and the tree leaving the window call it.
    func cancelGlide() {
        glide?.cancel()
        glide = nil
    }

    /// The glide finished on its own. A glide that a newer one already replaced is left alone.
    func endGlide(_ flight: GenTreeGlide) {
        flight.cancel()
        if glide === flight { glide = nil }
    }
}

/// One running glide: its timer and the scroll-wheel monitor. Cancelling stops both, so an older reveal cannot
/// keep writing the clip origin.
final class GenTreeGlide {
    /// Whether this flight has stopped writing the scroll origin.
    private(set) var cancelled = false
    /// Timer callbacks that ran. A cancelled glide stays at however many ran before `cancel`.
    private(set) var frames = 0
    private var timer: Timer?
    private var monitor: Any?

    /// Records a timer frame for cancellation and progress tests.
    func noteFrame() { frames += 1 }

    /// Attaches this flight's timer and wheel monitor, or disposes of them if already cancelled.
    func arm(timer: Timer, monitor: Any?) {
        if cancelled {
            timer.invalidate()
            if let monitor { NSEvent.removeMonitor(monitor) }
            return
        }
        self.timer = timer
        self.monitor = monitor
    }

    /// Stops the timer and removes the wheel monitor exactly once.
    func cancel() {
        guard !cancelled else { return }
        cancelled = true
        let timer = self.timer
        self.timer = nil
        timer?.invalidate()
        if let monitor {
            NSEvent.removeMonitor(monitor)
            self.monitor = nil
        }
    }
}

/// The reveal's glide. The rows are one height, so the document's height over the row count places a row before the
/// lazy list has laid it out.
enum GenTreeScroll {
    /// The rows' vertical padding inside the scroll content (`MarkdownFileTreeView`).
    static let padding: CGFloat = 4
    /// Seconds spent gliding through the final screen toward a revealed row.
    static let duration: TimeInterval = 0.32

    /// The clip origin that centres row `index` of `count`, clamped to the document.
    static func centeredOrigin(index: Int, count: Int, documentHeight: CGFloat, visibleHeight: CGFloat) -> CGFloat {
        let rowHeight = max(documentHeight - 2 * padding, 0) / CGFloat(max(count, 1))
        let middle = padding + (CGFloat(index) + 0.5) * rowHeight
        let bottom = max(documentHeight - visibleHeight, 0)
        return min(max(middle - visibleHeight / 2, 0), bottom)
    }

    /// Where a glide starts: a target more than a screen and a half away is approached from one screen short of it,
    /// so the eye follows the last screen and the list does not lay out every row in between.
    static func glideStart(from current: CGFloat, to target: CGFloat, visibleHeight: CGFloat) -> CGFloat {
        guard abs(target - current) > visibleHeight * 1.5 else { return current }
        return target > current ? target - visibleHeight : target + visibleHeight
    }

    /// The clip origin that centres row `index`: from the table's own row rect, else from the document's height.
    @MainActor
    static func centeredOrigin(row index: Int, of count: Int, in scroll: NSScrollView) -> CGFloat {
        let visible = scroll.contentView.bounds.height
        guard let table = scroll.documentView as? NSTableView, index < table.numberOfRows else {
            return centeredOrigin(index: index, count: count, documentHeight: scroll.documentView?.frame.height ?? 0,
                                  visibleHeight: visible)
        }
        let insets = scroll.contentInsets
        let top = -insets.top
        let bottom = max(table.frame.height + insets.bottom - visible, top)
        return min(max(table.rect(ofRow: index).midY - visible / 2, top), bottom)
    }

    /// Reduce Motion: the row in the middle at once.
    @MainActor
    static func jump(toRow index: Int, of count: Int, in scroll: NSScrollView) {
        scroll.window?.contentView?.layoutSubtreeIfNeeded()
        let clip = scroll.contentView
        clip.scroll(to: NSPoint(x: clip.bounds.origin.x, y: centeredOrigin(row: index, of: count, in: scroll)))
        scroll.reflectScrolledClipView(clip)
    }

    /// The list's top, for a new root.
    @MainActor
    static func toTop(_ scroll: NSScrollView, animated: Bool) {
        let clip = scroll.contentView
        let top = NSPoint(x: clip.bounds.origin.x, y: -scroll.contentInsets.top)
        if animated {
            NSAnimationContext.runAnimationGroup { context in
                context.duration = duration
                clip.animator().setBoundsOrigin(top)
            }
        } else {
            clip.scroll(to: top)
        }
        scroll.reflectScrolledClipView(clip)
    }

    /// Ease in and out over `progress` 0...1.
    static func eased(_ progress: Double) -> Double {
        progress < 0.5 ? 2 * progress * progress : 1 - pow(-2 * progress + 2, 2) / 2
    }

    /// How long the glide keeps the row in the middle after its motion, while the list's height settles.
    static let holdLimit: TimeInterval = 0.5

    /// Scrolls the clip view to row `index` frame by frame and leaves the row in the middle.
    ///
    /// The target follows the document's height on every frame: rows a reveal just opened arrive in it a few frames
    /// later (5721 → 5915 → 6192 pt in the 2026-10-15 recording). After the motion the glide holds the row in the
    /// middle until that height has stopped changing. Only the reader's own scroll stops it early: a change of the
    /// clip origin alone is also what the list does while it grows, and stopping on it left the row three rows above
    /// the sidebar. A glide already running on `box` is cancelled first: two timers would write two origins.
    @MainActor
    static func glide(toRow index: Int, of count: Int, in scroll: NSScrollView, box: GenTreeScrollBox) {
        let flight = box.beginGlide()
        scroll.window?.contentView?.layoutSubtreeIfNeeded()
        let clip = scroll.contentView
        let visible = clip.bounds.height
        func height() -> CGFloat { scroll.documentView?.frame.height ?? 0 }
        func target() -> CGFloat { centeredOrigin(row: index, of: count, in: scroll) }
        let start = glideStart(from: clip.bounds.origin.y, to: target(), visibleHeight: visible)
        GenesisKit.log("markdown: tree reveal row \(index) of \(count), document \(Int(height())) pt, glide \(Int(clip.bounds.origin.y)) -> \(Int(start)) -> \(Int(target()))")
        func place(_ y: CGFloat) {
            guard abs(clip.bounds.origin.y - y) >= 0.5 else { return }
            clip.scroll(to: NSPoint(x: clip.bounds.origin.x, y: y))
            scroll.reflectScrolledClipView(clip)
        }
        place(start)
        // A wheel or a trackpad over the window: the reader takes the list over.
        var readerScrolled = false
        let monitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { event in
            if event.window === scroll.window { readerScrolled = true }
            return event
        }
        let began = CACurrentMediaTime()
        var lastHeight = height()
        var steadySince = began + duration
        let timer = Timer(timeInterval: 1.0 / 60, repeats: true) { timer in
            MainActor.assumeIsolated {
                guard !flight.cancelled else {
                    timer.invalidate()
                    return
                }
                flight.noteFrame()
                let now = CACurrentMediaTime()
                var done: String?
                if readerScrolled {
                    done = "stopped by the reader"
                } else {
                    let progress = min(1, (now - began) / duration)
                    if height() != lastHeight {
                        lastHeight = height()
                        steadySince = max(now, began + duration)
                    }
                    place(start + (target() - start) * eased(progress))
                    // Done once the height has held for a few frames after the motion, or the hold ran out.
                    if progress >= 1, now - steadySince > 0.08 || now - began > duration + holdLimit {
                        done = "end"
                    }
                }
                if let done {
                    box.endGlide(flight)
                    let origin = Int(clip.bounds.origin.y)
                    let document = Int(height())
                    GenesisKit.log("markdown: tree glide \(done) at \(origin), document \(document) pt")
                }
            }
        }
        flight.arm(timer: timer, monitor: monitor)
        guard !flight.cancelled else { return }
        RunLoop.main.add(timer, forMode: .common)
    }
}
