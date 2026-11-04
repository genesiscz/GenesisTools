import SwiftUI

/// A text field that grows with its text up to `maxLines`, then scrolls its own text, with or without the keyboard.
///
/// SwiftUI's `TextField(axis: .vertical)` stops at its line limit, and without the keyboard a wheel over it scrolls the
/// view around it, so a long decision answer showed its first four lines and nothing past them (Martin, 2026-11-04:
/// "it shown the long text but only part of it - i couldnt just move past certain treshold"). This is a `TextEditor`
/// (an NSTextView in its own scroll view) sized by a hidden copy of its text. At 12 pt both draw 15 pt lines, and the
/// text view has no inset and a 5 pt line padding, so the editor reaches 5 pt past each side: its text starts where a
/// TextField's did and wraps at the copy's width.
///
/// Return and Escape go to `onKey` first; a key it ignores reaches the text view, so Option-Return is a new line.
public struct GrowingTextEditor: View {
    private let placeholder: String
    @Binding private var text: String
    private let focus: FocusState<Bool>.Binding?
    private let font: Font
    private let maxLines: Int
    private let accessibilityText: String
    private let onKey: (KeyPress) -> KeyPress.Result

    public init(_ placeholder: String, text: Binding<String>, focus: FocusState<Bool>.Binding? = nil,
                font: Font = .system(size: 12), maxLines: Int = 4, accessibilityLabel: String? = nil,
                onKey: @escaping (KeyPress) -> KeyPress.Result = { _ in .ignored }) {
        self.placeholder = placeholder
        _text = text
        self.focus = focus
        self.font = font
        self.maxLines = maxLines
        accessibilityText = accessibilityLabel ?? placeholder
        self.onKey = onKey
    }

    public var body: some View {
        Text(verbatim: Self.sizingText(text))
            .font(font)
            .lineLimit(1...max(1, maxLines))
            .frame(maxWidth: .infinity, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
            .hidden()
            .accessibilityHidden(true)
            .overlay {
                TextEditor(text: $text)
                    .font(font)
                    .scrollContentBackground(.hidden)
                    .modifier(GrowingTextEditorFocus(focus: focus))
                    .onKeyPress(keys: [.return, .escape], phases: .down, action: onKey)
                    .accessibilityLabel(accessibilityText)
                    .padding(.horizontal, -Self.linePadding)
            }
            .overlay(alignment: .topLeading) {
                if text.isEmpty {
                    Text(verbatim: placeholder)
                        .font(font)
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                }
            }
    }

    /// The text view's line fragment padding, measured on macOS 27 at 12 pt.
    static let linePadding: CGFloat = 5

    /// The text the box is measured by: an empty field is one line, and a trailing new line is a line of its own.
    nonisolated static func sizingText(_ text: String) -> String {
        if text.isEmpty { return " " }
        return text.hasSuffix("\n") ? text + " " : text
    }

    /// The usual Return of an answer field: Return without Option or Shift calls `action` with whether ⌘ was held and
    /// is handled; Option-Return and Shift-Return stay a new line, and every other key passes on.
    public static func returnKey(_ press: KeyPress, _ action: (_ command: Bool) -> Void) -> KeyPress.Result {
        guard press.key == .return, !press.modifiers.contains(.option), !press.modifiers.contains(.shift) else {
            return .ignored
        }
        action(press.modifiers.contains(.command))
        return .handled
    }
}

/// Binds the editor's keyboard focus when the caller tracks it; a field nobody focuses from code takes none.
private struct GrowingTextEditorFocus: ViewModifier {
    let focus: FocusState<Bool>.Binding?

    func body(content: Content) -> some View {
        if let focus { content.focused(focus) } else { content }
    }
}
