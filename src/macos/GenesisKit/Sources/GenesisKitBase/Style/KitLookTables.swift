import SwiftUI

// One table per look: a surface role and a state in, the drawing out. Opacities are of the window's ink (white in a
// dark window), so a look also holds in a light window.

/// What the kit drew before looks existed. The roles that had a control then (well, thumb, segment, primary, ghost,
/// wash) answer its exact values; the newer roles answer in the same quiet grey.
enum KitClassicLook {
    /// The filled button's blue (`GenPrimaryButtonStyle.blue`).
    static let primaryBlue = Color(red: 0.12, green: 0.32, blue: 0.80)
    /// The hover styles' amber (`KitTheme.accent`).
    static let accent = Color(red: 1.0, green: 0.76, blue: 0.28)

    static func surface(_ ask: KitSurfaceAsk) -> KitSurface {
        let ink = ask.ink
        switch ask.role {
        case .well:
            return KitSurface(fill: ink.opacity(0.06), label: ink)
        case .thumb:
            return KitSurface(fill: Color.accentColor, label: .white)
        case .segment:
            return KitSurface(fill: ink.opacity(ask.by(0, 0.055, 0.10)), label: ink.opacity(0.68))
        case .primary:
            return KitSurface(fill: ask.tint ?? primaryBlue, label: .white, brightness: ask.by(0, 0.08, -0.1))
        case .tinted:
            return KitSurface(fill: ask.colour.opacity(ask.by(0.16, 0.22, 0.28)), stroke: KitSurface.line(ask.colour.opacity(0.5)),
                              strokeWidth: 0.5, label: ask.colour)
        case .soft:
            return KitSurface(fill: ink.opacity(ask.by(0.06, 0.09, 0.13)), label: ink.opacity(0.88), glyph: ink.opacity(0.5))
        case .ghost:
            return KitSurface(fill: ink.opacity(ask.by(0, 0.055, 0.10)), stroke: KitSurface.line(ink.opacity(0.11)),
                              label: ink.opacity(0.88), glyph: ink.opacity(0.5))
        case .plain:
            return KitSurface(fill: ink.opacity(ask.by(0, 0.055, 0.10)), label: ask.hue == .neutral ? ink.opacity(0.88) : ask.colour)
        case .badge:
            return ask.selected
                ? KitSurface(fill: Color.white.opacity(0.24), label: .white)
                : KitSurface(fill: ink.opacity(0.06), label: ink.opacity(0.5))
        case .wash:
            let colour = ask.tint ?? accent
            return KitSurface(fill: colour.opacity(ask.by(0, 0.12, 0.22)), stroke: KitSurface.line(colour.opacity(ask.by(0, 0.45, 0.45))), label: ink)
        }
    }
}

