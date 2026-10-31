import SwiftUI

/// How an answer field draws. `.full` is the reply composer and a decision card's own answer: a field of up to four
/// lines, its send button, and the rows its caller puts above and below. `.compact` is the alert popup's own answer
/// under the options: one smaller line in the same box, with the same placeholder and arrow, which a click opens as
/// the full field in the decision's session.
enum WidgetAnswerFieldStyle: Equatable {
    case full, compact

    var padding: EdgeInsets {
        self == .full ? EdgeInsets(top: 11, leading: 11, bottom: 11, trailing: 11)
            : EdgeInsets(top: 5, leading: 10, bottom: 5, trailing: 5)
    }

    var cornerRadius: CGFloat { self == .full ? 13 : WidgetOptionLabel.cornerRadius + 2 }
}

/// One answer box for the reply composer, a decision card's own answer and the alert popup's own answer: the rounded
/// box, its field (or a drawn stand-in), its placeholder and its send arrow. The three places differ only in props
/// (Martin, 2026-10-28: "make sure its the same component with just different props").
///
/// The whole box is the field's target: a click beside the one-line field, or in the padding under it, calls
/// `activate`. In the full style a button inside keeps its own click, because a child's gesture wins over the box's.
/// The compact style is one button, so the keyboard and VoiceOver reach it as well.
struct WidgetAnswerField<Above: View, Below: View>: View {
    var style: WidgetAnswerFieldStyle = .full
    /// The decision whose own answer this is; nil for the reply composer.
    var ownAnswerID: String?
    let placeholder: String
    /// What the drawn stand-in shows: the compact field always, the full one while the panel moves.
    var shownText = ""
    /// The editable text and its focus; without them the field is the drawn stand-in.
    var text: Binding<String>?
    var focus: FocusState<Bool>.Binding?
    var focused = false
    /// The reply box while a card's own answer holds the draft: a dim label that says where the typing went.
    var parkedLabel: String?
    /// The send button shows and acts; hidden, it still holds its place, so the field never moves or rewraps.
    var sendShown = true
    var sendDisabled = false
    var sendTooltip = ""
    /// While the panel's outline moves, the full field draws a stand-in (`\.edgePanelMoving`).
    var panelMoving = false
    var fieldHeight: Binding<CGFloat> = .constant(0)
    /// The session the field types into, for `onFocusChange`.
    var fieldKey = ""
    var onFocusChange: (_ focused: Bool, _ key: String) -> Void = { _, _ in }
    /// Return without Option or Shift in an own answer, with whether ⌘ was held. Nil leaves Return to `onSubmit`.
    var onReturn: ((_ command: Bool) -> Void)?
    var onSubmit: () -> Void = {}
    var onSend: () -> Void = {}
    /// A click in the box: the full field takes the keyboard, the compact one opens the full one.
    var activate: () -> Void = {}
    /// The compact field's tooltip, which says where a click goes.
    var activateTooltip = ""
    let above: Above
    let below: Below

