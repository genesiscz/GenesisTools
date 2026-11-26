import SwiftUI

/// The frame of one decision on every surface that lists it: the fill (brighter while open), the corner and the clip,
/// the orange edge of a decision that waits for an answer, the blue edge of a staged one, and the keyboard's ring. A
/// staged decision reads blue as clearly as a waiting one reads orange: at 0.3 the blue was lost on the dark card
/// (Martin, 2026-10-28: "somehow marked as staged - the blue border probably?").
public struct WidgetDecisionChrome: ViewModifier {
    public static let cornerRadius: CGFloat = 11

    /// The edge: blue at 1.5 pt while staged (staged wins over waiting), orange at 1 pt while it waits, else
    /// `closedTint` at 1 pt, else none.
    public static func border(waiting: Bool, staged: Bool, closedTint: Color?) -> (color: Color, width: CGFloat)? {
        if staged { return (SessionPalette.blue.opacity(0.6), 1.5) }
        if waiting { return (Color.orange.opacity(0.28), 1) }
        return closedTint.map { ($0, 1) }
    }

    let waiting: Bool
    let staged: Bool
    let open: Bool
    let focused: Bool
    let closedTint: Color?

    public init(waiting: Bool, staged: Bool, open: Bool, focused: Bool = false, closedTint: Color? = nil) {
        self.waiting = waiting
        self.staged = staged
        self.open = open
        self.focused = focused
        self.closedTint = closedTint
    }

    public func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: Self.cornerRadius)
        let edge = Self.border(waiting: waiting, staged: staged, closedTint: closedTint)
        content
            // The card closes over its detail instead of the rows below sliding up over fading text.
            .clipShape(shape)
            .background(Color.white.opacity(open ? 0.055 : 0.03), in: shape)
            .overlay(shape.strokeBorder(edge?.color ?? .clear, lineWidth: edge?.width ?? 1))
            // The keyboard's row: a focus ring, the look of the system's own.
            .overlay(shape.strokeBorder(focused ? Color(nsColor: .keyboardFocusIndicatorColor) : .clear, lineWidth: 2))
    }
}

public extension View {
    /// `WidgetDecisionChrome`: one decision's fill, corner, waiting or staged edge and focus ring.
    func decisionChrome(waiting: Bool, staged: Bool, open: Bool, focused: Bool = false,
                        closedTint: Color? = nil) -> some View {
        modifier(WidgetDecisionChrome(waiting: waiting, staged: staged, open: open, focused: focused,
                                      closedTint: closedTint))
    }
}
