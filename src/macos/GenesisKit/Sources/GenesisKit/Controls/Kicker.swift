import SwiftUI

public extension View {
    /// A tiny uppercase monospaced label over a section or beside a value ("SESSION HISTORY",
    /// "APPROVE?"). The one recipe instead of font + colour + text case + kerning at each site.
    func kicker(size: CGFloat = 10, weight: Font.Weight = .medium, color: Color = KitPalette.dim, kerning: CGFloat = 1.5) -> some View {
        font(.system(size: size, weight: weight, design: .monospaced))
            .foregroundColor(color)
            .textCase(.uppercase)
            .kerning(kerning)
    }
}
