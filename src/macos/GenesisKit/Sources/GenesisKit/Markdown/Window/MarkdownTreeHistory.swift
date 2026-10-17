//
//  MarkdownTreeHistory.swift
//  GenesisKit
//
//  Back and forward for the file sidebar. Each time the tree's root changes (Navigate in Sidebar, a reveal outside
//  the root, Up, Go to Location…, a dropped folder), the place it leaves is saved: the root, the open folders and the
//  scroll position. Back and forward bring a place back exactly as it was (Martin, 2026-10-15).
//

import Foundation

/// Where the file tree was: its root (empty: it follows the open document), its open folders and its scroll offset.
struct MarkdownTreePlace: Equatable {
    var root: String
    var expanded: Set<String>
    var scrollY: Double
}

/// Two stacks of places. Recording a new place clears the forward stack, as in a browser.
final class MarkdownTreeHistory: ObservableObject {
    static let limit = 50

    @Published private(set) var back: [MarkdownTreePlace] = []
    @Published private(set) var forward: [MarkdownTreePlace] = []

    var canGoBack: Bool { !back.isEmpty }
    var canGoForward: Bool { !forward.isEmpty }

    func record(_ place: MarkdownTreePlace) {
        if back.last != place { back.append(place) }
        if back.count > Self.limit { back.removeFirst(back.count - Self.limit) }
        forward.removeAll()
    }

    /// The place to go back to; `current` becomes the first step forward.
    func goBack(from current: MarkdownTreePlace) -> MarkdownTreePlace? {
        guard let place = back.popLast() else { return nil }
        forward.append(current)
        return place
    }

    /// The place to go forward to; `current` becomes the last step back.
    func goForward(from current: MarkdownTreePlace) -> MarkdownTreePlace? {
        guard let place = forward.popLast() else { return nil }
        back.append(current)
        return place
    }
}

/// Every delayed write belongs to one restore. A newer navigation invalidates even callbacks already enqueued.
final class MarkdownTreeRestore {
    private(set) var current = UUID()

    func begin() -> UUID {
        current = UUID()
        return current
    }

    func cancel() { current = UUID() }

    func isCurrent(_ token: UUID) -> Bool { token == current }
}