/// Raised dark surfaces and a hue per meaning. The selected segment is a lighter pill, not a colour; colour comes
/// from glyphs, counts, tinted actions and the one filled main action, which glows in its hue.
enum KitAuroraLook {
    static func surface(_ ask: KitSurfaceAsk) -> KitSurface {
        let ink = ask.ink
        let colour = ask.colour
        let neutral = ask.hue == .neutral && ask.tint == nil
        switch ask.role {
        case .well:
            return ask.dark
                ? KitSurface(fill: Color.black.opacity(0.30), stroke: KitSurface.line(ink.opacity(0.09)), label: ink)
                : KitSurface(fill: Color.black.opacity(0.05), stroke: KitSurface.line(ink.opacity(0.07)), label: ink)
        case .thumb:
            return ask.dark
                ? KitSurface(fill: KitSurface.fall(Color(white: 0.31), Color(white: 0.24)),
                             stroke: KitSurface.lit(Color.white.opacity(0.20), Color.white.opacity(0.05)),
                             shadow: KitShadow(Color.black.opacity(0.45), radius: 1.5, y: 1),
                             label: .white, glyph: neutral ? Color.white.opacity(0.9) : colour)
                : KitSurface(fill: Color.white, stroke: KitSurface.line(Color.black.opacity(0.10)),
                             shadow: KitShadow(Color.black.opacity(0.14), radius: 1.5, y: 1),
                             label: .black, glyph: neutral ? Color.black.opacity(0.8) : ask.hue.solid)
        case .segment:
            return KitSurface(fill: ink.opacity(ask.by(0, 0.06, 0.10)), label: ink.opacity(0.62),
                              glyph: neutral ? ink.opacity(0.5) : colour.opacity(0.9))
        case .primary:
            let fill = ask.tint.map { AnyShapeStyle($0) } ?? AnyShapeStyle(KitSurface.fall(ask.hue.bright, ask.hue.solid))
            return KitSurface(fill: fill, stroke: KitSurface.lit(Color.white.opacity(0.34), Color.white.opacity(0.04)),
                              shadow: KitShadow((ask.tint ?? ask.hue.solid).opacity(neutral ? 0.35 : 0.55), radius: 7, y: 3),
                              label: .white, brightness: ask.by(0, 0.07, -0.08))
        case .tinted:
            return KitSurface(fill: colour.opacity(ask.by(0.15, 0.22, 0.28)), stroke: KitSurface.line(colour.opacity(0.38)),
                              label: neutral ? ink.opacity(0.92) : colour)
        case .soft:
            return KitSurface(fill: ink.opacity(ask.by(0.075, 0.115, 0.15)), stroke: KitSurface.line(ink.opacity(0.08)),
                              label: ink.opacity(0.9), glyph: neutral ? ink.opacity(0.62) : colour)
        case .ghost:
            return KitSurface(fill: ink.opacity(ask.by(0, 0.06, 0.10)), stroke: KitSurface.line(ink.opacity(0.15)),
                              label: ink.opacity(0.88), glyph: neutral ? ink.opacity(0.58) : colour)
        case .plain:
            return KitSurface(fill: (neutral ? ink : colour).opacity(ask.by(0, neutral ? 0.06 : 0.12, neutral ? 0.10 : 0.18)),
                              label: neutral ? ink.opacity(0.88) : colour)
        case .badge:
            return neutral
                ? KitSurface(fill: ink.opacity(ask.selected ? 0.16 : 0.10), label: ink.opacity(ask.selected ? 0.9 : 0.7))
                : KitSurface(fill: colour.opacity(ask.selected ? 0.28 : 0.20), label: colour)
        case .wash:
            return ask.tint.map { tint in
                KitSurface(fill: tint.opacity(ask.by(0, 0.14, 0.22)), stroke: KitSurface.line(tint.opacity(ask.by(0, 0.30, 0.30))), label: ink)
            } ?? KitSurface(fill: ink.opacity(ask.by(0, 0.09, 0.14)), label: ink)
        }
    }
}

/// Capsules and saturated colour. The selected segment and the main action are gradients in their hue with a glow;
/// a count is a bright chip. The most playful look.
enum KitCandyLook {
    static func surface(_ ask: KitSurfaceAsk) -> KitSurface {
        let ink = ask.ink
        let colour = ask.colour
        let neutral = ask.hue == .neutral && ask.tint == nil
        let hue = ask.hue == .neutral ? KitHue.play : ask.hue
        let slant = LinearGradient(colors: [hue.bright, hue.solid], startPoint: .topLeading, endPoint: .bottomTrailing)
        switch ask.role {
        case .well:
            return KitSurface(fill: ink.opacity(0.07), label: ink)
        case .thumb:
            return KitSurface(fill: slant, stroke: KitSurface.lit(Color.white.opacity(0.30), Color.white.opacity(0.02)),
                              shadow: KitShadow(hue.solid.opacity(0.60), radius: 6, y: 2), label: .white)
        case .segment:
            return KitSurface(fill: ink.opacity(ask.by(0, 0.08, 0.12)), label: ink.opacity(0.72),
                              glyph: neutral ? ink.opacity(0.6) : colour)
        case .primary:
            let own = LinearGradient(colors: [ask.hue.bright, ask.hue.solid], startPoint: .topLeading, endPoint: .bottomTrailing)
            let fill = ask.tint.map { AnyShapeStyle($0) } ?? AnyShapeStyle(own)
            return KitSurface(fill: fill, stroke: KitSurface.lit(Color.white.opacity(0.36), Color.white.opacity(0.02)),
                              shadow: KitShadow((ask.tint ?? ask.hue.solid).opacity(neutral ? 0.40 : 0.65), radius: 9, y: 3),
                              label: .white, brightness: ask.by(0, 0.08, -0.08))
        case .tinted:
            return neutral
                ? KitSurface(fill: ink.opacity(ask.by(0.16, 0.21, 0.26)), label: ink.opacity(0.95))
                : KitSurface(fill: colour.opacity(ask.by(0.24, 0.32, 0.38)), label: colour)
        case .soft:
            return KitSurface(fill: ink.opacity(ask.by(0.10, 0.14, 0.18)), label: ink.opacity(0.92),
                              glyph: neutral ? ink.opacity(0.7) : colour)
        case .ghost:
            return KitSurface(fill: ink.opacity(ask.by(0, 0.08, 0.12)), stroke: KitSurface.line(ink.opacity(0.24)), strokeWidth: 1.5,
                              label: ink.opacity(0.9), glyph: neutral ? ink.opacity(0.65) : colour)
        case .plain:
            return neutral
                ? KitSurface(fill: ink.opacity(ask.by(0, 0.08, 0.12)), label: ink.opacity(0.9))
                : KitSurface(fill: colour.opacity(ask.by(0, 0.14, 0.20)), label: colour)
        case .badge:
            if ask.selected { return KitSurface(fill: Color.white.opacity(0.28), label: .white) }
            return neutral
                ? KitSurface(fill: ink.opacity(0.16), label: ink.opacity(0.9))
                : KitSurface(fill: ask.tint ?? ask.hue.solid, label: .white)
        case .wash:
            let own = ask.tint ?? KitHue.play.ink
            return KitSurface(fill: own.opacity(ask.by(0, 0.18, 0.26)), label: ink)
        }
    }
}

