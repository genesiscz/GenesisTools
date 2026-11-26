import SwiftUI

/// A task's actions where it shows as an inbox item, one card for the hub's Inbox and the widget's session card.
/// `card` is the hub's: the title, who it is for and its state, the summary and the wrapped buttons, with no feedback
/// of its own (the hub shows `InboxTaskFeedback` under its list). `actions` is the widget's session card, whose head
/// already shows the title: the buttons, and the task's own failure row, Undo and resume prompt.
public struct WidgetTaskActionsCard: View {
    public enum Style: Sendable { case card, actions }

    // lint-rules-ignore: one task's card, observes its store on purpose
    @ObservedObject var store: WidgetTasksStore
    let task: WidgetTask
    let style: Style
    let sourceHome: String?
    let identifier: String

    public init(store: WidgetTasksStore, task: WidgetTask, style: Style, sourceHome: String? = nil, identifier: String) {
        self.store = store
        self.task = task
        self.style = style
        self.sourceHome = sourceHome
        self.identifier = identifier
    }

    public var body: some View {
        let busy = store.mutatingIDs.contains(task.id)
        VStack(alignment: .leading, spacing: 6) {
            switch style {
            case .card:
                Text(task.title).font(.headline).textSelection(.enabled)
                HStack(spacing: 6) {
                    Text(task.addressee + " · " + task.statusLabel)
                    if busy { ProgressView("Saving…").controlSize(.small) }
                }.font(.caption).foregroundStyle(.secondary)
                if task.summary != task.title { Text(task.summary).textSelection(.enabled) }
                if task.sendUncertain == true { Text("Check the session before sending this task again.") }
            case .actions:
                Text(task.addressee).font(.caption)
                if task.sendUncertain == true { Text("Check the session before sending again.") }
            }
            WrapLayout(spacing: 6, lineSpacing: 4) {
                ForEach(task.actions, id: \.self) { action in
                    Button(action.title) { store.perform(action, on: task, sourceHome: sourceHome) }
                        .buttonStyle(.genHover()).accessibilityLabel(action.title + ": " + task.title)
                }
            }.disabled(busy)
            if style == .actions {
                if let failure = store.failures.last(where: { $0.id == .change(task.id) }) {
                    WidgetTaskFailureRow(report: failure.report, message: failure.message, area: "widget",
                                         identifier: "widget.inbox.taskFailure")
                }
                if let undo = store.undo, undo.task.id == task.id {
                    Button("Undo") { store.perform(undo.action, on: undo.task, then: undo.then) }.buttonStyle(.genHover())
                }
            }
        }
        .padding(.vertical, style == .card ? 6 : 0)
        .accessibilityIdentifier(identifier)
        .taskResumePrompt(store, active: style == .actions, taskID: task.id)
    }
}

/// A task change that failed, in the widget's words: its headline and next step, with the tool's own output behind
/// Details. The generic report stands in only when the store kept none for the message.
public struct WidgetTaskFailureRow: View {
    let report: FailureReport?
    let message: String
    let area: String
    let identifier: String

    public init(report: FailureReport?, message: String, area: String, identifier: String) {
        self.report = report
        self.message = message
        self.area = area
        self.identifier = identifier
    }

    public var body: some View {
        FailureInline(report ?? FailureReport(title: "Task update", headline: "The task update could not be confirmed.",
                                              summary: "Check the saved task before trying again.", action: "Update task",
                                              log: message, area: area), form: .compact, identifier: identifier)
    }
}
