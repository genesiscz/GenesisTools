import AppKit
import Foundation
import SwiftUI

// Hub "Worktrees" mode: the repositories the recent sessions worked in, one row per worktree
// (branch), with the sessions that touched it. From a worktree you see its changes (default scope:
// the whole branch) and can resume one of its sessions or start a new one in cmux.

struct HubWorktree: Identifiable, Hashable, Codable {
    var id: String { path }
    var path: String
    /// The folder name of the repository, for display. Two unrelated clones can share it.
    var repo: String
    /// The repository's absolute common git dir: one per repository, shared by all its worktrees.
    var commonDir: String
    var branch: String
    var isMain: Bool

    var name: String { (path as NSString).lastPathComponent }
}

enum WorktreeDiscovery {
    /// The last discovery (Hub/HubSWR.swift): the Worktrees mode paints it while `discover` runs again.
    /// Blocking file reads and writes: off the main thread.
    private static let cache = HubSWR.cache("worktrees")

    static func cached() -> [HubWorktree]? {
        // A worktree removed since then is not painted, even for the moment until the fresh list lands.
        cache.read([HubWorktree].self, key: "all")?.filter { FileManager.default.fileExists(atPath: $0.path) }
    }

    static func save(_ worktrees: [HubWorktree]) {
        cache.write(worktrees, key: "all")
    }

    /// One `git worktree list` per repository, found from the distinct session folders.
    static func discover(sessions: [HubSession]) -> [HubWorktree] {
        var seenCommonDirs = Set<String>()
        var worktrees: [HubWorktree] = []
        for cwd in Set(sessions.map(\.cwd)) where !cwd.isEmpty && FileManager.default.fileExists(atPath: cwd) {
            guard let common = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])?.trimmed,
                  seenCommonDirs.insert(common).inserted,
                  let list = git(cwd, ["worktree", "list", "--porcelain"])
            else { continue }

            let repo = (((common as NSString).deletingLastPathComponent) as NSString).lastPathComponent
            var first = true
            for block in list.components(separatedBy: "\n\n") where !block.trimmed.isEmpty {
                var path = ""
                var branch = "(detached)"
                for line in block.split(separator: "\n") {
                    if line.hasPrefix("worktree ") {
                        path = String(line.dropFirst(9))
                    } else if line.hasPrefix("branch ") {
                        branch = String(line.dropFirst(7)).replacingOccurrences(of: "refs/heads/", with: "")
                    }
                }
                if !path.isEmpty, FileManager.default.fileExists(atPath: path) {
                    worktrees.append(HubWorktree(path: path, repo: repo, commonDir: common, branch: branch, isMain: first))
                }
                first = false
            }
        }

        return worktrees
    }

    /// The sessions that touched each worktree, keyed by worktree path. A session touched the deepest
    /// worktree containing its folder (worktrees nest under the main checkout), and also every
    /// worktree of the same repository that has the branch the transcript recorded: work on a branch
    /// often starts in the main checkout before the branch gets its own worktree.
    static func sessionsByWorktree(_ sessions: [HubSession], worktrees: [HubWorktree]) -> [String: [HubSession]] {
        // Keyed on the common git dir, not the folder name: two unrelated clones called `app` on the
        // same branch would otherwise share each other's sessions.
        var byBranch: [String: [HubWorktree]] = [:]
        for worktree in worktrees {
            byBranch["\(worktree.commonDir)\u{1f}\(worktree.branch)", default: []].append(worktree)
        }
        var result: [String: [HubSession]] = [:]
        for session in sessions {
            guard let owner = containing(session.cwd, in: worktrees).max(by: { $0.path.count < $1.path.count }) else { continue }
            var touched: Set<String> = [owner.path]
            if let branch = session.gitBranch, !branch.isEmpty {
                for match in byBranch["\(owner.commonDir)\u{1f}\(branch)"] ?? [] {
                    touched.insert(match.path)
                }
            }
            for path in touched {
                result[path, default: []].append(session)
            }
        }
        return result
    }

    private static func containing(_ cwd: String, in all: [HubWorktree]) -> [HubWorktree] {
        all.filter { cwd == $0.path || cwd.hasPrefix($0.path + "/") }
    }

    private static func git(_ cwd: String, _ args: [String]) -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        process.arguments = ["-C", cwd] + args
        let out = Pipe()
        process.standardOutput = out
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
        } catch {
            return nil
        }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return process.terminationStatus == 0 ? String(decoding: data, as: UTF8.self) : nil
    }
}

