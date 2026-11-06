import AppKit
import SwiftUI

/// A one-line text field with a rounded border whose text an accessibility client can set (`tools control set`,
/// an agent, a VoiceOver value write). SwiftUI's `TextField` takes such a write into its field but never into its
/// binding, so a button that reads the binding stays disabled. Return runs `onSubmit`. The accessibility label is
/// `label`, or the placeholder; `identifier` lands on the AppKit field itself, where an agent looks for it.
public struct AgentTextField: NSViewRepresentable {
    @Binding private var text: String
    private let placeholder: String
    private let label: String
    private let identifier: String?
    private let onSubmit: () -> Void

    public init(_ placeholder: String, text: Binding<String>, label: String? = nil, identifier: String? = nil,
                onSubmit: @escaping () -> Void = {}) {
        _text = text
        self.placeholder = placeholder
        self.label = label ?? placeholder
        self.identifier = identifier
        self.onSubmit = onSubmit
    }

    public func makeCoordinator() -> Coordinator { Coordinator(self) }

    public func makeNSView(context: Context) -> Field {
        let field = Field(string: text)
        field.placeholderString = placeholder
        field.setAccessibilityLabel(label)
        if let identifier { field.setAccessibilityIdentifier(identifier) }
        field.bezelStyle = .roundedBezel
        field.isBezeled = true
        field.usesSingleLineMode = true
        field.lineBreakMode = .byTruncatingTail
        field.cell?.isScrollable = true
        // The column sets the width; a long placeholder or text never widens the field past it.
        field.setContentHuggingPriority(.defaultLow, for: .horizontal)
        field.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        field.delegate = context.coordinator
        let coordinator = context.coordinator
        field.onAccessibilityWrite = { [weak coordinator] value in coordinator?.parent.text = value }
        return field
    }

    public func updateNSView(_ field: Field, context: Context) {
        context.coordinator.parent = self
        if field.stringValue != text { field.stringValue = text }
        if field.placeholderString != placeholder { field.placeholderString = placeholder }
        if field.accessibilityLabel() != label { field.setAccessibilityLabel(label) }
    }

    public final class Field: NSTextField {
        var onAccessibilityWrite: (String) -> Void = { _ in }

        override public func setAccessibilityValue(_ value: Any?) {
            super.setAccessibilityValue(value)
            let written = value as? String ?? stringValue
            if stringValue != written { stringValue = written }
            onAccessibilityWrite(written)
        }
    }

    public final class Coordinator: NSObject, NSTextFieldDelegate {
        var parent: AgentTextField

        init(_ parent: AgentTextField) {
            self.parent = parent
        }

        public func controlTextDidChange(_ notification: Notification) {
            guard let field = notification.object as? NSTextField else { return }
            parent.text = field.stringValue
        }

        public func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
            guard selector == #selector(NSResponder.insertNewline(_:)) else { return false }
            parent.onSubmit()
            return true
        }
    }
}
