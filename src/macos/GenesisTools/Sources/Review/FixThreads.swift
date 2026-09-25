import AppKit
import SwiftUI

// "Fix these threads": the review threads picked on the diff cards (their Fix checkbox, or x) or in
// the threads list go as one task to the session that owns the branch, whose cmux pane then takes
// the focus. The logic is `tools hub pr fix` (src/hub/lib/fix-threads.ts): it writes the task file,
// ranks the PR's sessions (`tools hub pr sessions`) with the ones open in cmux first, types one line
// into the chosen one and focuses it. Nothing is written to the PR.

extension PRCommand {
    /// `send: false` only writes the task file and returns the prompt (a new agent starts with it).
    static func fix(_ target: PRTarget, repo: String, threads: [String], session: String? = nil,
                    send: Bool = true, dryRun: Bool = false) -> [String] {
        var args = ["hub", "pr", "fix", "--repo", repo]
        if case .ref(let ref) = target {
            args += ["--pr", ref]
        }
        args += ["--threads", threads.joined(separator: ",")]
        if let session {
            args += ["--session", session]
        }
        if !send {
            args.append("--no-send")
        }
        if dryRun {
            args.append("--dry-run")
        }
        return args + ["--json"]
    }

    /// "Send to agent" on a failed check (`tools hub pr fix-check`): the same task path as `fix`, with
    /// the check's URL and name instead of thread ids. `target` is the PR's URL or `<repoPath>#<n>`.
    static func fixCheck(_ target: PRTarget, repo: String, checkURL: String, name: String, session: String? = nil,
                         send: Bool = true, dryRun: Bool = false) -> [String] {
        var args = ["hub", "pr", "fix-check", "--check", checkURL, "--name", name, "--repo", repo]
        if case .ref(let ref) = target {
            args += ["--pr", ref]
        }
        if let session {
            args += ["--session", session]
        }
        if !send {
            args.append("--no-send")
        }
        if dryRun {
            args.append("--dry-run")
        }
        return args + ["--json"]
    }
}

struct FixOwner: Decodable, Identifiable, Equatable {
    let provider: String
    let sessionId: String
    let title: String?
    let cwd: String
    let mtime: String
    let reasons: [String]
    /// cmux has its recorded pane open now.
    let live: Bool

    var id: String { sessionId }
    var displayTitle: String { title?.isEmpty == false ? title ?? "" : URL(fileURLWithPath: cwd).lastPathComponent }
}

struct FixThreadsResult: Decodable, Equatable {
    struct PR: Decodable, Equatable {
        let label: String
        let url: String
        let title: String
        let branch: String
    }

    struct Thread: Decodable, Equatable {
        let id: String
        let path: String
        let line: Int
    }

    let pr: PR
    let threads: [Thread]
    let missing: [String]
    let file: String
    let written: Bool
    let prompt: String
    let owner: FixOwner?
    let candidates: [FixOwner]
    let sent: Bool
    let focused: Bool
    let error: String?
}

enum FixThreadsCLI {
    /// Blocking: off the main thread only. A failed send still prints the result (with `error`) and
    /// exits 1, so stdout is read first; anything else is the verb's `{error, code}`.
    static func run(_ args: [String]) throws -> FixThreadsResult {
        let result = try ToolsCLIRunner.capture(args)
        if let decoded = try? JSONDecoder().decode(FixThreadsResult.self, from: result.stdout) {
            return decoded
        }
        if let failure = try? JSONDecoder().decode(PRCLIError.self, from: result.stdout) {
            throw failure
        }
        let message = String(decoding: result.stderr, as: UTF8.self)
        throw ReviewError.git("tools hub pr fix exited \(result.status): \(message.trimmed.suffix(300))")
    }

    /// Brings cmux forward on the pane a new agent opened in (its workspace was created focused).
    static func activateCmux() {
        NSRunningApplication.runningApplications(withBundleIdentifier: "com.cmuxterm.app").first?.activate()
    }
}

/// The popover behind "Fix N threads…": the threads, then the shared task form (the PR's sessions,
/// best first, or a new agent). The plan comes from a dry run, so nothing is written before Send.
struct FixThreadsForm: View {
    @ObservedObject var model: ReviewModel
    let store: PRThreadsStore
    let close: () -> Void

    private var threads: [PRThread] {
        (store.payload?.threads ?? []).filter { model.selectedThreads.contains($0.id) }
    }

