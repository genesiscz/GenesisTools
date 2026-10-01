import SwiftUI

/// A text action with an icon in a hairline outline and no fill: "Open in last pane", "Choose a
/// pane…", "Show context". `fullWidth` stretches it across its column (one action per row in a
/// narrow sidebar, where side by side they squeezed each other's titles).
public struct GhostButton: View {
    let title: String
    let symbol: String
    let tooltip: String
    var trailingSymbol: String?
    var fullWidth: Bool
    var height: CGFloat
    var identifier: String?
    let action: () -> Void

    public init(
        _ title: String,
        symbol: String,
        tooltip: String,
        trailingSymbol: String? = nil,
        fullWidth: Bool = false,
        height: CGFloat = 26,
        identifier: String? = nil,
        action: @escaping () -> Void
    ) {
        self.title = title
        self.symbol = symbol
        self.tooltip = tooltip
        self.trailingSymbol = trailingSymbol
        self.fullWidth = fullWidth
        self.height = height
        self.identifier = identifier
        self.action = action
    }

    public var body: some View {
        HStack(spacing: fullWidth ? 8 : 5) {
            Image(systemName: symbol)
                .font(.system(size: fullWidth ? 11 : 10.5))
                .foregroundColor(KitPalette.dim)
                .frame(width: fullWidth ? 16 : nil)
            Text(verbatim: title)
                .font(.system(size: fullWidth ? 12 : 11.5, weight: .medium))
                .foregroundColor(Color.white.opacity(0.88))
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
        .overlay(RoundedRectangle(cornerRadius: 7, style: .continuous).strokeBorder(Color.white.opacity(0.11)))
        .rowButton(cornerRadius: 7, action)
        .instantTooltip(tooltip)
        .accessibilityLabel(Text(title))
        .accessibilityIdentifier(identifier ?? "")
    }
}
