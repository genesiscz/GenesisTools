import SwiftUI

/// What a list or pane shows when it has nothing: an icon, one sentence, its next step as an action, and at most one
/// other way on beside it. Centred in the space it is given.
public struct EmptyState: View {
    /// The other way on beside the main action: its title, glyph and what it does. A value, not a closure parameter, so
    /// a trailing closure can only be the main action. With a second closure parameter after `action`, Swift 5 mode
    /// bound `EmptyState(…, actionTitle: "Suggest items") { … }` to the LAST closure (backward matching of an unlabeled
    /// trailing closure), and every such empty state drew no button at all (w_xow4oigk, 2026-11-18).
    public struct Secondary {
        let title: String
        let symbol: String
        let perform: () -> Void

        public init(_ title: String, symbol: String = "arrow.right", perform: @escaping () -> Void) {
            self.title = title
            self.symbol = symbol
            self.perform = perform
        }
    }

    let symbol: String?
    let text: String
    var detail: String?
    var actionTitle: String?
    var action: (() -> Void)?
    var secondary: Secondary?

    public init(symbol: String? = nil, text: String, detail: String? = nil, actionTitle: String? = nil, action: (() -> Void)? = nil,
                secondary: Secondary? = nil) {
        self.symbol = symbol
        self.text = text
        self.detail = detail
        self.actionTitle = actionTitle
        self.action = action
        self.secondary = secondary
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
                if let secondary {
                    GhostButton(secondary.title, symbol: secondary.symbol, tooltip: secondary.title, action: secondary.perform)
                }
            }
            .padding(.top, 2)
        }
        .padding(16)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