    var body: some View {
        let ids = threads.map(\.id)
        let count = ids.count
        PRTaskForm(
            title: "Fix \(count) \(count == 1 ? "thread" : "threads") on \(store.label)",
            subtitle: "They go as one task file; the agent gets one line that names it. Nothing is posted on the PR.",
            what: "\(count) threads",
            cwd: model.repo.path,
            newAgentName: "Fix \(store.label) threads",
            branch: store.pr?.sourceBranch,
            newAgentNote: model.remoteHead.map { "\($0.branch) is not checked out in this folder: the agent must add a worktree for it before it edits." },
            perfArea: "review.fix",
            disabled: threads.isEmpty,
            argv: { session, send, dryRun in
                PRCommand.fix(store.target, repo: model.repo.path, threads: dryRun ? Array(model.selectedThreads).sorted() : ids,
                              session: session, send: send, dryRun: dryRun)
            },
            finished: { notice, ok in
                if ok { model.clearThreadSelection() }
                store.notice = notice
            },
            close: close
        ) {
            threadList
        }
    }

    private var threadList: some View {
        VStack(alignment: .leading, spacing: 3) {
            ForEach(threads.prefix(6)) { thread in
                HStack(spacing: 6) {
                    Text(verbatim: "\(thread.path):\(thread.line)")
                        .font(.system(size: 11.5, design: .monospaced))
                        .lineLimit(1)
                        .truncationMode(.head)
                    if let who = thread.comments.first?.author.username {
                        Text(verbatim: "@\(who)").font(.system(size: 11)).foregroundColor(ReviewPalette.dim).lineLimit(1)
                    }
                }
            }
            if threads.count > 6 {
                Text(verbatim: "and \(threads.count - 6) more").font(.system(size: 11)).foregroundColor(ReviewPalette.dim)
            }
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 6).fill(Color.black.opacity(0.25)))
    }
}

/// One task for the session that owns a PR's branch (src/hub/lib/fix-threads.ts `sendPrTask`):
/// "Fix these threads" and a failed check's "Send to agent" both use it. The caller gives the argv of
/// its `tools hub pr …` verb; the verb prints `FixThreadsResult`. A dry run lists where the task can
/// go (the PR's sessions, open in cmux first, or a new agent); Send writes the task file and types one
/// line naming it into that session, or starts a new agent with that line.
struct PRTaskForm<Summary: View>: View {
    let title: String
    let subtitle: String
    /// What the task carries, for the notices: "3 threads", "the CI / test log".
    let what: String
    /// Where a new agent starts, and its name.
    let cwd: String
    let newAgentName: String
    let branch: String?
    /// Said under the new-agent choice when `cwd` does not have the branch checked out.
    var newAgentNote: String?
    /// HubPerf span prefix: `<area>.plan` and `<area>.send`.
    let perfArea: String
    var disabled = false
    let argv: (_ session: String?, _ send: Bool, _ dryRun: Bool) -> [String]
    /// The notice to show, and whether the task went out (a sent task or a started agent).
    let finished: (_ notice: String, _ ok: Bool) -> Void
    let close: () -> Void
    @ViewBuilder let summary: () -> Summary

    @State private var plan: FixThreadsResult?
    @State private var planError: String?
    @State private var choice: String?
    @State private var sending = false
    @State private var newAgentPrompt: String?

