import SwiftUI

/// What a list or pane shows when it has nothing: an icon, one sentence, its next step as an action, and at most one
/// other way on beside it. Centred in the space it is given.
public struct EmptyState: View {
    let symbol: String?
    let text: String
    var detail: String?
    var actionTitle: String?
    var action: (() -> Void)?
    var secondaryTitle: String?
    var secondarySymbol: String
    var secondaryAction: (() -> Void)?

    public init(symbol: String? = nil, text: String, detail: String? = nil, actionTitle: String? = nil, action: (() -> Void)? = nil,
                secondaryTitle: String? = nil, secondarySymbol: String = "arrow.right", secondaryAction: (() -> Void)? = nil) {
        self.symbol = symbol
        self.text = text
        self.detail = detail
        self.actionTitle = actionTitle
        self.action = action
        self.secondaryTitle = secondaryTitle
        self.secondarySymbol = secondarySymbol
        self.secondaryAction = secondaryAction
    }

    public var body: some View {
        VStack(spacing: 8) {
            if let symbol {
                Image(systemName: symbol)
                    .font(.system(size: 24))
                    .foregroundColor(KitPalette.faint)
            }
            Text(verbatim: text)
                .font(.system(size: 12.5, weight: .medium))
                .foregroundColor(KitPalette.dim)
                .multilineTextAlignment(.center)
            if let detail {
                Text(verbatim: detail)
                    .font(.system(size: 11.5))
                    .foregroundColor(KitPalette.faint)
                    .multilineTextAlignment(.center)
            }
            HStack(spacing: 8) {
                if let actionTitle, let action {
                    GhostButton(actionTitle, symbol: "arrow.right", tooltip: actionTitle, action: action)
                }
                if let secondaryTitle, let secondaryAction {
                    GhostButton(secondaryTitle, symbol: secondarySymbol, tooltip: secondaryTitle, action: secondaryAction)
                }
            }
            .padding(.top, 2)
        }
        .padding(16)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
