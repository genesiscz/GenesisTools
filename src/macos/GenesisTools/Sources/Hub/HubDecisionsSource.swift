import Foundation

// The session's Decisions pane reads the decision store through `tools question inbox`
// (src/question/lib/inbox), the same door as the Inbox mode: `--session <id> --json` lists every
// decision of the session in every state (stored rows plus the ones its last reply asks). Picks,
// notes, Dismiss and Send go through `HubInboxModel` (draft, dismiss, send), so the pane, the Inbox
// and /qa share one store and one behavior.

/// `tools question inbox --session <id> --json`.
struct SessionDecisionsEnvelope: Decodable {
    let sessionId: String
    let decisions: [InboxItem]
}

extension HubModel {
    /// Reads the session's decisions off the main thread. Only the newest load publishes: every pick
    /// starts one for the same session, and an older reply arriving last would show the older pick.
    /// The newest one always stops the spinner, even when its session is no longer selected.
    func loadDecisions(for sessionId: String) {
        loadingDecisions = true
        decisionsRequest += 1
        let request = decisionsRequest
        DispatchQueue.global(qos: .userInitiated).async {
            let span = HubPerf.begin("decisions.load")
            let result = Result {
                try JSONDecoder().decode(SessionDecisionsEnvelope.self, from: ToolsCLIRunner.run(["question", "inbox", "--session", sessionId, "--json"]))
            }
            span.end((try? result.get()).map { "\($0.decisions.count) decisions" } ?? "failed")
            DispatchQueue.main.async { [weak self] in
                guard let self, request == self.decisionsRequest else { return }
                self.loadingDecisions = false
                guard self.selected?.sessionId == sessionId else { return }
                switch result {
                case .success(let envelope):
                    self.decisions = envelope.decisions
                case .failure(let error):
                    self.notice = "Could not read this session's decisions: \(String("\(error)".prefix(120)))"
                }
            }
        }
    }
}
