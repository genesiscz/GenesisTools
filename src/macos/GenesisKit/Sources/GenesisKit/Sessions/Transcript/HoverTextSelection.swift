import SwiftUI

/// Text selection that exists only while the pointer is over the view.
///
/// `.textSelection(.enabled)` gives every `Text` inside it an AppKit selection field, a focus ring
/// and a key-view proxy. A transcript page of 17 to 23 rows carried 141 of each, and AppKit walks
/// every key-view proxy (`_setDefaultKeyViewLoop`) whenever a session opens: about a quarter of the
/// main-thread stall on each switch (app-perf.log, 2026-10-01 22:31). The pointer is over a message
/// before any drag can select in it, so selecting works the same.
///
/// `GENESIS_TRANSCRIPT_SELECT_ALWAYS=1` keeps selection on everywhere, for A/B measurements.
public struct HoverTextSelection: ViewModifier {
    static let always = ProcessInfo.processInfo.environment["GENESIS_TRANSCRIPT_SELECT_ALWAYS"] == "1"

    @State private var hovered = false

    public func body(content: Content) -> some View {
        Group {
            if hovered || Self.always {
                content.textSelection(.enabled)
            } else {
                content
            }
        }
        .onHover { inside in
            if inside {
                hovered = true
            }
        }
    }
}

public extension View {
    /// See `HoverTextSelection`.
    func hoverTextSelection() -> some View {
        modifier(HoverTextSelection())
    }
}
