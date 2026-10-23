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

    public static func style(for provider: String) -> (letter: String, color: Color) {
        switch provider.lowercased() {
        case "claude": return ("C", Color(red: 0.85, green: 0.47, blue: 0.34))
        case "codex": return ("X", Color(red: 0.55, green: 0.75, blue: 0.95))
        case "grok": return ("G", Color(red: 0.75, green: 0.75, blue: 0.78))
        default: return (String(provider.prefix(1)).uppercased(), KitPalette.dim)
        }
    }

    public var body: some View {
        let style = Self.style(for: provider)
        AIProviderGlyphBody(provider: provider, letter: style.letter, color: style.color, size: size, style: .filled)
            .instantTooltip(tooltip ?? provider)
            .accessibilityLabel(Text(tooltip ?? provider))
    }
}
