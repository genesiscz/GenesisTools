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
    /// The sidebar root path, or empty when it follows the selected document.
    var root: String
    /// The folders that were expanded at this history entry.
    var expanded: Set<String>
    /// The saved vertical clip origin in points.
    var scrollY: Double
}

/// Two stacks of places. Recording a new place clears the forward stack, as in a browser.
final class MarkdownTreeHistory: ObservableObject {
    /// The maximum number of previous sidebar places retained.
    static let limit = 50

    /// Previous places, ordered from oldest to most recently visited.
    @Published private(set) var back: [MarkdownTreePlace] = []
    /// Forward places, with the next destination at the end.
    @Published private(set) var forward: [MarkdownTreePlace] = []

    /// Whether a previous sidebar place can be restored.
    var canGoBack: Bool { !back.isEmpty }
    /// Whether a forward sidebar place can be restored.
    var canGoForward: Bool { !forward.isEmpty }

    /// Records a newly left place, bounds history and discards the forward branch.
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
    /// The restore whose delayed writes may still run.
    private(set) var current = UUID()

    /// Starts a restore and invalidates all callbacks queued by its predecessor.
    func begin() -> UUID {
        current = UUID()
        return current
    }

    /// Invalidates queued writes when navigation or sidebar removal supersedes a restore.
    func cancel() { current = UUID() }

    /// Whether a callback still belongs to the active restore.
    func isCurrent(_ token: UUID) -> Bool { token == current }

    /// Enqueues work on the main queue, or a controlled queue supplied by a test.
    typealias Scheduler = (TimeInterval, @escaping () -> Void) -> Void

    /// Schedules one of the view's forced, placement or correction writes and drops it if its restore is obsolete.
    func schedule(_ token: UUID, after delay: TimeInterval = 0,
                  using scheduler: Scheduler = { delay, action in
                      DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: action)
                  }, action: @escaping () -> Void) {
        scheduler(delay) { [weak self] in
            guard let self, self.isCurrent(token) else { return }
            action()
        }
    }
}
