import SwiftUI

/// A short monospaced value (a session id's first 8 characters) that copies the full value on
/// click. The copy toast confirms it; the chip only turns its icon into a check, in a fixed slot,
/// so the text beside it never moves.
public struct CopyChip: View {
    let label: String
    let value: String
    let tooltip: String
    var what: String?
    @State private var copied = false

    /// `what` names the value in the toast ("Copied session id").
    public init(label: String, value: String, tooltip: String, what: String? = nil) {
        self.label = label
        self.value = value
        self.tooltip = tooltip
        self.what = what
    }

    public var body: some View {
        Button {
            Clipboard.copy(value, what: what)
            withAnimation(.easeOut(duration: 0.15)) { copied = true }
        } label: {
            HStack(spacing: 4) {
                Image(systemName: copied ? "checkmark" : "number")
                    .font(.system(size: 9.5, weight: .semibold))
                    .foregroundColor(copied ? KitPalette.added : KitPalette.dim)
                    .frame(width: 11)
                Text(verbatim: label)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundColor(copied ? KitPalette.added : Color.white.opacity(0.8))
            }
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(RoundedRectangle(cornerRadius: 5).fill(Color.white.opacity(0.06)))
            .contentShape(Rectangle())
        }
        .buttonStyle(.genHoverPlain())
        .instantTooltip(tooltip)
        .accessibilityLabel(Text(tooltip))
        .task(id: copied) {
            guard copied else { return }
            try? await Task.sleep(for: .milliseconds(1400))
            withAnimation(.easeOut(duration: 0.2)) { copied = false }
        }
    }
}
