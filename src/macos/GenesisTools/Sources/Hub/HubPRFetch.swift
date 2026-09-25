import SwiftUI

// A PR/MR whose branch has no local worktree still gets its diff: `tools hub pr fetch` (src/hub/lib/
// pr-fetch.ts) puts the host's PR head ref into the main checkout under refs/genesis/pr/<n>/, with no
// checkout and no change to a branch, tag or working tree, and the diff is a range there.

/// What `tools hub pr fetch <root>#<n> --json` answers.
struct HubPRFetch: Decodable, Equatable {
    let repoRoot: String
    let number: Int
    /// The host's ref: `refs/pull/<n>/head` or `refs/merge-requests/<iid>/head`.
    let sourceRef: String
    /// Where the head is now: `refs/genesis/pr/<n>/head`.
    let headRef: String
    let head: String
    /// A commit here to diff from: the recorded base, else the fetched target branch's tip.
    let base: String?
    let mergeBase: String?
    /// False when nothing went over the network (the head was already here).
    let fetched: Bool
    let warnings: [String]
}

enum PRFetchState: Equatable {
    case fetching
    case fetched(HubPRFetch)
    /// The sentence the PR header shows beside Retry.
    case failed(String)
}

/// One fetch per PR head: `forHead` is the head the PR list named when it ran. The same head never
/// fetches twice in a run, a failed one included (Retry asks again); a push fetches again.
struct PRFetchEntry: Equatable {
    let forHead: String?
    var state: PRFetchState
}

enum PRFetch {
    /// Two fetches of 40 s at most (the head, then the target branch), plus the tool's own start.
    static let timeout: TimeInterval = 100

    static func arguments(_ pr: HubPR, root: String, base: String?) -> [String] {
        var args = ["hub", "pr", "fetch", "\(root)#\(pr.number)", "--json"]
        if let kind = pr.origin?.kind, kind == "github" || kind == "gitlab" {
            args += ["--provider", kind]
        }
        if let head = pr.headSha, !head.isEmpty {
            args += ["--head", head]
        }
        if let base, !base.isEmpty {
            args += ["--base", base]
        }
        if !pr.baseBranch.isEmpty {
            args += ["--base-branch", pr.baseBranch]
        }
        return args
    }

    private struct Failure: Decodable {
        let error: String
        let code: String?
    }

    /// Blocks until the tool exits: call it from a detached task, never from a view body.
    static func run(_ args: [String]) -> PRFetchState {
        let capture: ProcessCapture
        do {
            capture = try ToolsCLIRunner.capture(args, timeout: timeout)
        } catch {
            return .failed("Could not fetch the PR head: \(error)")
        }
        if capture.status == 0, let result = try? JSONDecoder().decode(HubPRFetch.self, from: capture.stdout) {
            return .fetched(result)
        }
        return .failed(sentence(stdout: capture.stdout, stderr: capture.stderr, status: capture.status))
    }

    /// The verb prints `{ error, code }` on failure (src/hub/index.ts `prVerb`); the code picks the lead.
    static func sentence(stdout: Data, stderr: Data, status: Int32) -> String {
        if let failure = try? JSONDecoder().decode(Failure.self, from: stdout) {
            switch failure.code {
            case "auth": return "Sign-in needed to fetch the PR head: \(failure.error)"
            case "network": return "The host did not answer: \(failure.error)"
            case "ref-missing": return "The host has no head for this PR: \(failure.error)"
            default: return "Could not fetch the PR head: \(failure.error)"
            }
        }
        let text = String(decoding: stderr, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        return "tools hub pr fetch exited \(status)" + (text.isEmpty ? "" : ": \(text.suffix(200))")
    }
}

/// The PR header's word on a diff that is not there yet: fetching, or why not with Retry.
struct PRFetchStatus: View {
    let pr: HubPR
    let state: PRFetchState
    let retry: () -> Void

    var body: some View {
        switch state {
        case .fetching:
            HStack(spacing: 6) {
                ProgressView().controlSize(.small)
                Text("Fetching the PR head…")
                    .font(.system(size: 11.5))
                    .foregroundColor(ReviewPalette.dim)
            }
            .instantTooltip("No local worktree has \(pr.headBranch): git fetch puts the \(pr.isGitLab ? "MR" : "PR") head into refs/genesis/pr/\(pr.number)/head of \(pr.repoRoot ?? "the checkout"). Nothing is checked out.")
        case .failed(let message):
            HStack(spacing: 4) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundColor(ReviewPalette.removed)
                Text(message)
                    .font(.system(size: 11.5))
                    .foregroundColor(ReviewPalette.removed)
                    .lineLimit(1)
                    .truncationMode(.middle)
                IconButton(systemName: "arrow.clockwise", tooltip: "Fetch the \(pr.isGitLab ? "MR" : "PR") head again", action: retry)
            }
            .frame(maxWidth: 420, alignment: .trailing)
            .instantTooltip("No diff: \(message)")
        case .fetched:
            EmptyView()
        }
    }
}
