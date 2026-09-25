// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground.worktrees/genesis-session-redesign/Genesis/apps/Genesis/Sources/Genesis/UI/GenHoverButton.swift at 2026-09-24T08:22:05+02:00 at commit hash 352701bd4e327a97ee223015319f46223ad3a6e5
import SwiftUI

/// **The** hover/press treatment for buttons in this app.
///
/// Before this existed, every surface re-invented it: some buttons scaled, some tinted, most
/// did nothing at all, and a new control shipped with no feedback roughly every time. Reach for
/// `.buttonStyle(.genHover())` on any `Button` and stop deciding.
///
/// Three states, all cheap:
/// - rest: nothing drawn, so a row of these does not look like a toolbar of chips
/// - hover: a soft accent fill, a 1px accent border, a small lift
/// - pressed: the fill deepens and the lift inverts, so a click reads as a click
///
/// The lift is a `scaleEffect` — a transform, never an animated shadow, which profiling in this
/// repo called out as its single biggest idle-CPU sink (see the `PulseGlow` comment in
/// `Theme.swift`). Reduce Motion drops the scale and keeps the colour change.
struct GenHoverButtonStyle: ButtonStyle {
    var accent: Color = .genAccent
    var cornerRadius: CGFloat = GenRadius.sm
    /// Padding added around the label so small glyphs still get a comfortable hit target.
    var padding: EdgeInsets = EdgeInsets(top: 4, leading: 6, bottom: 4, trailing: 6)
    /// Set false for a control that already draws its own container (a filled pill, a card).
    var drawsBackground: Bool = true
    var scale: CGFloat = 1.04
    /// Scale while pressed. A full-width row at 0.97 jumps by several points, so rows use ~1.
    var pressedScale: CGFloat = 0.97
    /// Lightens the label on hover. The only feedback that is safe on ANY label, including one
    /// that already paints its own capsule, card or glyph background.
    var brighten: Double = 0

    @State private var isHovering = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        let active = isHovering && isEnabled
        let pressed = configuration.isPressed && isEnabled

        return configuration.label
            .padding(padding)
            .background {
                if drawsBackground {
                    RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                        .fill(accent.opacity(pressed ? 0.22 : (active ? 0.12 : 0)))
                        .overlay(
                            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                                .strokeBorder(accent.opacity(active || pressed ? 0.45 : 0), lineWidth: 1)
                        )
                }
            }
            .brightness(pressed ? brighten * 1.6 : (active ? brighten : 0))
            .scaleEffect(reduceMotion ? 1 : (pressed ? pressedScale : (active ? scale : 1)))
            .opacity(isEnabled ? 1 : 0.4)
            .contentShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
            .onHover { hovering in
                guard isEnabled else { return }
                withAnimation(reduceMotion ? nil : GenAnimation.quick) { isHovering = hovering }
            }
            // A disabled control must not keep a hover it acquired while it was enabled.
            .onChange(of: isEnabled) { _, enabled in
                if !enabled { isHovering = false }
            }
    }
}

extension ButtonStyle where Self == GenHoverButtonStyle {
    /// `.buttonStyle(.genHover())` — the default for every button in the app.
    static func genHover(
        accent: Color = .genAccent,
        cornerRadius: CGFloat = GenRadius.sm,
        padding: EdgeInsets = EdgeInsets(top: 4, leading: 6, bottom: 4, trailing: 6),
        drawsBackground: Bool = true,
        scale: CGFloat = 1.04
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
        GenHoverButtonStyle(cornerRadius: GenRadius.sm, padding: EdgeInsets(),
                            drawsBackground: false, scale: scale, brighten: brighten)
    }

    /// A square icon button: circular feedback, no extra padding, for glyph-only controls.
    static func genHoverIcon(accent: Color = .genAccent, diameter: CGFloat = 22) -> GenHoverButtonStyle {
        GenHoverButtonStyle(accent: accent, cornerRadius: diameter / 2,
                            padding: EdgeInsets(top: 3, leading: 3, bottom: 3, trailing: 3),
                            drawsBackground: true, scale: 1.08)
    }

    /// A full-width row or card: the fill and border, no scale (a growing row clips).
    static func genHoverRow(accent: Color = .genAccent,
                            cornerRadius: CGFloat = GenRadius.md) -> GenHoverButtonStyle {
        GenHoverButtonStyle(accent: accent, cornerRadius: cornerRadius, padding: EdgeInsets(),
                            drawsBackground: true, scale: 1, pressedScale: 0.996, brighten: 0.1)
    }
}

/// For a control that cannot be a `Button` (a `Menu` label, a tappable row): the same hover
/// treatment as a modifier.
struct GenHoverEffect: ViewModifier {
    var accent: Color = .genAccent
    var cornerRadius: CGFloat = GenRadius.sm
    var scale: CGFloat = 1.04

    @State private var isHovering = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

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
            .onHover { hovering in
                withAnimation(reduceMotion ? nil : GenAnimation.quick) { isHovering = hovering }
            }
    }
}

extension View {
    /// `.genHoverEffect()` — hover feedback for something that is not a `Button`.
    func genHoverEffect(accent: Color = .genAccent, cornerRadius: CGFloat = GenRadius.sm,
                        scale: CGFloat = 1.04) -> some View {
        modifier(GenHoverEffect(accent: accent, cornerRadius: cornerRadius, scale: scale))
    }
}
