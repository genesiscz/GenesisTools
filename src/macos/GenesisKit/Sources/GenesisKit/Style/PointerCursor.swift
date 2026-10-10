import AppKit
import SwiftUI

public extension View {
    /// The pointing-hand cursor while the pointer is over this clickable view.
    ///
    /// The shared hover styles (`genHover*`, `RowButtonStyle`, `GenDisclosure`) already apply it. Use it
    /// directly on a clickable thing that has none of them: a `Menu` label, a `Picker`, a system-styled
    /// `Button`. `active: false` keeps the arrow (a disabled control).
    @ViewBuilder
    func pointerCursor(_ active: Bool = true) -> some View {
        if #available(macOS 15, *) {
            pointerStyle(active ? .link : nil)
        } else {
            modifier(PointerCursorFallback(active: active))
        }
    }
}

/// macOS 14 has no `pointerStyle`. The cursor is set on every move, because a text view underneath resets
/// it on its own next move, and reset on exit or disappear, so a view swapped out under the pointer
/// cannot leave the hand behind.
private struct PointerCursorFallback: ViewModifier {
    let active: Bool
    @State private var hovering = false

    func body(content: Content) -> some View {
        content
            .onContinuousHover { phase in
                switch phase {
                case .active:
                    if !hovering { hovering = true }
                    if active { NSCursor.pointingHand.set() }
                case .ended:
                    if hovering {
                        hovering = false
                        NSCursor.arrow.set()
                    }
                }
            }
            .onDisappear {
                if hovering {
                    hovering = false
                    NSCursor.arrow.set()
                }
            }
    }
}
