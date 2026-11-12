import SwiftUI

/// Edits only the question text. The answer draft and the question's status stay separate.
struct QuestionWordingEditor: View {
    let row: ReviewRow
    let detail: MeetingDetailModel
    @FocusState private var focused: Bool

    private var draft: Binding<String> {
        Binding(get: { detail.questionDrafts[row.id]?.text ?? "" }, set: { detail.questionDrafts[row.id]?.text = $0 })
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            TextField("Question wording", text: draft, axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .lineLimit(2...6)
                .focused($focused)
                .accessibilityLabel("Question wording for \(row.label)")
                .accessibilityIdentifier("meetings.question.wording")
                .onSubmit { detail.submitQuestionWording(on: row) }
                .onExitCommand { detail.closeEditor() }
            if let original = detail.questionDrafts[row.id]?.original, original != ReviewRowView.asked(row) {
                HStack {
                    Text("This question changed while you were editing").font(.caption).foregroundStyle(.secondary)
                    GhostButton("Use current wording", symbol: "arrow.clockwise", tooltip: "Replace this draft with the current question") {
                        detail.resetQuestionWording(on: row)
                    }
                }
            }
            HStack {
                GhostButton("Save wording", symbol: "checkmark", tooltip: "Save the question text; keep its answer and status") {
                    detail.submitQuestionWording(on: row)
                }
                .disabled(MeetingsWords.typedAnswer(draft.wrappedValue) == nil)
                GhostButton("Cancel", symbol: "xmark", tooltip: "Close the editor and keep this draft") { detail.closeEditor() }
                Text("The answer stays as it is").font(.caption).foregroundStyle(.secondary)
            }
        }
        .onAppear { focused = true }
    }
}
