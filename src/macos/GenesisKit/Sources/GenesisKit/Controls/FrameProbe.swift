import SwiftUI

/// Where a named control sits in its window, for a test that clicks it. A hidden test window has no accessibility tree,
/// so a test cannot find a control by its label; a click scan over points presses whatever lies there (it opened
/// Obsidian dialogs on the user's screen, 2026-10-23). Off unless a test turns it on; then `.frameProbe(name)` records
/// the view's frame in window coordinates (top-left origin, as SwiftUI's global space).
public enum FrameProbe {
    @MainActor public static var enabled = false
    @MainActor public private(set) static var frames: [String: CGRect] = [:]

    @MainActor static func record(_ name: String, _ frame: CGRect) {
        frames[name] = frame
    }

    @MainActor public static func reset() {
        frames = [:]
    }
}

public extension View {
    /// Records this view's window frame under `name` while `FrameProbe.enabled`; nothing at all otherwise.
    @MainActor @ViewBuilder func frameProbe(_ name: String) -> some View {
        if FrameProbe.enabled {
            onGeometryChange(for: CGRect.self, of: { $0.frame(in: .global) }) { FrameProbe.record(name, $0) }
        } else {
            self
        }
    }
}
