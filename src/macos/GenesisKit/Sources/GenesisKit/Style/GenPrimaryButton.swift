import SwiftUI

/// **The** filled button for the one primary action of a card, list or dialog (Send now, Send 3 now, Keep staged on
/// Return). It draws its own accent fill, so it looks the same in a key window and in the widget's non-activating panel,
/// where a native `.borderedProminent` draws in its inactive grey and reads as disabled (UX audit 2026-10-27, P7).
///
/// Rest: the accent fill with a white label. Hover: a little lighter. Pressed: darker and 0.97 scale (no scale under
/// Reduce Motion). Disabled: the fill fades and the pointer stays an arrow. In a window with a `KitLook` the fill is
/// the look's main-action surface (its gradient and glow in the play hue); an `accent` the caller names stays.
public struct GenPrimaryButtonStyle: ButtonStyle {
    /// The send blue: the hue of `SessionPalette.blue` (the "Staged" text), deep enough that the white label reads at
    /// 4.5:1 or better as rendered. `SessionPalette.blue` itself as a fill gave 2.6:1.
    public static let blue = Color(red: 0.12, green: 0.32, blue: 0.80)

    /// Nil: the send blue, or the look's main-action surface.
    var accent: Color?
    var cornerRadius: CGFloat = KitTheme.radiusSmall
    var padding = EdgeInsets(top: 4, leading: 11, bottom: 4, trailing: 11)

    @State private var isHovering = false
    @GenReduceMotion private var reduceMotion
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.kitForcedInteraction) private var forced
    @Environment(\.kitLook) private var look

    public func makeBody(configuration: Configuration) -> some View {
        let pressed = (configuration.isPressed || forced == .pressed) && isEnabled
        let hovering = (isHovering || forced == .hover) && isEnabled
        let surface = look.surface(.primary, pressed ? .pressed : (hovering ? .hover : .rest), hue: .play, tint: accent)
        let radius = look.radius(.primary, height: 24, legacy: cornerRadius)
        let shape = RoundedRectangle(cornerRadius: radius, style: look.corners)
        return configuration.label
            .fontWeight(.semibold)
            .foregroundStyle(surface.label)
            .padding(padding)
            .background(KitSurfaceBackground(surface, radius: radius, corners: look.corners))
            .brightness(surface.brightness)
            .scaleEffect(reduceMotion ? 1 : (pressed ? 0.97 : 1))
            .opacity(isEnabled ? 1 : 0.4)
            .contentShape(shape)
            .pointerCursor(isEnabled)
            .onHover { hovering in
                guard isEnabled else { return }
                withAnimation(reduceMotion ? nil : KitTheme.quick) { isHovering = hovering }
            }
            .onChange(of: isEnabled) { _, enabled in
                if !enabled { isHovering = false }
            }
    }
}

public extension ButtonStyle where Self == GenPrimaryButtonStyle {
    /// `.buttonStyle(.genPrimary())`: the one filled primary button of a view.
    static func genPrimary(accent: Color? = nil, cornerRadius: CGFloat = KitTheme.radiusSmall,
                           padding: EdgeInsets = EdgeInsets(top: 4, leading: 11, bottom: 4, trailing: 11))
        -> GenPrimaryButtonStyle
    {
        GenPrimaryButtonStyle(accent: accent, cornerRadius: cornerRadius, padding: padding)
    }
}
