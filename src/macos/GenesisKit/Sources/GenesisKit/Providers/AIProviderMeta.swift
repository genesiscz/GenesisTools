import SwiftUI

/// Display vocabulary per provider plugin id. A harness's plugin takes its name, letter and colour from its driver
/// (`Harness`, written from the TypeScript drivers), so every surface draws a harness in one colour.
public struct AIProviderMeta: Equatable, Sendable {
    public var id: String
    public var alias: String
    public var displayName: String
    /// One glyph for tight spaces: the menu bar title and row leaders.
    public var glyph: String
    public var color: Color

    public init(id: String, alias: String, displayName: String, glyph: String, color: Color) {
        self.id = id
        self.alias = alias
        self.displayName = displayName
        self.glyph = glyph
        self.color = color
    }
}

extension Harness {
    /// The harness's one colour in SwiftUI (`markColor`): its badge, its roster tag and its provider rows.
    public var color: Color {
        let rgb = markColor
        return Color(red: rgb.red, green: rgb.green, blue: rgb.blue)
    }
}

public enum AIProviders {
    /// The only provider the legacy Claude-only cache and the scored ranker can describe.
    public static let anthropicSubscription = "anthropic-sub"

    /// One row per harness, in the drivers' order.
    public static let known: [AIProviderMeta] = Harness.allCases.map { harness in
        AIProviderMeta(
            id: harness.plugin,
            alias: harness.rawValue,
            displayName: harness.label,
            glyph: harness.markLetter,
            color: harness.color
        )
    }

    /// Metadata for a plugin id. Unknown providers use the names a usage cache carries, else the id
    /// itself. (GenesisAIMonitorKit adds `meta(for:file:)` over its `AIProviderUsage`.)
    public static func meta(for id: String, displayName: String? = nil, alias: String? = nil) -> AIProviderMeta {
        if let known = known.first(where: { $0.id == id || $0.alias == id }) {
            return known
        }

        let name = displayName ?? id
        return AIProviderMeta(
            id: id,
            alias: alias ?? id,
            displayName: name,
            glyph: String(name.prefix(1)).uppercased(),
            color: .secondary
        )
    }

    public static func order(_ id: String) -> Int {
        known.firstIndex { $0.id == id } ?? known.count
    }
}

/// The provider's mark (`AIProviderMark`) in its tinted box: the leader of an account row, and the marker on a session
/// row. A provider with no mark keeps its letter. `style` picks the tinted box, the bare mark or a solid badge.
public struct AIProviderGlyph: View {
    public var meta: AIProviderMeta
    public var size: CGFloat
    public var style: AIProviderGlyphStyle

    public init(meta: AIProviderMeta, size: CGFloat = 16, style: AIProviderGlyphStyle = .tinted) {
        self.meta = meta
        self.size = size
        self.style = style
    }

    public var body: some View {
        AIProviderGlyphBody(provider: meta.alias, letter: meta.glyph, color: meta.color, size: size, style: style)
            .accessibilityElement()
            .accessibilityLabel(meta.displayName)
    }
}
