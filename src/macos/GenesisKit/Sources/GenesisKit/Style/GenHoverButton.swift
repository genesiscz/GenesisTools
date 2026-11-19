import SwiftUI

/// **The** hover/press treatment for buttons in this app.
///
/// Before this existed, every surface re-invented it: some buttons scaled, some tinted, most
/// did nothing at all, and a new control shipped with no feedback roughly every time. Reach for
/// `.buttonStyle(.genHover())` on any `Button` and stop deciding.
///
/// Three states, all cheap:
/// - rest: nothing drawn, so a row of these does not look like a toolbar of chips
/// - hover: a soft accent fill and a 1px accent border, inside the control's own frame
/// - pressed: the fill deepens and the control shrinks a little, so a click reads as a click
///
/// The hover never grows the control. It used to lift it by 4 % (8 % for an icon): the fill and its outline then
/// drew past the frame into the gap toward the next control, the text scaled with it, and a round icon's outline drew
/// with corners (owner, 2026-11-19: "the GenesisKit buttons are just somewhat broken with the padding / spacing on the
/// hover"). `GenHoverButtonStyle.lift` keeps that look for a caller who wants it (`.genHover(scale: .lift)`).
/// Reduce Motion drops the pressed scale and keeps the colour change.
///
/// In a window with a `KitLook` the fill and the border are the look's wash; an `accent` the caller names (a
/// destructive red) still tints it.
public struct GenHoverButtonStyle: ButtonStyle {
    /// Nil: the kit's amber, or the look's own wash.
    var accent: Color?
    var cornerRadius: CGFloat = KitTheme.radiusSmall
    /// Padding added around the label so small glyphs still get a comfortable hit target.
    var padding: EdgeInsets = EdgeInsets(top: 4, leading: 6, bottom: 4, trailing: 6)
    /// Set false for a control that already draws its own container (a filled pill, a card).
    var drawsBackground: Bool = true
    /// The size under the pointer. 1: the control keeps its frame (the default since 2026-11-19).
    var scale: CGFloat = 1
    /// `.circular` for a round control: the continuous curve at half the height draws a corner.
    var corners: RoundedCornerStyle = .continuous
    /// Scale while pressed. A full-width row at 0.97 jumps by several points, so rows use ~1.
    var pressedScale: CGFloat = 0.97
    /// Lightens the label on hover. The only feedback that is safe on ANY label, including one
    /// that already paints its own capsule, card or glyph background.
    var brighten: Double = 0

    @State private var isHovering = false
    @GenReduceMotion private var reduceMotion
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.kitForcedInteraction) private var forced
    @Environment(\.kitLook) private var look

    public func makeBody(configuration: Configuration) -> some View {
        let active = (isHovering || forced == .hover) && isEnabled
        let pressed = (configuration.isPressed || forced == .pressed) && isEnabled
        let surface = look.surface(.wash, pressed ? .pressed : (active ? .hover : .rest), tint: accent)

        return configuration.label
            .padding(padding)
            .background {
                if drawsBackground {
                    KitSurfaceBackground(surface, radius: cornerRadius, corners: corners)
                }
            }
            .brightness(pressed ? brighten * 1.6 : (active ? brighten : 0))
            .scaleEffect(reduceMotion ? 1 : (pressed ? pressedScale : (active ? scale : 1)))
            .opacity(isEnabled ? 1 : 0.4)
            .contentShape(RoundedRectangle(cornerRadius: cornerRadius, style: corners))
            .pointerCursor(isEnabled)
            .onHover { hovering in
                guard isEnabled else { return }
                withAnimation(reduceMotion ? nil : KitTheme.quick) { isHovering = hovering }
            }
            // A disabled control must not keep a hover it acquired while it was enabled.
            .onChange(of: isEnabled) { _, enabled in
                if !enabled { isHovering = false }
            }
    }
}