    private static var newAgent: String { "new-agent" }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(verbatim: title)
                .font(.system(size: 13, weight: .semibold))
            Text(verbatim: subtitle)
                .font(.system(size: 11.5))
                .foregroundColor(ReviewPalette.dim)
                .fixedSize(horizontal: false, vertical: true)
            summary()
            Text("Send to").font(.system(size: 11, weight: .semibold)).foregroundColor(ReviewPalette.dim)
            targets
            HStack(spacing: 8) {
                if sending {
                    ProgressView().controlSize(.small)
                }
                Spacer()
                Button("Cancel", action: close)
                    .keyboardShortcut(.cancelAction)
                Button(choice == Self.newAgent ? "Start agent…" : "Send and focus") { send() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(sending || disabled || choice == nil)
                    .instantTooltip(choice == Self.newAgent
                        ? "Write the task file, then pick where the new agent starts with it"
                        : "Write the task file, type one line naming it into that session's cmux pane, then focus the pane")
            }
            .buttonStyle(.genHoverPlain())
        }
        .padding(14)
        .frame(width: 440)
        .task { await loadPlan() }
        .popover(isPresented: Binding(get: { newAgentPrompt != nil }, set: { if !$0 { newAgentPrompt = nil } }), arrowEdge: .bottom) {
            LaunchPicker(mode: .new(cwd: cwd, name: newAgentName, prompt: newAgentPrompt)) { outcome in
                newAgentPrompt = nil
                switch outcome {
                case .cancelled:
                    return
                case .launched:
                    FixThreadsCLI.activateCmux()
                    finished("A new agent got \(what); cmux is in front.", true)
                case .failed(let why):
                    finished("Failed: \(why)", false)
                }
                close()
            }
        }
    }

    @ViewBuilder
    private var targets: some View {
        VStack(alignment: .leading, spacing: 2) {
            if plan == nil && planError == nil {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text("Looking for the session that owns \(branch ?? "the branch")…")
                        .font(.system(size: 11.5)).foregroundColor(ReviewPalette.dim)
                }
            }
            if let planError {
                Text(verbatim: planError).font(.system(size: 11.5)).foregroundColor(ReviewPalette.removed).lineLimit(3)
            }
            ForEach(plan?.candidates ?? []) { owner in
                targetRow(id: owner.sessionId, selected: choice == owner.sessionId) {
                    Text(verbatim: String(owner.provider.prefix(1)).uppercased())
                        .font(.system(size: 10, weight: .bold))
                        .frame(width: 16, height: 16)
                        .background(RoundedRectangle(cornerRadius: 4).fill(Color.white.opacity(0.1)))
                        .instantTooltip(owner.provider.capitalized)
                    Text(verbatim: owner.displayTitle).font(.system(size: 12)).lineLimit(1).truncationMode(.tail)
                    Text(verbatim: HubFormat.ago(HubFormat.date(owner.mtime))).font(.system(size: 11)).foregroundColor(ReviewPalette.dim).fixedSize()
                    Text(verbatim: owner.reasons.joined(separator: " · ")).font(.system(size: 10.5)).foregroundColor(ReviewPalette.dim).lineLimit(1)
                    Spacer(minLength: 4)
                    Circle()
                        .fill(owner.live ? ReviewPalette.added : Color.white.opacity(0.18))
                        .frame(width: 7, height: 7)
                        .instantTooltip(owner.live ? "Open in cmux now: the line goes straight into its pane"
                                                   : "Not open in cmux: resume it first (PR Sessions), or start a new agent")
                }
            }
            if plan != nil, plan?.candidates.isEmpty == true {
                Text("No session worked on this branch.").font(.system(size: 11.5)).foregroundColor(ReviewPalette.dim)
            }
            targetRow(id: Self.newAgent, selected: choice == Self.newAgent) {
                Image(systemName: "plus.circle").font(.system(size: 12)).frame(width: 16)
                Text("A new agent in \(URL(fileURLWithPath: cwd).lastPathComponent)").font(.system(size: 12))
                Spacer(minLength: 4)
            }
            if let newAgentNote {
                Text(verbatim: newAgentNote)
                    .font(.system(size: 11))
                    .foregroundColor(ReviewPalette.modified)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.leading, 23)
            }
        }
    }

    private func targetRow<Content: View>(id: String, selected: Bool, @ViewBuilder content: () -> Content) -> some View {
        Button { choice = id } label: {
            HStack(spacing: 7) {
                Image(systemName: selected ? "largecircle.fill.circle" : "circle")
                    .font(.system(size: 12))
                    .foregroundColor(selected ? ReviewPalette.renamed : ReviewPalette.dim)
                content()
            }
            .padding(.horizontal, 6)
            .frame(height: 26)
            .contentShape(Rectangle())
        }
        .buttonStyle(.genHoverRow())
    }

    private func loadPlan() async {
        let args = argv(nil, true, true)
        let span = HubPerf.begin("\(perfArea).plan", what, awaits: true)
        let result = await Task.detached(priority: .userInitiated) { Result { try FixThreadsCLI.run(args) } }.value
        switch result {
        case .success(let found):
            span.end("\(found.candidates.count) candidates, owner \(found.owner?.sessionId.prefix(8) ?? "none")")
            plan = found
            choice = found.owner?.live == true ? found.owner?.sessionId : (found.candidates.first { $0.live }?.sessionId ?? Self.newAgent)
        case .failure(let error):
            span.end("failed")
            planError = "\(error)"
            choice = Self.newAgent
        }
    }

    private func send() {
        guard let choice else { return }
        let newAgent = choice == Self.newAgent
        let args = argv(newAgent ? nil : choice, !newAgent, false)
        let name = plan?.candidates.first { $0.sessionId == choice }?.displayTitle ?? String(choice.prefix(8))
        let what = what
        sending = true
        Task {
            let span = HubPerf.begin("\(perfArea).send", newAgent ? "new agent" : String(choice.prefix(8)), awaits: true)
            let result = await Task.detached(priority: .userInitiated) { Result { try FixThreadsCLI.run(args) } }.value
            sending = false
            switch result {
            case .success(let done) where newAgent:
                span.end("file written")
                newAgentPrompt = done.prompt
            case .success(let done) where done.sent:
                span.end(done.focused ? "sent, focused" : "sent")
                finished(done.focused
                    ? "Sent \(what) to \(name); its cmux pane has the focus."
                    : "Sent \(what) to \(name). \(done.error ?? "")", true)
                close()
            case .success(let done):
                span.end("not sent")
                finished("Failed: \(done.error ?? "the send did not happen"). The task is in \(done.file).", false)
                close()
            case .failure(let error):
                span.end("failed")
                finished("Failed: \(error)", false)
                close()
            }
        }
    }
}