// MARK: - Launching sessions in cmux

enum AgentLauncher {
    static func resumeCommand(for session: HubSession) -> [String]? {
        switch session.provider {
        case "claude": return ["tools", "claude", "resume", session.sessionId]
        case "codex": return ["codex", "resume", session.sessionId]
        case "grok": return ["grok", "--resume", session.sessionId]
        default: return nil
        }
    }

    /// Runs `command` in `cwd` in a new workspace of the current terminal host (cmux today, see
    /// `TerminalHosts`). Blocking: it spawns the host's CLI.
    static func openInTerminal(name: String, cwd: String, command: [String]) -> String? {
        TerminalHosts.current.open(.command(command, cwd: cwd, name: name), at: .newWorkspace(window: nil))
    }
}

// MARK: - json2md export

/// "Copy as Markdown": the view's data as JSON through `tools json2md`, so every report in the hub
/// (session, worktree, decisions, review comments) is rendered by the one markdown renderer the
/// CLI and the agents use. The result goes to the clipboard and to a file opened in Genesis Markdown.
enum HubMarkdownExport {
    /// The files and the `tools json2md` run (up to 60 s) happen off the main actor, so the hub keeps
    /// drawing; only the pasteboard and the open call come back to it.
    @MainActor
    static func export(title: String, payload: [String: Any], fileStem: String) async -> String {
        guard JSONSerialization.isValidJSONObject(payload),
              let json = try? JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
        else { return "Could not build the JSON for json2md." }

        let dir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".genesis-tools/hub/exports", isDirectory: true)
        let input = dir.appendingPathComponent("\(fileStem).json")
        let output = dir.appendingPathComponent("\(fileStem).md")
        do {
            let markdown = try await Task.detached(priority: .userInitiated) { () throws -> Data in
                try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
                try json.write(to: input, options: .atomic)
                let markdown = try ToolsCLIRunner.run(["json2md", input.path, "--title", title])
                try markdown.write(to: output, options: .atomic)
                return markdown
            }.value
            PathOpener.copy(String(decoding: markdown, as: UTF8.self), what: "markdown")
            let encoded = output.path.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? output.path
            if let url = URL(string: "genesis-md://open?path=\(encoded)") {
                NSWorkspace.shared.open(url)
            }
            return "Markdown copied and opened: \(output.path)"
        } catch {
            return "json2md failed: \(error)"
        }
    }
}

/// Synchronous `tools` runner (argv, no shell) for small one-shot calls from button actions.
/// A child still running after `runCapturing`'s 60 s default is killed, and the call throws.
enum ToolsCLIRunner {
    static func run(_ args: [String]) throws -> Data {
        let result = try capture(args)
        if result.status != 0 {
            let message = String(decoding: result.stderr, as: UTF8.self)
            throw ReviewError.git("tools \(args.first ?? "") exited \(result.status): \(message.trimmed.suffix(300))")
        }

        return result.stdout
    }

    /// The exit status and both streams, for verbs that print a JSON error on stdout when they
    /// fail (`tools hub pr … --json` prints `{error, code}` and exits 1).
    static func capture(_ args: [String], timeout: TimeInterval = 60) throws -> ProcessCapture {
        // The resident hub server first (src/hub/server): no process when it has a door for this argv.
        // Its span is `srv.…`, so app-perf.log shows which path answered.
        let traceId = ToolsCallTrace.newId()
        let started = Date()
        if let server = HubSource.server {
            let start = CFAbsoluteTimeGetCurrent()
            if let result = server.callSync(argv: args, timeout: timeout, traceId: traceId) {
                PerfLog.since("hub.srv.\(args.prefix(3).joined(separator: "."))", start)
                ToolsCallTrace.record(
                    traceId: traceId, via: "server", argv: args, started: started,
                    exit: result.exitCode, outBytes: result.stdout.utf8.count, stderr: result.stderr
                )
                return ProcessCapture(status: result.exitCode, stdout: Data(result.stdout.utf8), stderr: Data(result.stderr.utf8))
            }
        }

        let span = HubPerf.begin("tools.\(args.prefix(3).joined(separator: "."))")
        defer { span.end() }
        let process = Process()
        let plan = ToolsBridge.launchPlan(binaryPath: HubSource.bridge.binaryPath, argv: args)
        process.executableURL = plan.executable
        process.currentDirectoryURL = plan.workingDirectory
        process.arguments = plan.arguments
        process.standardInput = FileHandle.nullDevice
        var environment = ProcessInfo.processInfo.environment
        environment[ToolsCallTrace.environmentKey] = traceId
        if args.prefix(2) == ["hub", "pr"] {
            // Every `tools hub pr` phase, child process, forge request and cache lookup goes to
            // <date>-profiling.log with this call's trace id (scopes: src/utils/profile/scopes.ts).
            environment["PROFILE"] = "hub-pr,spawn,forge-http,cache"
            environment["PROFILE_TO_STDERR"] = "0"
        }
        process.environment = environment
        do {
            let capture = try process.runCapturing(timeout: timeout)
            ToolsCallTrace.record(
                traceId: traceId, via: "process", argv: args, started: started,
                exit: capture.status, outBytes: capture.stdout.count, stderr: String(decoding: capture.stderr.suffix(400), as: UTF8.self)
            )
            return capture
        } catch let timeout as ProcessTimeout {
            ToolsCallTrace.record(
                traceId: traceId, via: "process-timeout", argv: args, started: started, exit: -1, outBytes: 0, stderr: ""
            )
            throw ReviewError.git("tools \(args.prefix(3).joined(separator: " ")) did not exit within \(Int(timeout.seconds)) s and was killed")
        }
    }
}

