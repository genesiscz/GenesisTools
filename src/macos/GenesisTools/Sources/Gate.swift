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

private func rememberLabel(_ seconds: Int) -> String {
    if seconds <= 0 {
        return "Allow once"
    }

    if seconds % 86_400 == 0 {
        let days = seconds / 86_400
        return "Allow for \(days) day\(days == 1 ? "" : "s")"
    }

    if seconds % 3_600 == 0 {
        let hours = seconds / 3_600
        return "Allow for \(hours) hour\(hours == 1 ? "" : "s")"
    }

    return "Allow for \(seconds / 60) min"
}

private func describeClient(_ client: GateClientInfo) -> String {
    var lines: [String] = []

    if let pid = client.pid {
        lines.append("Process: pid \(pid)")
    } else {
        lines.append("Process: not identified (no pid)")
    }

    if let executable = client.executable, !executable.isEmpty {
        lines.append("Executable: \(executable)")
    } else if client.pid != nil {
        lines.append("Executable: not running under that pid")
    }

    if let script = client.script, !script.isEmpty {
        lines.append("Script: \(script)")
    }

    if let command = client.command, !command.isEmpty, command != client.executable {
        lines.append("Command: \(command)")
    }

    if let cwd = client.cwd, !cwd.isEmpty {
        lines.append("Working dir: \(cwd)")
    }

    if let ancestors = client.ancestors, !ancestors.isEmpty {
        let chain = ancestors.map { "\($0.command) (\($0.pid))" }.joined(separator: " ← ")
        lines.append("Started by: \(chain)")
    }

    if let injected = client.injected, !injected.isEmpty {
        lines.append("⚠️ Extra code may be loaded: \(injected.joined(separator: ", "))")
    }

    // A running pid that did not start the request is refused before this window opens, so an
    // unverified client here is either a real ancestor whose identity is incomplete, or no pid.
    if client.verified != true {
        let why = client.isAncestor == true
            ? "its binary or script could not be established"
            : "no running pid was given"
        lines.append("⚠️ Unverified: \(why). Allow once at most; it will not be remembered.")
    }

    return lines.joined(separator: "\n")
}

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
/// the fallback. A cancel at either step is a deny.
private func authenticate(reason: String, completion: @escaping (_ method: String?, _ failure: String) -> Void) {
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

func approveGate(_ params: GateApproveParams) {
    let choices = (params.rememberChoicesSeconds?.isEmpty == false ? params.rememberChoicesSeconds : nil) ?? [0, 8 * 3_600, 7 * 86_400]
    let accountLabel = params.account.label.map { "\(params.account.name) (\($0))" } ?? params.account.name

    DispatchQueue.main.asyncAfter(deadline: .now() + gateDeadlineSeconds) {
        gateEmit(decision: "deny", rememberSeconds: 0, method: "none", reason: "no answer within \(Int(gateDeadlineSeconds))s")
    }

    DispatchQueue.main.async {
        NSApplication.shared.activate(ignoringOtherApps: true)

        let isApiKey = params.tokenKind == "api-key"
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = isApiKey
            ? "“\(params.client.name)” asks for the API KEY of the \(params.provider) account \(accountLabel)"
            : "“\(params.client.name)” asks for the \(params.provider) token of \(accountLabel)"
        alert.informativeText = describeClient(params.client)
            + "\n\n" + describeToken(params.tokenKind, provider: params.provider) + " Touch ID confirms an allow."

        for seconds in choices {
            alert.addButton(withTitle: rememberLabel(seconds))
        }

        let deny = alert.addButton(withTitle: "Deny")
        deny.keyEquivalent = "\u{1b}"

        let response = alert.runModal()
        let index = response.rawValue - NSApplication.ModalResponse.alertFirstButtonReturn.rawValue

        guard index >= 0, index < choices.count else {
            gateEmit(decision: "deny", rememberSeconds: 0, method: "none", reason: "denied in the approval window")
        }

        let remember = choices[index]
        let reason = isApiKey
            ? "give “\(params.client.name)” the API key of the \(params.provider) account \(params.account.name)"
            : "allow “\(params.client.name)” to use the \(params.provider) account \(params.account.name)"

        authenticate(reason: reason) { method, failure in
            guard let method else {
                gateEmit(decision: "deny", rememberSeconds: 0, method: "none", reason: failure)
            }

            gateEmit(decision: "allow", rememberSeconds: remember, method: method, reason: "")
        }
    }
}