/// Translucent surfaces lit from above, and hairlines. A surface has no colour; a hue shows on a glyph, on a count
/// and as a short line under the selected segment. The calmest look.
enum KitGlassLook {
    static func surface(_ ask: KitSurfaceAsk) -> KitSurface {
        let ink = ask.ink
        let colour = ask.colour
        let neutral = ask.hue == .neutral && ask.tint == nil
        switch ask.role {
        case .well:
            return KitSurface(fill: ink.opacity(0.045), stroke: KitSurface.lit(ink.opacity(0.16), ink.opacity(0.04)), label: ink)
        case .thumb:
            return KitSurface(fill: ink.opacity(0.10), stroke: KitSurface.lit(ink.opacity(0.32), ink.opacity(0.08)),
                              label: ink, glyph: ink.opacity(0.9), indicator: neutral ? KitHue.play.ink : colour)
        case .segment:
            return KitSurface(fill: ink.opacity(ask.by(0, 0.05, 0.08)), label: ink.opacity(0.56), glyph: ink.opacity(0.5))
        case .primary:
            return KitSurface(fill: ask.tint ?? ask.hue.solid, stroke: KitSurface.lit(Color.white.opacity(0.36), Color.white.opacity(0.04)),
                              label: .white, brightness: ask.by(0, 0.06, -0.08))
        case .tinted:
            return KitSurface(fill: ink.opacity(ask.by(0.06, 0.10, 0.13)), stroke: KitSurface.lit(ink.opacity(0.24), ink.opacity(0.06)),
                              label: ink.opacity(0.92), glyph: neutral ? KitHue.play.ink : colour)
        case .soft:
            return KitSurface(fill: ink.opacity(ask.by(0.05, 0.08, 0.11)), stroke: KitSurface.lit(ink.opacity(0.14), ink.opacity(0.04)),
                              label: ink.opacity(0.88), glyph: ink.opacity(0.55))
        case .ghost:
            return KitSurface(fill: ink.opacity(ask.by(0, 0.05, 0.08)), stroke: KitSurface.lit(ink.opacity(0.20), ink.opacity(0.07)),
                              label: ink.opacity(0.85), glyph: ink.opacity(0.55))
        case .plain:
            return KitSurface(fill: ink.opacity(ask.by(0, 0.05, 0.08)), label: ink.opacity(0.82))
        case .badge:
            return KitSurface(label: neutral ? ink.opacity(ask.selected ? 0.75 : 0.5) : colour)
        case .wash:
            let own = ask.tint
            return KitSurface(fill: (own ?? ink).opacity(ask.by(0, own == nil ? 0.07 : 0.10, own == nil ? 0.10 : 0.16)),
                              stroke: KitSurface.lit((own ?? ink).opacity(ask.by(0, 0.22, 0.22)), (own ?? ink).opacity(ask.by(0, 0.06, 0.06))),
                              label: ink)
        }
    }
}