public extension GenHoverButtonStyle {
    /// The hover lift every style had before 2026-11-19: the control grew by 4 % under the pointer.
    static let lift: CGFloat = 1.04
    /// The icon style's old lift (8 %).
    static let iconLift: CGFloat = 1.08
}

public extension ButtonStyle where Self == GenHoverButtonStyle {
    /// `.buttonStyle(.genHover())` — the default for every button in the app.
    static func genHover(
        accent: Color? = nil,
        cornerRadius: CGFloat = KitTheme.radiusSmall,
        padding: EdgeInsets = EdgeInsets(top: 4, leading: 6, bottom: 4, trailing: 6),
        drawsBackground: Bool = true,
        scale: CGFloat = 1
    ) -> GenHoverButtonStyle {
        GenHoverButtonStyle(accent: accent, cornerRadius: cornerRadius, padding: padding,
                            drawsBackground: drawsBackground, scale: scale)
    }

    /// **The blanket replacement for `.buttonStyle(.genHoverPlain())`.**
    ///
    /// Draws nothing of its own, so it cannot fight a label that already paints a capsule, a
    /// card or a glyph background, and adds no padding, so no layout moves. What it adds is the
    /// thing `.plain` is missing: the control reacts to the pointer at all.
    ///
    /// Default `scale` is 1: these are applied to rows and full-width cards as well as to
    /// glyphs, and a row that grows on hover clips against its container.
    static func genHoverPlain(scale: CGFloat = 1, brighten: Double = 0.22) -> GenHoverButtonStyle {
        GenHoverButtonStyle(cornerRadius: KitTheme.radiusSmall, padding: EdgeInsets(),
                            drawsBackground: false, scale: scale, brighten: brighten)
    }

    /// A square icon button: circular feedback, no extra padding, for glyph-only controls. `scale: .iconLift` brings
    /// back the old hover lift.
    static func genHoverIcon(accent: Color? = nil, diameter: CGFloat = 22, scale: CGFloat = 1) -> GenHoverButtonStyle {
        GenHoverButtonStyle(accent: accent, cornerRadius: diameter / 2,
                            padding: EdgeInsets(top: 3, leading: 3, bottom: 3, trailing: 3),
                            drawsBackground: true, scale: scale, corners: .circular)
    }

    /// A full-width row or card: the fill and border, no scale (a growing row clips).
    static func genHoverRow(accent: Color? = nil,
                            cornerRadius: CGFloat = KitTheme.radiusMedium) -> GenHoverButtonStyle {
        GenHoverButtonStyle(accent: accent, cornerRadius: cornerRadius, padding: EdgeInsets(),
                            drawsBackground: true, scale: 1, pressedScale: 0.996, brighten: 0.1)
    }
}

/// For a control that cannot be a `Button` (a `Menu` label, a tappable row): the same hover
/// treatment as a modifier.
struct GenHoverEffect: ViewModifier {
    var accent: Color = KitTheme.accent
    var cornerRadius: CGFloat = KitTheme.radiusSmall
    var scale: CGFloat = 1

    @State private var isHovering = false
    @GenReduceMotion private var reduceMotion

    func body(content: Content) -> some View {
        content
            .background(
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .fill(accent.opacity(isHovering ? 0.12 : 0))
                    .overlay(
                        RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                            .strokeBorder(accent.opacity(isHovering ? 0.45 : 0), lineWidth: 1)
                    )
            )
            .scaleEffect(reduceMotion ? 1 : (isHovering ? scale : 1))
            .contentShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
            .pointerCursor()
            .onHover { hovering in
                withAnimation(reduceMotion ? nil : KitTheme.quick) { isHovering = hovering }
            }
    }
}

public extension View {
    /// `.genHoverEffect()` — hover feedback for something that is not a `Button`.
    func genHoverEffect(accent: Color = KitTheme.accent, cornerRadius: CGFloat = KitTheme.radiusSmall,
                        scale: CGFloat = 1) -> some View {
        modifier(GenHoverEffect(accent: accent, cornerRadius: cornerRadius, scale: scale))
    }
}
