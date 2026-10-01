import SwiftUI

/// A short label in a capsule: a tag ("merged", a project name), a status ("stuck", "OPEN"), or a
/// count beside a sidebar entry. One shape for all three, so badges look alike across both apps.
public struct Badge: View {
    public enum Look {
        /// Neutral: dim text on a faint white capsule, no outline (project chips, reasons).
        case tag
        /// Status: coloured text on a tint of the colour, with a thin outline of it.
        case tone
        /// Status without the outline (inbox kinds).
        case filled
    }

    let text: String
    var color: Color
    var look: Look
    var symbol: String?
    var monospaced: Bool
    var tooltip: String?
    var findField: String?

    /// `findField`: the key a panel find lists the text under (GenesisTools' ⌘F in a panel).
    public init(_ text: String, color: Color = KitPalette.dim, look: Look = .tag, symbol: String? = nil, monospaced: Bool = false, tooltip: String? = nil, findField: String? = nil) {
        self.text = text
        self.color = color
        self.look = look
        self.symbol = symbol
        self.monospaced = monospaced
        self.tooltip = tooltip
        self.findField = findField
    }

    public var body: some View {
        let label = HStack(spacing: 3) {
            if let symbol {
                Image(systemName: symbol).font(.system(size: 8.5, weight: .semibold))
            }
            Group {
                if let findField {
                    KitFindText(text: text, field: findField)
                } else {
                    Text(verbatim: text)
                }
            }
                .font(.system(size: look == .tag ? 10.5 : 10, weight: look == .tag ? .medium : .semibold, design: monospaced ? .monospaced : .default))
                .lineLimit(1)
        }
        .foregroundColor(color)
        .padding(.horizontal, 6)
        .padding(.vertical, 1)
        .background(Capsule().fill(look == .tag ? Color.white.opacity(0.06) : color.opacity(0.16)))
        .overlay(Capsule().stroke(look == .tone ? color.opacity(0.5) : .clear, lineWidth: 0.5))
        .fixedSize()
        if let tooltip {
            label.instantTooltip(tooltip).accessibilityLabel(Text(verbatim: "\(text): \(tooltip)"))
        } else {
            label
        }
    }
}

/// A number beside a sidebar entry (sessions in a worktree, removable worktrees, orphans).
public struct CountBadge: View {
    let count: Int
    var tooltip: String
    var color: Color

    public init(_ count: Int, tooltip: String, color: Color = .primary) {
        self.count = count
        self.tooltip = tooltip
        self.color = color
    }

    public var body: some View {
        Text(verbatim: "\(count)")
            .font(.system(size: 10.5, weight: .semibold, design: .monospaced))
            .foregroundColor(color)
            .padding(.horizontal, 6)
            .padding(.vertical, 1)
            .background(Capsule().fill(Color.white.opacity(0.08)))
            .instantTooltip(tooltip)
            .accessibilityLabel(Text(verbatim: "\(count), \(tooltip)"))
    }
}
