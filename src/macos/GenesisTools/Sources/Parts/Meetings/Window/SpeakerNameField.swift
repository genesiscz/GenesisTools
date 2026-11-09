import SwiftUI

/// The rename field of a speaker row: the label's name for this meeting, committed on Return and when the field loses
/// focus; Esc puts the saved name back. b-swift-settings-contacts opens the person picker from here (F10).
struct SpeakerNameField: View {
    let label: String
    /// The saved rename; nil: the label's own name.
    let rename: String?
    let commit: (String) -> Void
    @State private var name = ""
    @FocusState private var focused: Bool

    var body: some View {
        TextField("Rename", text: $name, prompt: Text(rename ?? "Rename for this meeting"))
            .textFieldStyle(.roundedBorder)
            .focused($focused)
            .onSubmit { commit(name) }
            .onExitCommand { name = rename ?? ""; focused = false }
            // A name typed and left saves too; it looked saved and was lost (Esc puts the saved name back first).
            .onChange(of: focused) { _, now in if !now { commit(name) } }
            .accessibilityLabel("Rename \(label)")
            .onAppear { name = rename ?? "" }
            .onChange(of: rename) { _, value in if !focused { name = value ?? "" } }
    }
}
