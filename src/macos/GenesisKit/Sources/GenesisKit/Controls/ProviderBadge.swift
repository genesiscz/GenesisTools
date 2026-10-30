import SwiftUI

/// An agent's mark on a square in its colour (`AIProviderMark`): Claude, Codex, Grok; any other agent keeps its first
/// letter.
public struct ProviderBadge: View {
    let provider: String
    var size: CGFloat
    var tooltip: String?

    public init(provider: String, size: CGFloat = 18, tooltip: String? = nil) {
        self.provider = provider
        self.size = size
        self.tooltip = tooltip
    }

    /// A harness draws the mark its TypeScript driver names (`Harness.markLetter`, `Harness.markColor`).
    public static func style(for provider: String) -> (letter: String, color: Color) {
        guard let harness = Harness(rawValue: provider.lowercased()) else {
            return (String(provider.prefix(1)).uppercased(), KitPalette.dim)
        }

        let rgb = harness.markColor
        return (harness.markLetter, Color(red: rgb.red, green: rgb.green, blue: rgb.blue))
    }

    public var body: some View {
        let style = Self.style(for: provider)
        AIProviderGlyphBody(provider: provider, letter: style.letter, color: style.color, size: size, style: .filled)
            .instantTooltip(tooltip ?? provider)
            .accessibilityLabel(Text(tooltip ?? provider))
    }
}
