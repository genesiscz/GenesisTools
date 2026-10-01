import SwiftUI

/// A tinted line under a header or above a form field: an icon and one message, the whole strip a
/// button when there is something to do about it, and an ✕ when it can be dismissed. For a warning,
/// an error or a note that stays until it no longer applies; a passing confirmation is a
/// `NoticePill` instead.
public struct InfoStrip: View {
    public enum Tone {
        case info, warning, error, success

        var color: Color {
            switch self {
            case .info: return KitPalette.renamed
            case .warning: return KitPalette.modified
            case .error: return KitPalette.removed
            case .success: return KitPalette.added
            }
        }

        var symbol: String {
            switch self {
            case .info: return "info.circle.fill"
            case .warning: return "exclamationmark.triangle.fill"
            case .error: return "xmark.octagon.fill"
            case .success: return "checkmark.circle.fill"
            }
        }
    }

    let text: String
    var tone: Tone
    var symbol: String?
    var action: (() -> Void)?
    var actionTooltip: String?
    var dismiss: (() -> Void)?

    public init(_ text: String, tone: Tone = .info, symbol: String? = nil, action: (() -> Void)? = nil, actionTooltip: String? = nil, dismiss: (() -> Void)? = nil) {
        self.text = text
        self.tone = tone
        self.symbol = symbol
        self.action = action
        self.actionTooltip = actionTooltip
        self.dismiss = dismiss
    }

    public var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 7) {
            content
            if let dismiss {
                IconButton(systemName: "xmark", tooltip: "Dismiss", size: 9, action: dismiss)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(RoundedRectangle(cornerRadius: 7, style: .continuous).fill(tone.color.opacity(0.10)))
        .overlay(RoundedRectangle(cornerRadius: 7, style: .continuous).strokeBorder(tone.color.opacity(0.25)))
    }

    @ViewBuilder
    private var content: some View {
        let line = HStack(alignment: .firstTextBaseline, spacing: 7) {
            Image(systemName: symbol ?? tone.symbol)
                .font(.system(size: 11))
                .foregroundColor(tone.color)
            Text(verbatim: text)
                .font(.system(size: 11.5))
                .foregroundColor(Color.white.opacity(0.85))
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        if let action {
            Button(action: action) { line.contentShape(Rectangle()) }
                .buttonStyle(.genHoverPlain())
                .instantTooltip(actionTooltip ?? text)
        } else {
            line
        }
    }
}
