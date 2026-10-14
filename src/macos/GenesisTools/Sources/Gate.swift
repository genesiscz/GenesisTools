// The account gate's approval window (`--rpc {"method":"gate.approve"}`).
//
// Another process asked `tools ai gate request` for an AI account token or an API-key account's
// stored key. The TypeScript side
// verified the account and found no remembered grant; this side shows WHO asks (declared name,
// pid, executable, cwd, parent chain) and WHAT for (provider, account), then confirms the allow
// with Touch ID (password fallback). The reply is the decision plus how long to remember it.
//
// Nothing here touches the token: the window decides, the CLI resolves. A deny, a cancel, a
// failed authentication and a timeout all reply "deny" with a reason, never silence.

import AppKit
import Foundation
import LocalAuthentication

struct GateAncestor: Decodable {
    var pid: Int
    var command: String
}

struct GateClientInfo: Decodable {
    var name: String
    var pid: Int?
    var executable: String?
    var script: String?
    var command: String?
    var cwd: String?
    var ancestors: [GateAncestor]?
    /// The pid is running and is an ancestor of the gate process: it really started the request.
    var isAncestor: Bool?
    /// Interpreter flags or environment that load code the script path does not name.
    var injected: [String]?
    /// `isAncestor` plus a binary (and, for an interpreter, a clean script) strong enough to remember.
    var verified: Bool?
}

struct GateAccountInfo: Decodable {
    var id: String
    var name: String
    var label: String?
}

struct GateApproveParams: Decodable {
    var client: GateClientInfo
    var provider: String
    var account: GateAccountInfo
    /// Button choices in seconds. 0 is "allow once". Defaults to once, 8 hours, 7 days.
    var rememberChoicesSeconds: [Int]?
    /// "long-lived" (an Anthropic setup token that survives refreshes), "access" (an OAuth
    /// access token another process can revoke by refreshing) or "api-key" (the account's stored
    /// API key, xai/openai). Decided by the CLI before the window.
    var tokenKind: String?
}

private func describeToken(_ kind: String?, provider: String) -> String {
    if kind == "api-key" {
        return "The API KEY itself is shared, not a token. It does not expire: this app can use it, and bill the \(provider) account, until you rotate the key in the \(provider) console. It is read from the GenesisTools vault and handed to this app only."
    }

    if kind == "long-lived" {
        return "A long-lived token is shared: the same one `tools claude run` gives Claude Code. It carries no refresh token and stays valid when other apps refresh their sessions."
    }

    return "An OAuth access token is shared. It carries no refresh token, and it stops working as soon as any other app refreshes this account's session (then the app has to ask again). Attach a long-lived token with `tools claude login-long` to avoid that."
}

/// A human reads the window and touches the sensor; the CLI waits 180 s, so this side gives up
/// a little earlier and says why.
private let gateDeadlineSeconds: Double = 170

private func gateEmit(decision: String, rememberSeconds: Int, method: String, reason: String) -> Never {
    logClick("gate.approve decision=\(decision) remember=\(rememberSeconds) method=\(method) reason=\(reason)")
    emitResult([
        "decision": decision,
        "rememberSeconds": rememberSeconds,
        "method": method,
        "reason": reason,
    ])
}

/// Touch ID first, then the account password when biometrics are unavailable or the user picks
/// the fallback. A cancel at either step is a deny. The vault window (VaultUnlock.swift) confirms with it too.
func authenticate(reason: String, completion: @escaping (_ method: String?, _ failure: String) -> Void) {
    let biometric = LAContext()
    biometric.localizedFallbackTitle = "Use Password"
    var unavailable: NSError?

    guard biometric.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &unavailable) else {
        let password = LAContext()
        password.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { ok, error in
            DispatchQueue.main.async {
                completion(ok ? "password" : nil, error?.localizedDescription ?? "password authentication failed")
            }
        }
        return
    }

    biometric.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason) { ok, error in
        DispatchQueue.main.async {
            if ok {
                completion("touch-id", "")
                return
            }

            let code = (error as? LAError)?.code

            // The user chose "Use Password", or the sensor is locked out: the password policy is
            // the same question asked another way, not a second chance for a deny.
            if code == .userFallback || code == .biometryLockout {
                let password = LAContext()
                password.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { ok, error in
                    DispatchQueue.main.async {
                        completion(ok ? "password" : nil, error?.localizedDescription ?? "password authentication failed")
                    }
                }
                return
            }

            completion(nil, error?.localizedDescription ?? "Touch ID failed")
        }
    }
}

/// What the gate window shows, built from the CLI's request. Pure, so tests read it.
struct GateWindowContent {
    var title: String
    var purpose: String
    var facts: [ApprovalFact]
    var details: [ApprovalFact]
    var warning: String?
    var rememberChoices: [ApprovalRemember]

