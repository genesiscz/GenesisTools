import AppKit
import SwiftUI

/// The colours the kit's charts draw in, tuned for the dark kit background: ten hues of similar weight (none shouts
/// over the others), a muted grey for "other" and unaccounted space, and the shading rules the hierarchical charts
/// share (a hue per top-level branch, a small hue turn per sibling, lighter and calmer with each ring of depth).
public enum ChartPalette {
    /// sRGB components of the categorical hues: blue, teal, amber, rose, violet, green, orange, sky, pink, lime.
    static let components: [(Double, Double, Double)] = [
        (0.357, 0.553, 0.937), (0.235, 0.769, 0.722), (0.949, 0.702, 0.239), (0.937, 0.420, 0.482),
        (0.608, 0.482, 0.941), (0.357, 0.780, 0.478), (0.941, 0.541, 0.294), (0.345, 0.718, 0.941),
        (0.847, 0.467, 0.788), (0.663, 0.812, 0.329),
    ]

    /// The categorical hues, in order. Index past the end wraps.
    public static let categorical: [Color] = components.map { Color(.sRGB, red: $0.0, green: $0.1, blue: $0.2) }

    /// Unaccounted, "other" and file space: a quiet grey that never reads as a category.
    public static let muted = Color(white: 0.36)

    /// The categorical hue `index` (wrapping).
    public static func color(_ index: Int) -> Color {
        categorical[((index % categorical.count) + categorical.count) % categorical.count]
    }

    /// The fill of a node in a hierarchical chart: `branch`'s hue turned a little by `sibling` (so a drilled-in view
    /// that is all one branch still tells its children apart), lighter and less saturated with each `ring` of depth.
    /// `muted` nodes are grey at every depth.
    static func shade(branch: Int, sibling: Int, ring: Double, muted: Bool, color override: ChartColor? = nil) -> NSColor {
        let depth = max(0, ring - 1)
        if muted || (branch < 0 && override == nil) {
            let white = min(0.62, 0.30 + 0.05 * depth)
            return NSColor(srgbRed: white, green: white, blue: white + 0.015, alpha: 1)
        }
        let base = override.map { ($0.red, $0.green, $0.blue) }
            ?? components[((branch % components.count) + components.count) % components.count]
        let color = NSColor(srgbRed: base.0, green: base.1, blue: base.2, alpha: 1)
        var hue: CGFloat = 0
        var saturation: CGFloat = 0
        var brightness: CGFloat = 0
        var alpha: CGFloat = 0
        color.getHue(&hue, saturation: &saturation, brightness: &brightness, alpha: &alpha)
        // Neighbouring siblings differ in hue and a little in brightness, so a view that is all one branch still
        // separates its parts; the turn stays small enough that the branch keeps its colour.
        // A host colour means something (an age, a type), so it is not turned.
        let turn = override == nil ? CGFloat((sibling % 5) - 2) * 0.03 : 0
        hue = (hue + turn).truncatingRemainder(dividingBy: 1)
        if hue < 0 { hue += 1 }
        saturation *= CGFloat(max(0.45, 1 - 0.13 * depth))
        let step = override == nil ? CGFloat((sibling % 3) - 1) * 0.06 : 0
        brightness = min(1, brightness * (CGFloat(0.92 + 0.05 * depth) + step))
        return NSColor(hue: hue, saturation: saturation, brightness: brightness, alpha: 1)
            .usingColorSpace(.sRGB) ?? color
    }

    /// Relative luminance (WCAG) of an sRGB colour, for picking label ink.
    static func luminance(_ color: NSColor) -> Double {
        guard let rgb = color.usingColorSpace(.sRGB) else { return 0.5 }
        func channel(_ value: CGFloat) -> Double {
            let v = Double(value)
            return v <= 0.03928 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * channel(rgb.redComponent) + 0.7152 * channel(rgb.greenComponent)
            + 0.0722 * channel(rgb.blueComponent)
    }

    /// Text that reads on `fill`: near-black on light fills, near-white on the rest.
    static func ink(on fill: NSColor) -> Color {
        luminance(fill) > 0.42 ? Color.black.opacity(0.82) : Color.white.opacity(0.95)
    }

    /// The health ramp: green at 1, amber in the middle, red at 0, blended smoothly between.
    public static func ramp(_ value: Double) -> Color {
        Color(nsColor: rampColor(value))
    }

    static func rampColor(_ value: Double) -> NSColor {
        let v = min(1, max(0, value))
        let red = (0.937, 0.420, 0.420)
        let amber = (0.960, 0.690, 0.260)
        let green = (0.380, 0.800, 0.490)
        func mix(_ a: (Double, Double, Double), _ b: (Double, Double, Double), _ t: Double) -> NSColor {
            NSColor(srgbRed: a.0 + (b.0 - a.0) * t, green: a.1 + (b.1 - a.1) * t, blue: a.2 + (b.2 - a.2) * t, alpha: 1)
        }
        // Amber holds the middle third, so "a bit low" never already looks alarming.
        if v < 0.3 { return mix(red, amber, v / 0.3) }
        if v < 0.6 { return mix(amber, amber, 0) }
        return mix(amber, green, min(1, (v - 0.6) / 0.25))
    }
}

extension View {
    /// Sets the identifier only when there is one: an empty identifier would replace one the caller set outside.
    @ViewBuilder
    func chartAccessibilityIdentifier(_ identifier: String?) -> some View {
        if let identifier { accessibilityIdentifier(identifier) } else { self }
    }
}
