import SwiftUI

/// Adds to the same decision journal as the CLI. The service supplies anchor errors and duplicate IDs.
struct FindingComposerButton: View {
    @Bindable var detail: MeetingDetailModel
    @State private var showing = false
    @State private var kind = "question"
    @State private var from = 0.0
    @State private var to = 10.0
    @State private var question = ""
    @State private var choices = ""
    @State private var heard = ""
    @State private var proposed = ""
    @State private var force = false
    @State private var busy = false
    @State private var message: String?

    var body: some View {
        Button("Add question or term…", systemImage: "plus") { showing = true }
            .accessibilityIdentifier("meetings.finding.add")
            .popover(isPresented: $showing) {
                Form {
                    Picker("Finding", selection: $kind) {
                        Text("Question").tag("question")
                        Text("Term").tag("term")
                    }
                    TextField("From, seconds", value: $from, format: .number)
                    if kind == "question" {
                        TextField("To, seconds", value: $to, format: .number)
                        TextField("Question", text: $question)
                        TextField("Choices, separated by commas", text: $choices)
                        Text("Without decided findings, an answer is saved as a plain question.")
                            .font(.caption).foregroundStyle(.secondary)
                    } else {
                        TextField("Heard words", text: $heard)
                        TextField("Proposed spelling", text: $proposed)
                        Toggle("Force an invalid anchor", isOn: $force)
                        Text("An invalid anchor reports the nearest line containing the word. Correct the time before adding, or explicitly force it.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    if let message { Text(verbatim: message).font(.caption).textSelection(.enabled) }
                    HStack {
                        Button("Cancel") { showing = false }.keyboardShortcut(.cancelAction)
                        Spacer()
                        Button(busy ? "Adding…" : "Add") { add() }
                            .keyboardShortcut(.defaultAction)
                            .disabled(busy || from < 0 || (kind == "question" ? to < from || question.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty : heard.isEmpty || proposed.isEmpty))
                    }
                }.formStyle(.grouped).padding().frame(width: 430)
            }
    }

    private func add() {
        var finding = DecisionAction.Finding(kind: kind)
        if kind == "question" {
            finding.from = from
            finding.to = to
            finding.question = question
            finding.choices = choices.split(separator: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
            finding.decides = []
            finding.about = "text"
        } else {
            finding.at = from
            finding.heard = heard
            finding.proposed = proposed
            finding.scope = "line"
            finding.confidence = 1
            finding.reason = "Manual spelling correction"
        }
        var action = DecisionAction(kind: "add")
        action.findings = [finding]
        action.force = force
        busy = true
        message = nil
        Task { @MainActor in
            defer { busy = false }
            do {
                let result = try await MeetingDetailModel.applyDecision(meeting: detail.id, action: action, reason: nil, service: detail.service)
                detail.readRecordAndRows()
                if let warnings = result.warnings, !warnings.isEmpty {
                    message = warnings.joined(separator: "\n")
                } else {
                    showing = false
                }
            } catch {
                message = error.localizedDescription
            }
        }
    }
}
