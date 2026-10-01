import SwiftUI

/// The hover for list rows: a soft fill in the row's own shape, no outline, no lift. The shape is
/// the row's full frame, so the hover box and the selection box are the same box. Keep gaps and
/// insets outside the button.
public struct RowButtonStyle: ButtonStyle {
    var cornerRadius: CGFloat

    public init(cornerRadius: CGFloat = 6) {
        self.cornerRadius = cornerRadius
    }

    public func makeBody(configuration: Configuration) -> some View {
        RowButtonBody(configuration: configuration, cornerRadius: cornerRadius)
    }
}

private struct RowButtonBody: View {
    let configuration: ButtonStyleConfiguration
    let cornerRadius: CGFloat
    @State private var hovering = false

    var body: some View {
        configuration.label
            .background(
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .fill(Color.white.opacity(configuration.isPressed ? 0.10 : (hovering ? 0.055 : 0)))
            )
            .contentShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
            .onHover { hovering = $0 }
            // A row that scrolls out from under a still pointer gets no exit event; reset it when
            // the row leaves the screen so it does not come back highlighted.
            .onDisappear { hovering = false }
    }
}

public extension View {
    /// A clickable list row: a real button (keyboard, VoiceOver, automation) with the row hover,
    /// instead of an `onTapGesture` that none of them see.
    func rowButton(cornerRadius: CGFloat = 8, _ action: @escaping () -> Void) -> some View {
        Button(action: action) { self }
            .buttonStyle(RowButtonStyle(cornerRadius: cornerRadius))
    }
}
