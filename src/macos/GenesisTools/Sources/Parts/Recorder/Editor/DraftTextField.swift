import SwiftUI

/// What a words field shows while it is typed in. The service stores the words trimmed and the window draws its answer,
/// so a field bound to the stored words lost a typed trailing space or newline between two keystrokes ("Hello " came
/// back as "Hello", and " world" then read "Helloworld"). The draft shows while it is the stored words up to the
/// trim; any other stored words (an undo, an agent, another selection, a refused value) show as stored.
enum FieldDraft {
    static func shown(draft: String?, stored: String) -> String {
        guard let draft, matches(draft, stored) else { return stored }
        return draft
    }

    static func matches(_ draft: String, _ stored: String) -> Bool {
        draft == stored
            || draft.trimmingCharacters(in: .whitespacesAndNewlines) == stored.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

/// A words field that keeps what is typed (FieldDraft) and sends every keystroke to `set`. A value past `words`' limit
/// is refused aloud through `refuse` and never sent, so the field keeps what it had.
struct DraftTextField: View {
    let title: String
    let stored: String
    var words: EditLimits.Words?
    var axis: Axis = .horizontal
    let refuse: (String) -> Void
    let set: (String) -> Void
    @State private var draft: String?

    var body: some View {
        TextField(title, text: Binding(get: { FieldDraft.shown(draft: draft, stored: stored) }, set: { typed in
            if let refusal = words?.refusal(typed) {
                refuse(refusal)
                return
            }
            draft = typed
            set(typed)
        }), axis: axis)
        .onChange(of: stored) { _, now in
            if let draft, !FieldDraft.matches(draft, now) { self.draft = nil }
        }
    }
}
