//
//  GenRenderSwap.swift
//  GenesisKit
//
//  A pane that switches what it shows (a tab, a session, a file) without a blank frame: the old content stays on
//  screen while the new one builds underneath it, and fades out once the new one says it is on screen. Martin,
//  2026-10-13: "on tab change, wait until the new content is rendered, then swap with a transition".
//

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
    /// On screen.
    @State private var current: Value?
    /// Building underneath, not yet ready.
    @State private var pending: Value?
    /// The previous content, fading out on top.
    @State private var leaving: Value?
    @State private var fading = false
    @GenReduceMotion private var reduceMotion

    static var fadeDuration: TimeInterval { 0.14 }

    public init(value: Value, id: KeyPath<Value, ID>, timeout: TimeInterval = 0.6,
                @ViewBuilder content: @escaping (Value, GenRenderReady) -> Content) {
        self.value = value
        self.idPath = id
        self.timeout = timeout
        self.content = content
    }

    private func key(_ item: Value?) -> ID? { item.map { $0[keyPath: idPath] } }

    private var mounted: [Value] {
        var items: [Value] = []
        var seen = Set<ID>()
        for item in [pending, current, leaving] {
            guard let item, seen.insert(item[keyPath: idPath]).inserted else { continue }
            // The latest value for its id: a session row or a document that changed since it was kept.
            items.append(item[keyPath: idPath] == value[keyPath: idPath] ? value : item)
        }
        return items
    }

    public var body: some View {
        ZStack {
            ForEach(mounted, id: idPath) { item in
                let id = item[keyPath: idPath]
                content(item, GenRenderReady(token: AnyHashable(id)) { arrived(id) })
                    .opacity(id == key(leaving) && fading ? 0 : 1)
                    .allowsHitTesting(id == key(current) && pending == nil)
                    .zIndex(id == key(leaving) ? 2 : id == key(current) ? 1 : 0)
            }
        }
        .onAppear {
            if current == nil { current = value }
        }
        .onChange(of: value[keyPath: idPath]) { _, _ in switchTo(value) }
    }

    private func switchTo(_ new: Value) {
        let id = new[keyPath: idPath]
        guard id != key(current) else {
            pending = nil
            return
        }
        pending = new
        DispatchQueue.main.asyncAfter(deadline: .now() + timeout) {
            if key(pending) == id { promote() }
        }
    }

    private func arrived(_ id: ID) {
        guard id == key(pending) else { return }
        // One turn for the page to paint what it just built.
        DispatchQueue.main.async {
            if key(pending) == id { promote() }
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
    init(id: ID, timeout: TimeInterval = 0.6, @ViewBuilder content: @escaping (ID, GenRenderReady) -> Content) {
        self.init(value: id, id: \.self, timeout: timeout, content: content)
    }
}
