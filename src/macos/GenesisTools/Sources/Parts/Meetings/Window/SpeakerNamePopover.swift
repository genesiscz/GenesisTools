import SwiftUI

/// The voice of a speaker range that no candidate names: a typed name confirms the range as that voice. The name stays
/// in the row until the confirm lands (the range then leaves the suggestions), so a refused name is not lost.
struct SpeakerNamePopover: View {
    @Binding var name: String
    let confirm: (String) -> Void
    @FocusState private var focused: Bool

    var body: some View {
        HStack(spacing: 6) {
            TextField("Speaker name", text: $name)
                .textFieldStyle(.roundedBorder).frame(width: 200)
                .focused($focused)
                .onSubmit(submit)
            GhostButton("Confirm", symbol: "return", tooltip: "Confirm this range as the typed voice") { submit() }
                .disabled(trimmed.isEmpty)
        }
        .padding(10)
        .onAppear { focused = true }
    }

    private var trimmed: String { name.trimmingCharacters(in: .whitespaces) }

    private func submit() {
        guard !trimmed.isEmpty else { return }
        confirm(trimmed)
    }
}
