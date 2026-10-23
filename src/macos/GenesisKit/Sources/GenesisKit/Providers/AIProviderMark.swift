import SwiftUI

/// A coding agent's logo as a shape: Claude's starburst, Codex's terminal cloud, Grok's slashed ring. Every surface
/// that names an agent by its mark draws it through this (`AIProviderGlyph`, `ProviderBadge`), so a change lands
/// everywhere at once. Paths from LobeHub's icon set (MIT, `@lobehub/icons-static-svg`), 24 × 24, even-odd fill.
public struct AIProviderMark: Shape {
    public let kind: Kind

    public enum Kind: String, CaseIterable, Sendable {
        case claude, codex, grok

        /// The mark for a provider id or alias (`claude`, `anthropic-sub`, `codex`, `openai-sub`, `grok`, `grok-sub`);
        /// nil for one with no mark, which keeps its letter.
        public init?(provider: String) {
            switch provider.lowercased() {
            case "claude", "anthropic", "anthropic-sub": self = .claude
            case "codex", "openai", "openai-sub": self = .codex
            case "grok", "xai", "grok-sub": self = .grok
            default: return nil
            }
        }

        /// The brand colour of the mark itself (Claude's terracotta; Codex and Grok are drawn in white).
        public var brandColor: Color {
            switch self {
            case .claude: return Color(red: 0.851, green: 0.467, blue: 0.341)
            case .codex, .grok: return Color.white.opacity(0.92)
            }
        }
    }

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

    /// Parsed once: these paths are drawn in every session row.
    static let paths: [Kind: Path] = [
        .claude: SVGPath.parse(
            "M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z"),
        .codex: SVGPath.parse(
            "M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z"),
        .grok: SVGPath.parse(
            "M9.27 15.29l7.978-5.897c.391-.29.95-.177 1.137.272.98 2.369.542 5.215-1.41 7.169-1.951 1.954-4.667 2.382-7.149 1.406l-2.711 1.257c3.889 2.661 8.611 2.003 11.562-.953 2.341-2.344 3.066-5.539 2.388-8.42l.006.007c-.983-4.232.242-5.924 2.75-9.383.06-.082.12-.164.179-.248l-3.301 3.305v-.01L9.267 15.292M7.623 16.723c-2.792-2.67-2.31-6.801.071-9.184 1.761-1.763 4.647-2.483 7.166-1.425l2.705-1.25a7.808 7.808 0 00-1.829-1A8.975 8.975 0 005.984 5.83c-2.533 2.536-3.33 6.436-1.962 9.764 1.022 2.487-.653 4.246-2.34 6.022-.599.63-1.199 1.259-1.682 1.925l7.62-6.815"),
    ]
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
