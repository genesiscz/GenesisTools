//
//  MarkdownWindowContentView.swift
//  GenesisKit
//
//  The viewer window's content: the SwiftUI root in a hosting view, and AppKit views laid over slots the root keeps
//  for them (the file tree's table, `MarkdownTreeTable`). An overlay is this view's subview, not the root's, so its
//  own layout requests never reach SwiftUI.
//
//  Why: a scrolling table inside any SwiftUI host made that host lay out on every scroll frame (its cells and its
//  scroll view ask for layout through AppKit's constraint pass, and SwiftUI's host of the table forwarded it). That
//  was about half of the tree's scroll cost in a release check app, 2026-10-15, whether the host was the window's
//  root or a hosting view of the tree alone. A table beside the root cost 2.0 ms per wheel event with no SwiftUI
//  layout; inside it, 3.8 ms.
//

import AppKit
import SwiftUI

final class MarkdownWindowContentView: NSView {
    /// The SwiftUI root; it states no sizes of its own (`MarkdownDocumentWindowController.contentView`).
    let root: NSView
    /// The root's hosting sizing (none: the window's minimum is `MarkdownWindowMinimum`).
    let rootSizingOptions: () -> NSHostingSizingOptions
    fileprivate var overlays: [(slot: Weak, view: NSView)] = []

    fileprivate final class Weak {
        weak var view: NSView?
        init(_ view: NSView) { self.view = view }
    }

    init<Root: View>(root: MarkdownRootHostingView<Root>) {
        self.root = root
        rootSizingOptions = { [unowned root] in root.sizingOptions }
        super.init(frame: .zero)
        root.autoresizingMask = [.width, .height]
        addSubview(root)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    /// Lays `view` over `slot` from now on, above the root.
    func attach(_ view: NSView, over slot: NSView) {
        overlays.removeAll { $0.slot.view == nil || $0.slot.view === slot || $0.view === view }
        overlays.append((Weak(slot), view))
        if view.superview !== self {
            view.removeFromSuperview()
            addSubview(view, positioned: .above, relativeTo: root)
        }
        placeOverlays()
    }

    func detach(_ view: NSView) {
        overlays.removeAll { $0.view === view }
        if view.superview === self { view.removeFromSuperview() }
    }

    override func layout() {
        super.layout()
        if root.frame != bounds { root.frame = bounds }
        placeOverlays()
    }

    /// Where an overlay lies: over its slot, from the slot's top down to the overlay's content height. The slot's empty
    /// rest stays the root's, so a right-click there opens the root's menu (AppKit sends an unhandled right-click up
    /// the overlay's own superviews, which are not SwiftUI's).
    func overlayFrame(over slot: NSView) -> NSRect {
        var frame = slot.convert(slot.bounds, to: self).integral
        if let height = (slot as? MarkdownOverlaySlot)?.contentHeight?(), height < frame.height {
            frame.origin.y = isFlipped ? frame.minY : frame.maxY - height
            frame.size.height = height
        }
        return frame
    }

    /// Each overlay over its slot. Runs after this view's layout and after each of the root's: the root moves a slot
    /// (a tab bar appearing) without the slot's own frame changing.
    func placeOverlays() {
        overlays.removeAll { $0.slot.view == nil }
        for (box, view) in overlays {
            guard let slot = box.view, slot.window === window, !slot.isHiddenOrHasHiddenAncestor else {
                view.isHidden = true
                continue
            }
            let frame = overlayFrame(over: slot)
            if view.frame != frame { view.frame = frame }
            view.isHidden = frame.isEmpty
        }
    }
}

extension MarkdownWindowContentView {
    /// The largest distance, in points, between an overlay's frame and its slot's (0 when every overlay sits on its
    /// slot). For the divider's drag log.
    func overlayDrift() -> CGFloat {
        overlays.reduce(0) { drift, overlay in
            guard let slot = overlay.slot.view, slot.window === window else { return drift }
            let want = overlayFrame(over: slot)
            let have = overlay.view.frame
            return max(drift, abs(want.minX - have.minX), abs(want.maxX - have.maxX), abs(want.minY - have.minY),
                       abs(want.maxY - have.maxY))
        }
    }
}

/// The root's hosting view: after it lays out, the overlays follow their slots.
final class MarkdownRootHostingView<Content: View>: NSHostingView<Content> {
    override func layout() {
        super.layout()
        (superview as? MarkdownWindowContentView)?.placeOverlays()
    }
}

/// A place in the SwiftUI root for an AppKit view that lives outside it: inside a `MarkdownWindowContentView` the
/// view is laid over this slot; anywhere else (a test that hosts the root alone) it is the slot's own subview.
final class MarkdownOverlaySlot: NSView {
    let overlay: NSView
    /// The overlay's content height (the table's rows); the overlay covers no more of the slot than that.
    var contentHeight: (() -> CGFloat)?
    private weak var content: MarkdownWindowContentView?

    init(overlay: NSView) {
        self.overlay = overlay
        super.init(frame: .zero)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        settle()
    }

    override func viewDidMoveToSuperview() {
        super.viewDidMoveToSuperview()
        settle()
    }

    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        place()
    }

    override func setFrameOrigin(_ newOrigin: NSPoint) {
        super.setFrameOrigin(newOrigin)
        place()
    }

    override func viewDidHide() {
        super.viewDidHide()
        place()
    }

    override func viewDidUnhide() {
        super.viewDidUnhide()
        place()
    }

    /// Inside the window's content view the overlay takes the clicks where it lies; the rest of the slot is the root's.
    override func hitTest(_ point: NSPoint) -> NSView? {
        overlay.superview === self ? super.hitTest(point) : nil
    }

    /// The content height changed (rows came or went): the overlay is laid again.
    func contentChanged() {
        content?.placeOverlays()
    }

    /// Leaves the window: the overlay goes with it.
    func leave() {
        content?.detach(overlay)
        content = nil
    }

    private func settle() {
        guard window != nil else {
            leave()
            return
        }
        let found = sequence(first: superview, next: { $0?.superview }).compactMap { $0 as? MarkdownWindowContentView }.first
        if let found {
            if content !== found { content?.detach(overlay) }
            content = found
            found.attach(overlay, over: self)
        } else {
            leave()
            if overlay.superview !== self {
                overlay.removeFromSuperview()
                overlay.frame = bounds
                overlay.autoresizingMask = [.width, .height]
                addSubview(overlay)
            }
        }
    }

    private func place() {
        if let content {
            content.placeOverlays()
        } else if overlay.superview === self {
            overlay.frame = bounds
        }
    }
}
