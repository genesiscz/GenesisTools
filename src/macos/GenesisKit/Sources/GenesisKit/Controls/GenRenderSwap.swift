//
//  GenRenderSwap.swift
//  GenesisKit
//
//  A pane that switches what it shows (a tab, a session, a file) without a blank frame: the old content stays on
//  screen while the new one builds underneath it, and fades out once the new one says it is on screen. Martin,
//  2026-10-13: "on tab change, wait until the new content is rendered, then swap with a transition".
//

import AppKit
import QuartzCore
import SwiftUI

/// What a content calls once it is really on screen (a page rendered its text). `GenRenderSwap` hands one to each
/// content; a view deeper down reads it from the environment (`genRenderReady`).
public struct GenRenderReady: Equatable {
    let token: AnyHashable
    let action: () -> Void

    public init(token: AnyHashable, action: @escaping () -> Void) {
        self.token = token
        self.action = action
    }

    public func callAsFunction() { action() }

    /// Compared by token: a new closure for the same content is the same signal, so it re-renders nothing.
    public static func == (left: GenRenderReady, right: GenRenderReady) -> Bool { left.token == right.token }
}

private struct GenRenderReadyKey: EnvironmentKey {
    static let defaultValue: GenRenderReady? = nil
}

public extension EnvironmentValues {
    /// The enclosing `GenRenderSwap`'s ready signal for this content; nil outside one.
    var genRenderReady: GenRenderReady? {
        get { self[GenRenderReadyKey.self] }
        set { self[GenRenderReadyKey.self] = newValue }
    }
}

/// How the old content leaves once the new one is ready.
public enum GenRenderSwapFade: Sendable {
    /// A SwiftUI opacity animation on the old content. Every frame of it updates the whole window's view graph: in the
    /// markdown viewer with 100 tabs the 0.14 s fade cost about 130 ms of main thread per tab switch, more than the
    /// switch itself (2026-10-15, MarkdownTreeLagBenchTests with MARKDOWN_TREE_BENCH_SELECT_GAP=0.5).
    case swiftUI
    /// The old content goes at once and Core Animation crossfades the hosting view's layer from what was on screen.
    /// The render server draws the frames; the main thread draws none. Anything else in that hosting view that changes
    /// in the same instant crossfades with it.
    case layer
}

/// Shows the content for `value`. When its id changes, the content for the old value stays on top while the content
/// for the new one builds underneath; when the new one calls its `ready` (or `timeout` passes, so a content that never
/// signals still arrives) the old one fades out on a quick ease-out, at once under Reduce Motion. A content with
/// nothing to wait for calls `ready` when it appears. The value with the current id is always the latest one passed
/// in; only the old value is a kept copy.
public struct GenRenderSwap<Value, ID: Hashable, Content: View>: View {
    private let value: Value
    private let idPath: KeyPath<Value, ID>
    private let timeout: TimeInterval
    private let content: (Value, GenRenderReady) -> Content
    private let fade: GenRenderSwapFade
    /// The hosting view a `.layer` fade crossfades.
    @State private var anchor = GenRenderSwapAnchor()
    /// On screen.
    @State private var current: Value?
    /// Building underneath, not yet ready.
    @State private var pending: Value?
    /// The previous content, fading out on top.
    @State private var leaving: Value?
    @State private var fading = false
    /// Counts switches. A delayed promotion (the timeout, a ready's next turn) carries the count of its switch and does
    /// nothing once another switch started: after A, B, C, B the first B's timeout must not promote the second B.
    @State private var generation = 0
    @GenReduceMotion private var reduceMotion

    static var fadeDuration: TimeInterval { 0.14 }

    public init(value: Value, id: KeyPath<Value, ID>, timeout: TimeInterval = 0.6, fade: GenRenderSwapFade = .swiftUI,
                @ViewBuilder content: @escaping (Value, GenRenderReady) -> Content) {
        self.value = value
        self.idPath = id
        self.timeout = timeout
        self.fade = fade
        self.content = content
    }

    private func key(_ item: Value?) -> ID? { item.map { $0[keyPath: idPath] } }

    /// The value that builds underneath: the pending one, or the latest value while its switch has not started yet
    /// (the body pass before `onChange`, or a switch `onChange` missed). Mounting it in that pass too keeps one
    /// content per id, so no web view is made twice.
    private var building: Value? {
        if let pending { return pending }
        let id = value[keyPath: idPath]
        return current != nil && id != key(current) ? value : nil
    }

    private var mounted: [Value] {
        var items: [Value] = []
        var seen = Set<ID>()
        for item in [building, current, leaving] {
            guard let item, seen.insert(item[keyPath: idPath]).inserted else { continue }
            // The latest value for its id: a session row or a document that changed since it was kept.
            items.append(item[keyPath: idPath] == value[keyPath: idPath] ? value : item)
        }
        return items
    }

