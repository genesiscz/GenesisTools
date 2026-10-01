import SwiftUI

/// A short status line that fades after six seconds: icon, message, optional dim detail. An error
/// stays until it is dismissed.
public struct NoticePill: View {
    let text: String
    var detail: String?
    var isError: Bool
    let dismiss: () -> Void

    public init(text: String, detail: String? = nil, isError: Bool = false, dismiss: @escaping () -> Void) {
        self.text = text
        self.detail = detail
        self.isError = isError
        self.dismiss = dismiss
    }

    public var body: some View {
        HStack(spacing: 8) {
            Image(systemName: isError ? "exclamationmark.triangle.fill" : "checkmark.circle.fill")
                .foregroundColor(isError ? KitPalette.removed : KitPalette.added)
            Text(text).font(.system(size: 12, weight: .medium)).lineLimit(1)
            if let detail {
                Text(detail).font(.system(size: 11.5)).foregroundColor(KitPalette.dim).lineLimit(1).truncationMode(.middle)
            }
            IconButton(systemName: "xmark", tooltip: "Dismiss", size: 9, action: dismiss)
        }
        .padding(.leading, 10)
        .padding(.trailing, 4)
        .padding(.vertical, 3)
        .background(Capsule().fill(Color.white.opacity(0.06)))
        .overlay(Capsule().stroke(Color.white.opacity(0.1)))
        .task(id: text) {
            try? await Task.sleep(nanoseconds: 6_000_000_000)
            if !isError { dismiss() }
        }
    }
}