    static func rememberTitle(_ seconds: Int) -> String {
        if seconds <= 0 { return "Just this once" }
        if seconds % 86_400 == 0 { return "For \(Plural.count(seconds / 86_400, "day"))" }
        if seconds % 3_600 == 0 { return "For \(Plural.count(seconds / 3_600, "hour"))" }
        return "For \(seconds / 60) min"
    }

    static func build(_ params: GateApproveParams, home: String = NSHomeDirectory()) -> GateWindowContent {
        let client = params.client
        let accountLabel = params.account.label.map { "\(params.account.name) (\($0))" } ?? params.account.name
        let choices = (params.rememberChoicesSeconds?.isEmpty == false ? params.rememberChoicesSeconds : nil) ?? [0, 8 * 3_600, 7 * 86_400]
        let program = client.script ?? client.executable

        var facts = [ApprovalFact("Account", "\(accountLabel) · \(params.provider)")]
        facts.append(ApprovalFact("Program", program.map { "\(client.name) · \(VaultWindowContent.shortPath($0, home: home))" } ?? client.name,
                                  help: [client.executable, client.script].compactMap { $0 }.joined(separator: " ")))
        if let cwd = client.cwd, !cwd.isEmpty {
            facts.append(ApprovalFact("Folder", VaultWindowContent.shortPath(cwd, home: home), help: cwd))
        }

        var details = [ApprovalFact("Process", client.pid.map { "pid \($0)" } ?? "not identified (no pid)")]
        if let executable = client.executable, !executable.isEmpty {
            details.append(ApprovalFact("Executable", executable, monospaced: true))
        }

        if let command = client.command, !command.isEmpty, command != client.executable {
            details.append(ApprovalFact("Command", command, monospaced: true))
        }

        if let ancestors = client.ancestors, !ancestors.isEmpty {
            details.append(ApprovalFact("Started by", ancestors.map { "\($0.command) (\($0.pid))" }.joined(separator: " ← ")))
        }

        var warnings: [String] = []
        if let injected = client.injected, !injected.isEmpty {
            warnings.append("Extra code may be loaded (\(injected.joined(separator: ", "))).")
        }

        // A running pid that did not start the request is refused before this window opens, so an unverified client
        // here is either a real ancestor whose identity is incomplete, or no pid.
        if client.verified != true {
            warnings.append(client.isAncestor == true
                ? "Unverified: its binary or script could not be established. It will not be remembered."
                : "Unverified: no running pid was given. It will not be remembered.")
        }

        let isApiKey = params.tokenKind == "api-key"
        return GateWindowContent(
            title: isApiKey
                ? "“\(client.name)” wants the \(params.provider) API key of \(params.account.name)"
                : "“\(client.name)” wants the \(params.provider) token of \(params.account.name)",
            purpose: describeToken(params.tokenKind, provider: params.provider),
            facts: facts,
            details: details,
            warning: warnings.isEmpty ? nil : warnings.joined(separator: " "),
            rememberChoices: choices.map { ApprovalRemember(seconds: $0, title: rememberTitle($0)) })
    }
}

@MainActor private let gatePresenter = ApprovalPanelPresenter()

func approveGate(_ params: GateApproveParams) {
    let content = GateWindowContent.build(params)
    let biometric = LAContext().canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)

    DispatchQueue.main.async {
        let model = ApprovalDialogModel(
            title: content.title, purpose: content.purpose, symbol: "person.badge.key.fill", facts: content.facts,
            details: content.details, warning: content.warning,
            footnote: "Every decision is written to the gate audit log (tools ai gate audit).",
            rememberChoices: content.rememberChoices.count > 1 ? content.rememberChoices : [],
            rememberNote: content.rememberChoices.count > 1 ? nil : "Only once",
            allowTitle: biometric ? "Allow with Touch ID" : "Allow…",
            deadline: Date().addingTimeInterval(gateDeadlineSeconds), identifier: "gate-approve")

        // The NSAlert this replaces ran a modal loop on the main queue, so this timer never fired there.
        let deadline = DispatchWorkItem {
            gateEmit(decision: "deny", rememberSeconds: 0, method: "none", reason: "no answer within \(Int(gateDeadlineSeconds))s")
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + gateDeadlineSeconds, execute: deadline)

        model.onDeny = {
            deadline.cancel()
            gatePresenter.close()
            gateEmit(decision: "deny", rememberSeconds: 0, method: "none", reason: "denied in the approval window")
        }

        model.onAllow = { choice in
            deadline.cancel()
            gatePresenter.close()
            let remember = choice?.seconds ?? 0
            let reason = params.tokenKind == "api-key"
                ? "give “\(params.client.name)” the API key of the \(params.provider) account \(params.account.name)"
                : "allow “\(params.client.name)” to use the \(params.provider) account \(params.account.name)"

            authenticate(reason: reason) { method, failure in
                guard let method else {
                    gateEmit(decision: "deny", rememberSeconds: 0, method: "none", reason: failure)
                }

                gateEmit(decision: "allow", rememberSeconds: remember, method: method, reason: "")
            }
        }

        gatePresenter.present(model)
    }
}
