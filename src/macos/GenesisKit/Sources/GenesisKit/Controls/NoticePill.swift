import SwiftUI

/// A short status line that fades after six seconds: icon, message, optional dim detail. An error
/// stays until it is dismissed.
public struct NoticePill: View {
    let text: String
    var detail: String?
    /// The full message behind a short `text` (a CLI's raw error), shown only after a click on "Details".
    var more: String?
    var isError: Bool
    let dismiss: () -> Void
    @State private var showsMore = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(text: String, detail: String? = nil, more: String? = nil, isError: Bool = false,
                dismiss: @escaping () -> Void) {
        self.text = text
        self.detail = detail
        self.more = more
        self.isError = isError
        self.dismiss = dismiss
    }

    // The message wraps instead of ending in "…": an error cut to one line could not be read
    // ("Reservine/ReservineBack#815 is not a…", 2026-10-04). One line keeps the capsule; more lines
    // get a rounded box of the same look, and the text can be selected and copied.
    public var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: isError ? "exclamationmark.triangle.fill" : "checkmark.circle.fill")
                .foregroundColor(isError ? KitPalette.removed : KitPalette.added)
            VStack(alignment: .leading, spacing: 2) {
                Text(text).font(.system(size: 12, weight: .medium))
                    .fixedSize(horizontal: false, vertical: true)
                if let detail {
                    Text(detail).font(.system(size: 11.5)).foregroundColor(KitPalette.dim)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let more {
                    Button {
                        GenMotion.perform(expanding: !showsMore, reduceMotion: reduceMotion) { showsMore.toggle() }
                    } label: {
                        Label(showsMore ? "Hide details" : "Details",
                              systemImage: showsMore ? "chevron.down" : "chevron.right")
                            .font(.system(size: 11))
                            .foregroundColor(KitPalette.dim)
                    }
                    .buttonStyle(.genHoverPlain())
                    .instantTooltip(showsMore ? "Hide the full message" : "Show the full message")
                    .accessibilityValue(showsMore ? "Expanded" : "Collapsed")
                    if showsMore {
                        Text(more).font(.system(size: 11, design: .monospaced)).foregroundColor(KitPalette.dim)
                            .fixedSize(horizontal: false, vertical: true)
                            .transition(.genReveal)
                    }
                }
            }
            .textSelection(.enabled)
            .multilineTextAlignment(.leading)
            IconButton(systemName: "xmark", tooltip: "Dismiss", size: 9, action: dismiss)
        }
        .padding(.leading, 10)
        .padding(.trailing, 4)
        .padding(.vertical, 3)
        .background(RoundedRectangle(cornerRadius: 11, style: .continuous).fill(Color.white.opacity(0.06)))
        .overlay(RoundedRectangle(cornerRadius: 11, style: .continuous).stroke(Color.white.opacity(0.1)))
        .task(id: text) {
            try? await Task.sleep(nanoseconds: 6_000_000_000)
            if !isError { dismiss() }
        }
    }
}
