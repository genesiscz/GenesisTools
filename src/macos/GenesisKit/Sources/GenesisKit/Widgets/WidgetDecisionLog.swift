import Foundation

/// The widget's door to the decision log for the staging engine (`DecisionAnswering.Engine`): the hub's `ledger` and
/// `unstage` widget actions, in the model's one queue of hub writes (`WidgetModel.decisionWrite`), so a decision's
/// writes keep their order with every other write of the widget. The hub's Inbox has its own (`HubInboxDecisionLog`).
@MainActor
final class WidgetDecisionLog: DecisionLog {
    private weak var model: WidgetModel?

    init(model: WidgetModel) {
        self.model = model
    }

    func run(_ action: DecisionLogAction) async -> DecisionLogAnswer {
        guard let model else { return .unanswered(seconds: 0) }
        let request = Self.request(action)
        // A stage writes one row of the log on this Mac: at its limit the pick stays here with Try again.
        guard case .stage = action else { return await model.decisionWrite(request) }
        return await model.decisionWrite(request, timeoutSeconds: WidgetModel.stageWriteTimeoutSeconds, keepsInput: true)
    }

    /// The widget action of one decision action. A quit sends it straight through the bridge (`WidgetLedgerUndo`).
    nonisolated static func request(_ action: DecisionLogAction) -> WidgetJSON {
        switch action {
        case .stage(let ref, let option, let note):
            var fields = ledger(ref, state: "drafted")
            if let option { fields["draftOption"] = .string(option) }
            if let note { fields["draft"] = .string(note) }
            return .object(fields)
        case .unstage(let refs):
            return ["action": "unstage", "ids": .array(refs.map { .string($0.id) })]
        case .dismiss(let ref):
            return .object(ledger(ref, state: "dismissed"))
        case .move(let ref, let state):
            return .object(ledger(ref, state: state))
        }
    }

    private nonisolated static func ledger(_ ref: DecisionAddress, state: String) -> [String: WidgetJSON] {
        var fields: [String: WidgetJSON] = [
            "action": "ledger", "id": .string(ref.id), "sessionId": .string(ref.sessionId), "state": .string(state),
        ]
        if let revision = ref.revision { fields["expectedRevision"] = .number(Double(revision)) }
        return fields
    }
}
