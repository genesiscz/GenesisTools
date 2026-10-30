import SwiftUI

/// The hover for list rows: a soft fill in the row's own shape, no outline, no lift. The shape is
/// the row's full frame, so the hover box and the selection box are the same box. Keep gaps and
/// insets outside the button.
public struct RowButtonStyle: ButtonStyle {
    package var cornerRadius: CGFloat

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
    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
        configuration.label
            .background(
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .fill(Color.white.opacity(configuration.isPressed ? 0.10 : (hovering ? 0.055 : 0)))
            )
            .contentShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
            .pointerCursor(isEnabled)
            .onHover { hovering = isEnabled && $0 }
            // A row that scrolls out from under a still pointer gets no exit event; reset it when
            // the row leaves the screen so it does not come back highlighted.
            .onDisappear { hovering = false }
    }
}

public extension View {
    /// A clickable list row: a real button (keyboard, VoiceOver, automation) with the row hover,
    /// instead of an `onTapGesture` that none of them see. While its row is at rest (`rowLive`, see
    /// `liveRow`) it is the label as a resting button, with no responder.
    func rowButton(cornerRadius: CGFloat = 8, _ action: @escaping () -> Void) -> some View {
        RowButtonHost(cornerRadius: cornerRadius, action: action, label: self)
    }
}

private struct RowButtonHost<Label: View>: View {
    let cornerRadius: CGFloat
    let action: () -> Void
    let label: Label
    @Environment(\.rowLive) private var live

    var body: some View {
        if live {
            Button(action: action) { label }
                .buttonStyle(RowButtonStyle(cornerRadius: cornerRadius))
        } else {
            label.restingButton(action: action)
        }
    }
}
