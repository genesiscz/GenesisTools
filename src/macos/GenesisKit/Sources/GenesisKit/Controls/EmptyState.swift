import SwiftUI

/// What a list or pane shows when it has nothing: an icon, one sentence, and at most one action.
/// Centred in the space it is given.
public struct EmptyState: View {
    let symbol: String?
    let text: String
    var detail: String?
    var actionTitle: String?
    var action: (() -> Void)?

    public init(symbol: String? = nil, text: String, detail: String? = nil, actionTitle: String? = nil, action: (() -> Void)? = nil) {
        self.symbol = symbol
        self.text = text
        self.detail = detail
        self.actionTitle = actionTitle
        self.action = action
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
            if let actionTitle, let action {
                GhostButton(actionTitle, symbol: "arrow.right", tooltip: actionTitle, action: action)
                    .padding(.top, 2)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
