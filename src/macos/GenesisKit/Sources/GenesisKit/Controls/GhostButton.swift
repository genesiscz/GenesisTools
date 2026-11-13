import SwiftUI

/// A text action with an icon in a hairline outline and no fill: "Open in last pane", "Choose a
/// pane…", "Show context". `fullWidth` stretches it across its column (one action per row in a
/// narrow sidebar, where side by side they squeezed each other's titles). The outline, the corners and the glyph's
/// colour come from the window's `KitLook`; a `hue` colours the glyph in a look that shows hues.
public struct GhostButton: View {
    let title: String
    let symbol: String
    let tooltip: String
    var trailingSymbol: String?
    var fullWidth: Bool
    var height: CGFloat
    var hue: KitHue
    var identifier: String?
    let action: () -> Void
    @Environment(\.kitLook) private var look

    public init(
        _ title: String,
        symbol: String,
        tooltip: String,
        trailingSymbol: String? = nil,
        fullWidth: Bool = false,
        height: CGFloat = 26,
        hue: KitHue = .neutral,
        identifier: String? = nil,
        action: @escaping () -> Void
    ) {
        self.title = title
        self.symbol = symbol
        self.tooltip = tooltip
        self.trailingSymbol = trailingSymbol
        self.fullWidth = fullWidth
        self.height = height
        self.hue = hue
        self.identifier = identifier
        self.action = action
    }

    public var body: some View {
        // The hover and pressed fills are the row button's, in every look.
        let surface = look.surface(.ghost, hue: hue)
        let radius = look.radius(.ghost, height: height, legacy: 7)
        return HStack(spacing: fullWidth ? 8 : 5) {
            Image(systemName: symbol)
                .font(.system(size: fullWidth ? 11 : 10.5))
                .foregroundColor(surface.glyph)
                .frame(width: fullWidth ? 16 : nil)
            Text(verbatim: title)
                .font(.system(size: fullWidth ? 12 : 11.5, weight: .medium))
                .foregroundColor(surface.label)
                .lineLimit(1)
            if fullWidth {
                Spacer(minLength: 4)
            }
            if let trailingSymbol {
                Image(systemName: trailingSymbol)
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundColor(KitPalette.dim)
            }
        }
        .padding(.horizontal, fullWidth ? 10 : 9)
        .frame(height: height)
        .frame(maxWidth: fullWidth ? .infinity : nil, alignment: .leading)
        .overlay {
            if let stroke = surface.stroke {
                RoundedRectangle(cornerRadius: radius, style: look.corners).strokeBorder(stroke, lineWidth: surface.strokeWidth)
            }
        }
        .rowButton(cornerRadius: radius, action)
        .instantTooltip(tooltip)
        .accessibilityLabel(Text(title))
        .accessibilityIdentifier(identifier ?? "")
    }
}
