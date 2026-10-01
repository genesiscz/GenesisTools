import SwiftUI

/// A spinner that says what it waits for: the last known data on screen (`SWR`), or nothing yet.
public struct RefreshingMark: View {
    let showingCache: Bool
    /// What is refreshing, e.g. "the worktree list".
    let what: String
    var size: ControlSize

    public init(showingCache: Bool, what: String, size: ControlSize = .small) {
        self.showingCache = showingCache
        self.what = what
        self.size = size
    }

    public var body: some View {
        ProgressView().controlSize(size)
            .instantTooltip(showingCache ? "Showing the last known \(what); reading the current one" : "Reading \(what)")
    }
}
