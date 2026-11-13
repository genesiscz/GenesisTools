import AppKit
import SwiftUI

struct ListVariantInboxEntry {
    let session: InboxSession
    let item: InboxItem
}

struct ListVariantInboxKeys: ViewModifier {
    let inbox: HubInboxModel
    let entries: [ListVariantInboxEntry]
    let selected: String?
    let focused: FocusState<Bool>.Binding
    let select: (ListVariantInboxEntry) -> Void

    func body(content: Content) -> some View {
        content
            .focusable()
            .focusEffectDisabled()
            .focused(focused)
            .simultaneousGesture(TapGesture().onEnded {
                DispatchQueue.main.async {
                    if !(NSApp.keyWindow?.firstResponder is NSTextView) { focused.wrappedValue = true }
                }
            }, including: .all)
            .onKeyPress(phases: .down) { press in
                guard !(NSApp.keyWindow?.firstResponder is NSTextView),
                      !press.modifiers.contains(.command), !press.modifiers.contains(.control),
                      !entries.isEmpty else { return .ignored }
                let index = entries.firstIndex { $0.item.id == selected } ?? 0
                if press.key == .upArrow || press.key == .downArrow || press.characters == "j" || press.characters == "k" {
                    let step = press.key == .upArrow || press.characters == "k" ? -1 : 1
                    select(entries[min(max(index + step, 0), entries.count - 1)])
                    return .handled
                }
                let entry = entries[index]
                guard entry.item.isOpen else { return .ignored }
                if press.key == .return {
                    inbox.focusNote(entry.item.id)
                    return .handled
                }
                guard let digit = InboxMain.digit(press), let choices = entry.item.choices, digit <= choices.count else { return .ignored }
                if let id = entry.session.sessionId, inbox.sendingSessions.contains(id) { return .handled }
                inbox.choose(entry.item, in: entry.session, letter: choices[digit - 1].id,
                             note: inbox.noteTexts[entry.item.id], shift: press.modifiers.contains(.shift),
                             command: press.modifiers.contains(.option))
                return .handled
            }
    }
}
