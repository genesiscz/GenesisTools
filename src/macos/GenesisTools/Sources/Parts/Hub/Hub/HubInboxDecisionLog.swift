import Foundation

/// The hub Inbox's door to the decision log for the staging engine (`DecisionAnswering.Engine`): `tools question
/// inbox draft` and `dismiss`, off the main thread. These commands also harvest a decision that only the session's last
/// reply asks (an Inbox item with `source: "transcript"`), which the widget's `ledger` action cannot: it needs a stored
/// row. The widget's adapter is its live connection (`WidgetModel.action`).
@MainActor
final class HubInboxDecisionLog: DecisionLog {
    /// Runs one `tools` command; tests replace it (`HubInboxModel.captureWrite`).
    var capture: @Sendable ([String]) throws -> ProcessCapture = { try HubSource.bridge.capture($0) }

    func run(_ action: DecisionLogAction) async -> DecisionLogAnswer {
        let capture = capture
        guard let commands = Self.arguments(action) else {
            return .refused("the hub Inbox cannot change this item that way.", detail: nil)
        }
        return await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                let span = HubPerf.begin("inbox.draft")
                var answer = DecisionLogAnswer.done(.object([:]))
                for args in commands {
                    do {
                        let result = try capture(args)
                        guard result.status == 0 else {
                            let refusal = HubInboxModel.refusal(result)
                            answer = .refused(refusal.text, detail: refusal.raw)
                            break
                        }
                    } catch {
                        answer = .refused("the hub could not run tools. Try again.", detail: "\(error)")
                        break
                    }
                }
                if case .done = answer { span.end("ok") } else { span.end("failed") }
                continuation.resume(returning: answer)
            }
        }
    }

    /// The `tools` commands of one action: a stage is one `question inbox draft`, an unstage one per decision with the
    /// pick and the note cleared, a dismiss one `question inbox dismiss`. Nil for a move the Inbox has no command for
    /// (a task's Mark complete is the widget's).
    nonisolated static func arguments(_ action: DecisionLogAction) -> [[String]]? {
        switch action {
        case .move(let address, let state):
            return state == "dismissed" ? arguments(.dismiss(address)) : nil
        case .stage(let address, let option, let note):
            return draft(address, option: option, note: note).map { [$0] } ?? []
        case .unstage(let addresses):
            return addresses.compactMap { draft($0, option: "", note: "") }
        case .dismiss(let address):
            guard let number = address.number else { return [] }
            var args = ["question", "inbox", "dismiss", "--session", address.sessionId, "--decision", String(number)]
            if let revision = address.revision { args += ["--expected-revision", String(revision)] }
            return [args]
        }
    }

    private nonisolated static func draft(_ address: DecisionAddress, option: String?, note: String?) -> [String]? {
        guard let number = address.number else { return nil }
        var args = ["question", "inbox", "draft", "--session", address.sessionId, "--decision", String(number)]
        if let option { args += ["--option", option] }
        if let note { args += ["--text", note] }
        if let provider = address.provider { args += ["--provider", provider] }
        if let cwd = address.cwd, !cwd.isEmpty { args += ["--cwd", cwd] }
        if let revision = address.revision { args += ["--expected-revision", String(revision)] }
        return args
    }
}