// MARK: - Views

struct WorktreeListView: View {
    @ObservedObject var model: HubModel
    @StateObject private var prefs = GroupPrefs(key: "worktrees.repos")

    private var groups: [(repo: String, rows: [HubWorktree])] {
        let needle = model.filter.trimmed.lowercased()
        let rows = model.worktrees.filter { needle.isEmpty || "\($0.repo) \($0.branch) \($0.path)".lowercased().contains(needle) }
        let grouped = Dictionary(grouping: rows, by: \.repo)
        return prefs.sorted(Array(grouped.keys)).map { ($0, grouped[$0] ?? []) }
    }

    var body: some View {
        let groups = groups
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 2, pinnedViews: [.sectionHeaders]) {
                if model.loadingWorktrees {
                    ProgressView().frame(maxWidth: .infinity).padding()
                } else if !model.worktrees.isEmpty {
                    WorktreeCleanupEntry(model: model)
                }
                ForEach(groups, id: \.repo) { group in
                    Section {
                        if !prefs.collapsed.contains(group.repo) {
                            ForEach(group.rows) { worktree in
                                row(worktree)
                            }
                        }
                    } header: {
                        GroupHeader(
                            title: group.repo,
                            count: group.rows.count,
                            prefs: prefs,
                            allNames: groups.map(\.repo),
                            path: (group.rows.first { $0.isMain } ?? group.rows.first)?.path
                        )
                    }
                }
            }
            .padding(.bottom, 12)
        }
    }

    private func row(_ worktree: HubWorktree) -> some View {
        let count = model.sessionCount(for: worktree)
        let selected = model.selectedWorktree == worktree.path
        return HStack(spacing: 8) {
            Image(systemName: worktree.isMain ? "house" : "arrow.triangle.branch")
                .font(.system(size: 11))
                .foregroundColor(ReviewPalette.dim)
                .frame(width: 16)
                .instantTooltip(worktree.isMain ? "Main checkout" : "Linked worktree")
            VStack(alignment: .leading, spacing: 2) {
                Text(worktree.branch)
                    .font(.system(size: 12.5, weight: selected ? .semibold : .regular))
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text(worktree.name)
                    .font(.system(size: 10.5))
                    .foregroundColor(ReviewPalette.dim)
                    .lineLimit(1)
            }
            Spacer(minLength: 4)
            if count > 0 {
                CountBadge(count, tooltip: "\(count) agent sessions worked here")
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(RoundedRectangle(cornerRadius: 8).fill(selected ? Color.white.opacity(0.08) : Color.clear))
        .padding(.horizontal, 6)
        .contentShape(Rectangle())
        .rowButton { model.selectWorktree(worktree) }
        // The branch and the folder truncate in the row; the tooltip and the menu carry them whole.
        .instantTooltip("\(worktree.branch)\n\(PathLabel.display(worktree.path))")
        .contextMenu {
            Button("Copy branch") { PathOpener.copy(worktree.branch, what: "branch") }
            Divider()
            PathActionsMenu(path: worktree.path)
        }
    }
}

struct WorktreeDetailView: View {
    @ObservedObject var model: HubModel
    @ObservedObject private var repos = RepoFactsStore.shared
    let worktree: HubWorktree
    @State private var launchingNew = false
    @State private var resuming: HubSession?

    var body: some View {
        let touching = model.sessions(for: worktree)
        let facts = repos.facts(for: worktree.path, pr: true)
        VStack(spacing: 0) {
            TitlebarHeader {
                HStack(spacing: 10) {
                    Image(systemName: "arrow.triangle.branch").foregroundColor(ReviewPalette.dim)
                    ExternalLink(
                        text: worktree.branch,
                        url: facts?.branchURL,
                        font: .system(size: 15, weight: .semibold),
                        color: Color.white.opacity(0.92)
                    )
                    CompareLink(facts: facts)
                    ExternalLink(text: worktree.repo, url: facts?.webURL)
                    PullRequestLink(facts: facts)
                    Spacer()
                    if let notice = model.notice {
                        NoticePill(text: notice, isError: notice.hasPrefix("cmux:")) { model.notice = nil }
                    }
                    Button {
                        launchingNew = true
                    } label: {
                        Label("New session here", systemImage: "plus.bubble")
                    }
                    .instantTooltip("Start Claude, Codex or Grok in this worktree; pick the cmux target first")
                    .popover(isPresented: $launchingNew, arrowEdge: .bottom) {
                        LaunchPicker(mode: .new(cwd: worktree.path, name: worktree.branch)) { outcome in
                            launchingNew = false
                            if let notice = outcome.notice { model.notice = notice }
                        }
                    }
                    IconButton(systemName: "doc.richtext", tooltip: "Copy as Markdown (json2md): branch, changed files, sessions") {
                        Task { @MainActor in model.notice = await model.exportWorktree(worktree) }
                    }
                }
                .buttonStyle(.genHoverPlain())
            } details: {
                VStack(alignment: .leading, spacing: 8) {
                    PathLabel(path: worktree.path)
                    if !touching.isEmpty {
                        // The chips scroll sideways with no indicator, so the count says how many there
                        // are: the row used to end in a cut "Open R" with nothing to say 30 more followed.
                        HStack(spacing: 8) {
                            Text(verbatim: "\(touching.count) session\(touching.count == 1 ? "" : "s")")
                                .font(.system(size: 11))
                                .foregroundColor(ReviewPalette.dim)
                                .fixedSize()
                                .instantTooltip("Agent sessions that worked in this worktree; the row scrolls sideways")
                            ScrollView(.horizontal, showsIndicators: false) {
                                HStack(spacing: 6) {
                                    ForEach(touching) { session in
                                        sessionChip(session)
                                    }
                                }
                            }
                        }
                    }
                }
            }

            if let review = model.review, review.repo.path == worktree.path {
                ReviewRootView(model: review)
            } else {
                Text("Loading the worktree's changes…")
                    .font(.system(size: 12))
                    .foregroundColor(ReviewPalette.dim)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        // Without a diff under it the header floated to the middle of the window.
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        // `--worktree <path>` and a forwarded request set the selection without a click, so nothing made
        // the review: the page showed its header and nothing else.
        .task(id: worktree.path) {
            if model.review?.repo.path != worktree.path {
                model.selectWorktree(worktree)
            }
        }
    }

    private func sessionChip(_ session: HubSession) -> some View {
        HStack(spacing: 6) {
            ProviderBadge(provider: session.provider, size: 15)
            Text(session.displayTitle).lineLimit(1).frame(maxWidth: 220, alignment: .leading)
            LiveAgo(date: session.lastActivity).foregroundColor(ReviewPalette.dim)
            Button("Open") { model.openSession(session) }
                .instantTooltip("Show this session's transcript, changes and decisions")
            Button("Resume") { resuming = session }
                .instantTooltip("Resume it in cmux; pick where first")
        }
        .font(.system(size: 11.5))
        .buttonStyle(.genHoverPlain())
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(RoundedRectangle(cornerRadius: 7).fill(Color.white.opacity(0.05)))
        .popover(isPresented: Binding(get: { resuming?.id == session.id }, set: { if !$0 { resuming = nil } }), arrowEdge: .bottom) {
            LaunchPicker(mode: .resume(session)) { outcome in
                resuming = nil
                if let notice = outcome.notice { model.notice = notice }
            }
        }
    }
}
