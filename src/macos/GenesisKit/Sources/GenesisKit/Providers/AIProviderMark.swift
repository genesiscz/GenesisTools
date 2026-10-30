import SwiftUI

/// A coding agent's logo as a shape: Claude's starburst, Codex's terminal cloud, Grok's slashed ring. Every surface
/// that names an agent by its mark draws it through this (`AIProviderGlyph`, `ProviderBadge`), so a change lands
/// everywhere at once. The paths are each harness's `Harness.markLogo`, written from its TypeScript driver (LobeHub's
/// icon set, MIT, `@lobehub/icons-static-svg`), 24 × 24, even-odd fill.
public struct AIProviderMark: Shape {
    /// The harness whose logo this draws.
    public typealias Kind = Harness

    public let kind: Kind

    public init(_ kind: Kind) {
        self.kind = kind
    }

    public func path(in rect: CGRect) -> Path {
        let unit = Self.paths[kind] ?? Path()
        let scale = min(rect.width, rect.height) / 24
        let dx = rect.minX + (rect.width - 24 * scale) / 2
        let dy = rect.minY + (rect.height - 24 * scale) / 2
        return unit.applying(CGAffineTransform(a: scale, b: 0, c: 0, d: scale, tx: dx, ty: dy))
    }

    /// Parsed once: these paths are drawn in every session row. A harness with no logo has no entry.
    static let paths: [Kind: Path] = Dictionary(uniqueKeysWithValues: Harness.allCases.compactMap { harness in
        harness.markLogo.map { (harness, SVGPath.parse($0)) }
    })
}

extension Harness {
    /// The harness whose logo a provider wears: its id, its provider plugin (`anthropic-sub`) or its vendor's
    /// model-provider id (`anthropic`), in any case; nil for a provider with no logo, which keeps its letter.
    public init?(provider: String) {
        let name = provider.lowercased()
        guard let harness = Harness.allCases.first(where: { harness in
            harness.markLogo != nil && [harness.rawValue, harness.plugin, harness.vendor].contains(name)
        }) else { return nil }
        self = harness
    }
}

/// How a provider glyph is drawn.
public enum AIProviderGlyphStyle: Sendable {
    /// The mark in its provider colour on a tinted rounded square: row leaders, rails.
    case tinted
    /// The mark alone, in its provider colour: inline in text and tight spaces.
    case plain
    /// The mark in dark on a solid provider-coloured square (`ProviderBadge`).
    case filled
}

/// One provider glyph in any style; a provider with no mark keeps its letter.
struct AIProviderGlyphBody: View {
    let provider: String
    let letter: String
    let color: Color
    let size: CGFloat
    let style: AIProviderGlyphStyle

    var body: some View {
        let kind = AIProviderMark.Kind(provider: provider)
        let inset = style == .plain ? 0 : size * 0.18
        ZStack {
            switch style {
            case .tinted:
                RoundedRectangle(cornerRadius: size / 4).fill(color.opacity(0.18))
            case .filled:
                RoundedRectangle(cornerRadius: size * 0.28).fill(color)
            case .plain:
                EmptyView()
            }
            if let kind {
                AIProviderMark(kind)
                    .fill(style == .filled ? Color.black.opacity(0.8) : color, style: FillStyle(eoFill: true))
                    .padding(inset)
            } else {
                Text(verbatim: letter)
                    .font(.system(size: size * 0.6, weight: .bold, design: .rounded))
                    .foregroundStyle(style == .filled ? Color.black.opacity(0.8) : color)
            }
        }
        .frame(width: size, height: size)
    }
}
