import SwiftUI

/// Adds to the same decision journal as the CLI. The service supplies anchor errors and duplicate IDs.
struct FindingComposerButton: View {
    @Bindable var detail: MeetingDetailModel
    /// The Items bar in a narrow column: the glyph alone, with its words as tooltip and label.
    var compact = false
    @State private var showing = false
    // Keep the draft when the popover closes and opens again.
    @State private var draft = FindingComposerForm.Draft()

    var body: some View {
        Button { showing.toggle() } label: {
            ItemsBarLabel(title: "Add question or term…", symbol: "plus", compact: compact)
        }
            .buttonStyle(.genHoverPlain())
            .instantTooltip("Add a question to ask by ear, or a term to correct, at a time of this meeting")
            .accessibilityLabel("Add question or term")
            .accessibilityIdentifier("meetings.finding.add")
            .popover(isPresented: $showing) {
                FindingComposerForm(detail: detail, draft: draft) { showing = false }
            }
    }
}

struct FindingComposerForm: View {
    @Observable final class Draft {
        var kind = "question"
        var from = 0.0
        var to = 10.0
        var question = ""
        var choices = ""
        var heard = ""
        var proposed = ""
        var force = false
        var busy = false
        var message: String?
        var failure: MeetingsCLI.Failure?

        var addDisabled: Bool {
            if busy || from < 0 { return true }
            if kind == "question" { return to < from || question.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
            return heard.isEmpty || proposed.isEmpty
        }
    }

    let detail: MeetingDetailModel
    @Bindable var draft: Draft
    let onClose: () -> Void

    var body: some View {
        Form {
            Picker("Finding", selection: $draft.kind) {
                Text("Question").tag("question")
                Text("Term").tag("term")
            }
            TextField("From, seconds", value: $draft.from, format: .number)
            if draft.kind == "question" {
                TextField("To, seconds", value: $draft.to, format: .number)
                TextField("Question", text: $draft.question)
                TextField("Choices, separated by commas", text: $draft.choices)
                Text("Without decided findings, an answer is saved as a plain question.")
                    .font(.caption).foregroundStyle(.secondary)
            } else {
                TextField("Heard words", text: $draft.heard)
                TextField("Proposed spelling", text: $draft.proposed)
                Toggle("Force an invalid anchor", isOn: $draft.force)
                Text("An invalid anchor reports the nearest line containing the word. Correct the time before adding, or explicitly force it.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if let message = draft.message { Text(verbatim: message).font(.caption).textSelection(.enabled) }
            if let failure = draft.failure {
                NoticePill(text: failure.sentence, more: failure.detail, tone: .error)
            }
            HStack {
                Button("Cancel", action: onClose).keyboardShortcut(.cancelAction)
                Spacer()
                Button(draft.busy ? "Adding…" : "Add") { add() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(draft.addDisabled)
            }
        }.formStyle(.grouped).padding().frame(width: 430)
    }

    /// The Add button's action. Tests press it here: a test runner cannot drive the form's SwiftUI picker and fields
    /// (w_6d78h8ho).
    func add() {
        var finding = DecisionAction.Finding(kind: draft.kind)
        if draft.kind == "question" {
            finding.from = draft.from
            finding.to = draft.to
            finding.question = draft.question
            finding.choices = draft.choices.split(separator: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
            finding.decides = []
            finding.about = "text"
        } else {
            finding.at = draft.from
            finding.heard = draft.heard
            finding.proposed = draft.proposed
            finding.scope = "line"
            finding.confidence = 1
            finding.reason = "Manual spelling correction"
        }
        var action = DecisionAction(kind: "add")
        action.findings = [finding]
        action.force = draft.force
        draft.busy = true
        draft.message = nil
        draft.failure = nil
        Task { @MainActor in
            defer { draft.busy = false }
            do {
                let result = try await MeetingDetailModel.applyDecision(meeting: detail.id, action: action, reason: nil, service: detail.service)
                detail.readRecordAndRows()
                if let warnings = result.warnings, !warnings.isEmpty {
                    draft.message = warnings.joined(separator: "\n")
                } else {
                    onClose()
                }
            } catch {
                draft.failure = asFailure(error)
            }
        }
    }
}
