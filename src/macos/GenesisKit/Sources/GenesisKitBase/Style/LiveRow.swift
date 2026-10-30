import SwiftUI

/// Whether the row a control sits in is live: under the pointer, selected or open. The kit's controls exist only
/// then. At rest a row of a dense list draws the same labels and glyphs with no control: no `Button`, no tooltip
/// sensor, no hover view. Every control is a platform responder, and with an accessibility client attached SwiftUI
/// walks every responder of the window per changed accessibility node (`AccessibilityNode.updateFocusResponder`:
/// 100 to 300 ms per walk over 40 PR rows that each carried a button, a tooltip and a link, so a sidebar drag in PRs
/// mode stalled 0.4 to 2.5 s; value rows live only under the pointer brought the step to p95 54 ms, 2026-10-29).
/// A row sets it once with `.liveRow(selected:)`; `rowButton`, `IconButton`, `instantTooltip`, `PathLabel`,
/// `MenuButton`, `ExternalLink` and `LiveButton` read it. VoiceOver and `tools control` still press a resting
/// control through `restingButton`.
private struct RowLiveKey: EnvironmentKey {
    static let defaultValue = true
}

public extension EnvironmentValues {
    var rowLive: Bool {
        get { self[RowLiveKey.self] }
        set { self[RowLiveKey.self] = newValue }
    }
}

/// Tracks the pointer over the row and sets `rowLive` for everything inside it.
private struct LiveRowModifier: ViewModifier {
    let selected: Bool
    @State private var hovering = false

    func body(content: Content) -> some View {
        content
            .environment(\.rowLive, hovering || selected)
            .onHover { inside in
                if inside != hovering { hovering = inside }
            }
            // A row that scrolls out from under a still pointer gets no exit event (`RowButtonStyle` does the same).
            .onDisappear { hovering = false }
    }
}

public extension View {
    /// A row of a dense list: live (its controls exist) under the pointer or while `selected` (or any state that
    /// keeps it live: expanded, replying); the same labels with no control otherwise. Put it on the row's outer view,
    /// after its `.contentShape`, outside its `.rowButton`. The row's own body cannot read `rowLive` (the environment
    /// applies to what is inside the modifier); a raw `Button` or `Toggle` inside a row is a `LiveButton`, and a
    /// control that must stay live in a resting row gets `.rowLive(true)`.
    func liveRow(selected: Bool = false) -> some View {
        modifier(LiveRowModifier(selected: selected))
    }

    /// Sets the liveness directly, for a view that knows its own state.
    func rowLive(_ live: Bool) -> some View {
        environment(\.rowLive, live)
    }

    /// A control at rest, drawn without its `Button`, hover sensor and tooltip: still a button to VoiceOver and the
    /// accessibility clients, which press it through its default action.
    func restingButton(enabled: Bool = true, action: @escaping () -> Void) -> some View {
        disabled(!enabled)
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isButton)
            .accessibilityAction {
                if enabled { action() }
            }
    }
}