    public var body: some View {
        let _ = catchMissedSwitch()
        ZStack {
            ForEach(mounted, id: idPath) { item in
                let id = item[keyPath: idPath]
                content(item, GenRenderReady(token: AnyHashable(id)) { arrived(id) })
                    .opacity(id == key(leaving) && fading ? 0 : 1)
                    .allowsHitTesting(id == key(current) && building == nil)
                    .zIndex(id == key(leaving) ? 2 : id == key(current) ? 1 : 0)
            }
        }
        .background {
            if fade == .layer { GenRenderSwapAnchorView(anchor: anchor) }
        }
        .onAppear {
            if current == nil { current = value }
        }
        .onChange(of: value[keyPath: idPath]) { _, _ in switchTo(value) }
    }

    /// A switch `onChange` did not deliver: the body sees a value that is neither on screen nor pending. Seen in the
    /// markdown viewer (2026-10-14): a tab click changed the value, no switch followed, and the old tab's page stayed
    /// until a later switch got through. The body starts the switch itself, a turn later (state is not written while
    /// the body runs); when `onChange` did fire, that switch finds it pending and does nothing.
    private func catchMissedSwitch() {
        let id = value[keyPath: idPath]
        guard current != nil, id != key(current), id != key(pending) else { return }
        let latest = value
        DispatchQueue.main.async {
            // A newer switch that arrived meanwhile wins; this one would set an older value pending again.
            guard pending == nil else { return }
            switchTo(latest)
        }
    }

    private func switchTo(_ new: Value) {
        let id = new[keyPath: idPath]
        guard id != key(current) else {
            pending = nil
            return
        }
        guard id != key(pending) else { return }
        pending = new
        generation += 1
        let switchGeneration = generation
        DispatchQueue.main.asyncAfter(deadline: .now() + timeout) {
            if key(pending) == id, generation == switchGeneration { promote() }
        }
    }

    private func arrived(_ id: ID) {
        guard id == key(building) else { return }
        let switchGeneration = generation
        // One turn for the page to paint what it just built.
        DispatchQueue.main.async {
            if key(pending) == id, generation == switchGeneration { promote() }
        }
    }

    private func promote() {
        guard let next = pending else { return }
        let old = current
        pending = nil
        current = next
        guard let old, key(old) != key(next), !reduceMotion else {
            leaving = nil
            return
        }
        if fade == .layer, let host = anchor.host, let layer = host.layer {
            leaving = nil
            let transition = CATransition()
            transition.type = .fade
            transition.duration = Self.fadeDuration
            transition.timingFunction = CAMediaTimingFunction(name: .easeOut)
            // Core Animation files a transition under `kCATransition` whatever key it is given.
            layer.add(transition, forKey: kCATransition)
            // The swap lands in this transaction, so the crossfade runs from the old content to the new.
            host.layoutSubtreeIfNeeded()
            return
        }
        leaving = old
        fading = false
        withAnimation(.easeOut(duration: Self.fadeDuration)) { fading = true }
        let oldID = key(old)
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.fadeDuration + 0.05) {
            guard key(leaving) == oldID else { return }
            leaving = nil
            fading = false
        }
    }
}

public extension GenRenderSwap where Value == ID {
    /// The content for an id alone.
    init(id: ID, timeout: TimeInterval = 0.6, fade: GenRenderSwapFade = .swiftUI,
         @ViewBuilder content: @escaping (ID, GenRenderReady) -> Content) {
        self.init(value: id, id: \.self, timeout: timeout, fade: fade, content: content)
    }
}

/// Where a `.layer` fade finds its hosting view: a view of no size and no hit area behind the swap's contents.
@MainActor
final class GenRenderSwapAnchor {
    /// The mounted marker used to locate the hosting view without retaining it.
    weak var view: NSView?

    /// The nearest hosting view around the swap: its layer holds both contents. The window's content view when none
    /// is found by name.
    var host: NSView? {
        var next = view?.superview
        while let candidate = next {
            if String(describing: type(of: candidate)).contains("HostingView") { return candidate }
            next = candidate.superview
        }
        return view?.window?.contentView
    }
}

private struct GenRenderSwapAnchorView: NSViewRepresentable {
    let anchor: GenRenderSwapAnchor

    final class Marker: NSView {
        override func hitTest(_ point: NSPoint) -> NSView? { nil }
        override func isAccessibilityElement() -> Bool { false }
    }

    func makeNSView(context: Context) -> NSView {
        let marker = Marker()
        anchor.view = marker
        return marker
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        anchor.view = nsView
    }
}
