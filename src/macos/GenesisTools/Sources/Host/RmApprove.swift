// The safe delete's approval window (`--rpc {"method":"rm.approve"}`).
//
// `tools rm approve <id>`, `tools rm config set` and the other commands that need a person ask here when the rm
// setting `approval` allows Touch ID. The window shows what will happen (the paths, who asked), and Approve runs
// Touch ID (password fallback). An agent can open the window and even press the button, but it cannot touch the
// sensor, which the typed code and the AppleScript dialog could not promise. The reply is the decision and how it was
// confirmed; the CLI does the deletion. A deny, a cancel, a failed authentication and a timeout all reply "deny".

import AppKit
import Foundation
import LocalAuthentication

struct RmApproveParams: Decodable {
    var title: String
    /// One line per path or setting, as the terminal prompt shows them.
    var lines: [String]
    /// The agent and session that asked, when an agent asked.
    var caller: String?
    var folder: String?
}

/// The CLI waits 180 s; this side gives up a little earlier and says why.
private let rmDeadlineSeconds: Double = 170

/// The window shows this many lines; the rest are folded into Details.
private let rmShownLines = 6

private func rmEmit(decision: String, method: String, reason: String) -> Never {
    logClick("rm.approve decision=\(decision) method=\(method) reason=\(reason)")
    emitResult(["decision": decision, "method": method, "reason": reason])
}

/// What the rm window shows, built from the CLI's request. Pure, so tests read it.
struct RmWindowContent {
    var facts: [ApprovalFact]
    var details: [ApprovalFact]

    static func build(_ params: RmApproveParams, home: String = NSHomeDirectory()) -> RmWindowContent {
        var facts: [ApprovalFact] = []
        if let caller = params.caller, !caller.isEmpty {
            facts.append(ApprovalFact("Asked by", caller))
        }

        if let folder = params.folder, !folder.isEmpty {
            facts.append(ApprovalFact("Folder", VaultWindowContent.shortPath(folder, home: home), help: folder))
        }

        // A fact's label is its SwiftUI id and a value shows at most 3 lines, so each item is its own fact, numbered.
        let items = params.lines.enumerated().map { index, line in ApprovalFact("\(index + 1)", line, monospaced: true) }
        facts.append(contentsOf: items.prefix(rmShownLines))
        let details = Array(items.dropFirst(rmShownLines))
        if !details.isEmpty {
            facts.append(ApprovalFact("More", "\(Plural.count(details.count, "more item")) in Details"))
        }

        return RmWindowContent(facts: facts, details: details)
    }
}

@MainActor private let rmPresenter = ApprovalPanelPresenter()

func approveRm(_ params: RmApproveParams) {
    let content = RmWindowContent.build(params)
    let audit: [String: Any] = ["title": params.title, "lines": params.lines, "caller": params.caller ?? "", "folder": params.folder ?? ""]
    func record(_ event: String, _ extra: [String: Any] = [:]) {
        GateAudit.write(gate: "rm", event: event, audit.merging(extra) { _, new in new })
    }
    let biometric = LAContext().canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)

    DispatchQueue.main.async {
        let model = ApprovalDialogModel(
            title: params.title,
            purpose: "Nothing changes until you approve. Deleted items go to the trash and can be restored with tools rm restore during the grace period.",
            symbol: "trash.fill", facts: content.facts, details: content.details, warning: nil,
            footnote: "Every decision is written to the tools rm ledger and the gate audit log.",
            rememberChoices: [], rememberNote: "Only once",
            allowTitle: biometric ? "Approve with Touch ID" : "Approve…",
            deadline: Date().addingTimeInterval(rmDeadlineSeconds), identifier: "rm-approve")

        let deadline = DispatchWorkItem {
            record("denied", ["detail": "no answer within \(Int(rmDeadlineSeconds))s"])
            rmEmit(decision: "deny", method: "none", reason: "no answer within \(Int(rmDeadlineSeconds))s")
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + rmDeadlineSeconds, execute: deadline)

        model.onDeny = {
            deadline.cancel()
            rmPresenter.close()
            record("denied", ["detail": "denied in the approval window"])
            rmEmit(decision: "deny", method: "none", reason: "denied in the approval window")
        }

        model.onAllow = { _ in
            deadline.cancel()
            rmPresenter.close()
            authenticate(reason: "approve: \(params.title)") { method, failure in
                guard let method else {
                    record("denied", ["detail": failure])
                    rmEmit(decision: "deny", method: "none", reason: failure)
                }

                record("allowed", ["method": method])
                rmEmit(decision: "allow", method: method, reason: "")
            }
        }

        record("prompted", ["shown": GateAudit.shown(title: params.title, purpose: model.purpose,
                                                     facts: content.facts + content.details, warning: nil, onceOnly: "only once")])
        rmPresenter.present(model)
    }
}