    init(style: WidgetAnswerFieldStyle = .full, ownAnswerID: String? = nil, placeholder: String, shownText: String = "",
         text: Binding<String>? = nil, focus: FocusState<Bool>.Binding? = nil, focused: Bool = false,
         parkedLabel: String? = nil, sendShown: Bool = true, sendDisabled: Bool = false, sendTooltip: String = "",
         panelMoving: Bool = false, fieldHeight: Binding<CGFloat> = .constant(0), fieldKey: String = "",
         onFocusChange: @escaping (_ focused: Bool, _ key: String) -> Void = { _, _ in },
         onReturn: ((_ command: Bool) -> Void)? = nil, onSubmit: @escaping () -> Void = {},
         onSend: @escaping () -> Void = {}, activate: @escaping () -> Void = {}, activateTooltip: String = "",
         @ViewBuilder above: () -> Above, @ViewBuilder below: () -> Below)
    {
        self.style = style
        self.ownAnswerID = ownAnswerID
        self.placeholder = placeholder
        self.shownText = shownText
        self.text = text
        self.focus = focus
        self.focused = focused
        self.parkedLabel = parkedLabel
        self.sendShown = sendShown
        self.sendDisabled = sendDisabled
        self.sendTooltip = sendTooltip
        self.panelMoving = panelMoving
        self.fieldHeight = fieldHeight
        self.fieldKey = fieldKey
        self.onFocusChange = onFocusChange
        self.onReturn = onReturn
        self.onSubmit = onSubmit
        self.onSend = onSend
        self.activate = activate
        self.activateTooltip = activateTooltip
        self.above = above()
        self.below = below()
    }

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: style.cornerRadius)
        let box = VStack(alignment: .leading, spacing: 8) {
            above
            // An own answer centres its one-line field on the send button it holds a place for, so the closed field
            // does not sit low in its box; the reply composer keeps its send button at the foot of a long text.
            HStack(alignment: ownAnswerID == nil ? .bottom : .center, spacing: style == .full ? 8 : 6) {
                field
                sendButton
            }
            below
        }
        .padding(style.padding).background(.white.opacity(0.065), in: shape)
        .contentShape(shape)
        if style == .compact {
            Button(action: activate) { box }
                .buttonStyle(RowButtonStyle(cornerRadius: style.cornerRadius))
                .instantTooltip(activateTooltip)
                .accessibilityLabel(placeholder.trimmingCharacters(in: CharacterSet(charactersIn: "…")))
                .accessibilityValue(shownText)
                .accessibilityHint(activateTooltip)
                .accessibilityIdentifier("widget.peek.ownAnswer")
                .frameProbe("widget.peek.ownAnswer")
        } else {
            box.onTapGesture(perform: activate)
                .frameProbe(ownAnswerID == nil ? "widget.composer" : "widget.ownAnswer.box")
        }
    }

    @ViewBuilder private var field: some View {
        let height = fieldHeight.wrappedValue
        if let parkedLabel {
            // Dim, with the arrow that says where the typing went; a disabled field's placeholder read as text.
            Label(parkedLabel, systemImage: "arrow.turn.right.down").font(.system(size: 12)).lineLimit(1)
                .foregroundStyle(.tertiary)
                .frame(maxWidth: .infinity, minHeight: max(height, 16), alignment: .leading)
        } else if style == .compact {
            // One line that shows what the decision's own answer holds, or the placeholder; typing happens in the full
            // field the click opens.
            Text(shownText.isEmpty ? placeholder : shownText)
                .font(.system(size: 12)).lineLimit(1).truncationMode(.tail)
                .foregroundStyle(shownText.isEmpty ? .tertiary : .primary)
                .frame(maxWidth: .infinity, alignment: .leading)
        } else if let text, let focus, !(panelMoving && !focused && height > 0) {
            // One field in every state, so a click that opens the own answer keeps the keyboard in it.
            TextField(placeholder, text: text, axis: .vertical)
                .textFieldStyle(.plain).font(.system(size: 12)).lineLimit(1...4)
                // Always as tall as its lines (up to four): squeezed to the send button's height, a two-line
                // answer showed its first line cut off at the top (Martin, 2026-10-26: "multilines suck").
                .fixedSize(horizontal: false, vertical: true)
                .focused(focus)
                // A field with the keyboard owns its text: no snapshot writes into it (FieldTextOwnership).
                .onChange(of: focused, initial: true) { _, now in onFocusChange(now, fieldKey) }
                .onChange(of: fieldKey) { _, key in
                    if focused { onFocusChange(true, key) }
                }
                .onDisappear { onFocusChange(false, fieldKey) }
                // A decision's own answer: Return stages the text as its note and ⌘-Return sends it, or the
                // other way round (Settings: Return in an own answer). Option-Return stays a new line.
                .onKeyPress(.return, phases: .down) { press in
                    guard let onReturn, !press.modifiers.contains(.option),
                          !press.modifiers.contains(.shift) else { return .ignored }
                    onReturn(press.modifiers.contains(.command))
                    return .handled
                }
                .onSubmit(onSubmit)
                .accessibilityLabel(ownAnswerID == nil ? "Reply to selected agent" : "Your own answer")
                .onGeometryChange(for: CGFloat.self, of: { $0.size.height.rounded() }) { fieldHeight.wrappedValue = $0 }
                .frameProbe(ownAnswerID == nil ? "widget.composer.field" : "widget.ownAnswer.field")
        } else {
            // While the panel's outline moves the composer rides its bottom edge; a drawn stand-in moves for free,
            // the AppKit field would lay out and rebuild the key view loop on every frame.
            Text(shownText.isEmpty ? placeholder : shownText)
                .font(.system(size: 12)).lineLimit(1...4)
                .foregroundStyle(shownText.isEmpty ? .tertiary : .primary)
                .frame(maxWidth: .infinity, minHeight: height, maxHeight: height, alignment: .topLeading)
        }
    }

    @ViewBuilder private var sendButton: some View {
        if style == .compact {
            // The full field's arrow, smaller and dim: it says the box is an answer, and the whole box is the button.
            Image(systemName: "arrow.up.circle.fill").font(.system(size: 17)).foregroundStyle(.blue.opacity(0.55))
                .frame(width: 22, height: 22)
                .accessibilityHidden(true)
        } else {
            Button(action: onSend) {
                Image(systemName: "arrow.up.circle.fill").font(.system(size: 23)).foregroundStyle(.blue)
            }.buttonStyle(.genHoverIcon(accent: .blue, diameter: 28))
                .disabled(sendDisabled)
                .instantTooltip(sendTooltip)
                .accessibilityLabel(ownAnswerID == nil ? "Send reply" : "Send your answer")
                .frameProbe(ownAnswerID == nil ? "widget.composer.send" : "widget.ownAnswer.send")
                .opacity(sendShown ? 1 : 0).allowsHitTesting(sendShown).accessibilityHidden(!sendShown)
        }
    }
}

extension WidgetAnswerField where Above == EmptyView, Below == EmptyView {
    /// The alert popup's own answer: the compact box, showing what the decision's own answer holds.
    static func compact(placeholder: String, shownText: String, tooltip: String, activate: @escaping () -> Void)
        -> WidgetAnswerField
    {
        WidgetAnswerField(style: .compact, ownAnswerID: "", placeholder: placeholder, shownText: shownText,
                          activate: activate, activateTooltip: tooltip, above: { EmptyView() }, below: { EmptyView() })
    }
}
