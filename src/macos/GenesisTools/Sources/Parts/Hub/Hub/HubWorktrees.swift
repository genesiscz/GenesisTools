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

    /// The folder name without the repository's name in front: in the `web-app` group, `web-app-pr-123-b1` reads
    /// `pr-123-b1`. The group header already names the repository, and sibling folders differ only after it.
    var shortName: String {
        guard !isMain, name.count > repo.count + 1, name.lowercased().hasPrefix(repo.lowercased()) else { return name }
        let rest = name.dropFirst(repo.count)
        guard let separator = rest.first, "-_.".contains(separator) else { return name }
        return String(rest.dropFirst())
    }
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

    /// Repositories the person added by hand ("Add repository…"): listed whether or not a session worked there.
    static let addedReposKey = "worktrees.addedRepos"

    static var addedRepos: [String] {
        HubDefaults.store.stringArray(forKey: addedReposKey) ?? []
    }

    static func addRepo(_ path: String) {
        HubDefaults.store.set(Array(Set(addedRepos + [path])).sorted(), forKey: addedReposKey)
    }

    static func removeRepo(_ path: String) {
        HubDefaults.store.set(addedRepos.filter { $0 != path }, forKey: addedReposKey)
    }

    /// The git roots each session's shell commands worked in, as the Bash hook recorded them
    /// (`<temp>/GenesisTools/ai/hooks/mentions/<session>.json`, `roots`). A session started in one repository often
    /// works in another by `cd` (an app session that also builds its backend): its folder alone missed that repository.
    static func hookRoots(of sessions: [HubSession]) -> [String] {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("GenesisTools/ai/hooks/mentions", isDirectory: true)
        var roots = Set<String>()
        for id in Set(sessions.map(\.sessionId)) where !id.isEmpty && !id.contains("/") {
            guard let data = try? Data(contentsOf: dir.appendingPathComponent("\(id).json")),
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let list = object["roots"] as? [String]
            else { continue }
            roots.formUnion(list)
        }
        return roots.sorted()
    }

    /// One `git worktree list` per repository, found from the distinct session folders, the roots their shell
    /// commands worked in, the repositories added by hand, and `extra` folders (a worktree a link names).
    static func discover(sessions: [HubSession], extra: [String] = []) -> [HubWorktree] {
        var seenCommonDirs = Set<String>()
        var worktrees: [HubWorktree] = []
        let folders = Set(sessions.map(\.cwd)).union(hookRoots(of: sessions)).union(addedRepos).union(extra)
        for cwd in folders.sorted() where !cwd.isEmpty && FileManager.default.fileExists(atPath: cwd) {
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

    /// `git -C cwd args`'s stdout, nil when it fails. Blocks, so off the main thread.
    static func git(_ cwd: String, _ args: [String]) -> String? {
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
        CmuxCommandRunner.resumeCommand(provider: session.provider, sessionId: session.sessionId)
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
        try output(of: capture(args), args)
    }

    /// A capture's stdout, or the error `run` throws for a nonzero exit.
    static func output(of result: ProcessCapture, _ args: [String]) throws -> Data {
        if result.status != 0 {
            let message = String(decoding: result.stderr, as: UTF8.self)
            throw ReviewError.git("tools \(args.first ?? "") exited \(result.status): \(message.trimmed.suffix(300))")
        }

        return result.stdout
    }

    /// "tools question inbox send exited 1: <stderr>": the raw detail behind a failed call's Details.
    static func exitDetail(_ capture: ProcessCapture, _ args: [String]) -> String {
        "tools \(args.prefix(3).joined(separator: " ")) exited \(capture.status): \(String(decoding: capture.stderr, as: UTF8.self).trimmed)"
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
                return serverCapture(result, args, traceId: traceId, started: started, since: start)
            }
        }

        return try processCapture(args, timeout: timeout, traceId: traceId, started: started)
    }

    /// A server door's answer as a capture, with its perf span and its trace line.
    private static func serverCapture(_ result: ToolsRunResult, _ args: [String], traceId: String, started: Date,
                                      since start: CFAbsoluteTime) -> ProcessCapture {
        PerfLog.since("hub.srv.\(args.prefix(3).joined(separator: "."))", start)
        ToolsCallTrace.record(
            traceId: traceId, via: "server", argv: args, started: started,
            exit: result.exitCode, outBytes: result.stdout.utf8.count, stderr: result.stderr
        )
        return ProcessCapture(status: result.exitCode, stdout: Data(result.stdout.utf8), stderr: Data(result.stderr.utf8))
    }

    /// `capture` that its task can stop: a server call is cancelled there, and a running process is terminated (the
    /// `tools` wrapper passes the signal to the tool). A cancelled task throws `CancellationError`, never a capture.
    static func captureCancellable(_ args: [String], timeout: TimeInterval = 60) async throws -> ProcessCapture {
        let run = try await captureStoppable(args, timeout: timeout)
        try Task.checkCancellation()
        return run.capture
    }

    /// `capture` for work a stop may come too late for (F19's send). A cancel of the calling task before the child
    /// starts throws `CancellationError`; a cancel while it runs terminates it, waits for its end and returns what it
    /// printed, with `stopped` set. The tool decides what the stop undoes: a widget send honors it only before it
    /// writes (`cancelPoint`, src/hub/lib/widget/staged.ts), so a send that already typed finishes and says so.
    /// A server door is one idempotent write, so a cancel there only stops the wait for its answer.
    static func captureStoppable(_ args: [String], timeout: TimeInterval = 60) async throws -> (capture: ProcessCapture, stopped: Bool) {
        let traceId = ToolsCallTrace.newId()
        let started = Date()
        if let server = HubSource.server {
            let start = CFAbsoluteTimeGetCurrent()
            let result = await server.call(argv: args, timeoutSeconds: Int(timeout), traceId: traceId)
            try Task.checkCancellation()
            if let result {
                return (serverCapture(result, args, traceId: traceId, started: started, since: start), false)
            }
        }

        try Task.checkCancellation()
        let run = try await runStoppable { handle in
            try processCapture(args, timeout: timeout, traceId: traceId, started: started, handle: handle)
        }
        return (run.value, run.stopped)
    }

    /// Runs `work` off the main thread; a cancel of the calling task stops the process `work` hands its handle,
    /// and the call throws `CancellationError` once `work` returned.
    static func runCancellable<T: Sendable>(_ work: @escaping @Sendable (ProcessCancelHandle) throws -> T) async throws -> T {
        let run = try await runStoppable(work)
        try Task.checkCancellation()
        return run.value
    }

    /// `runCancellable` that returns what `work` returned also after a cancel: `stopped` says a cancel came.
    static func runStoppable<T: Sendable>(
        _ work: @escaping @Sendable (ProcessCancelHandle) throws -> T
    ) async throws -> (value: T, stopped: Bool) {
        let handle = ProcessCancelHandle()
        let value = try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<T, Error>) in
                DispatchQueue.global(qos: .userInitiated).async {
                    continuation.resume(with: Result { try work(handle) })
                }
            }
        } onCancel: {
            handle.cancel()
        }
        return (value, handle.cancelled)
    }

    private static func processCapture(_ args: [String], timeout: TimeInterval, traceId: String, started: Date,
                                       handle: ProcessCancelHandle? = nil) throws -> ProcessCapture {
        let span = HubPerf.begin("tools.\(args.prefix(3).joined(separator: "."))")
        defer { span.end() }
        // Said plainly, as ToolsBridge.run says it: a missing path reached the hub as Cocoa's "The file tools doesn't exist".
        let binary = HubSource.bridge.binaryPath
        guard ToolsBridge.isExecutableFile(binary) else { throw ToolsBridgeError.binaryNotFound(binary) }
        let process = Process()
        let plan = ToolsBridge.launchPlan(binaryPath: binary, argv: args)
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
            let capture = try process.runCapturing(timeout: timeout, afterStart: handle.map { handle in { handle.adopt(process) } })
            ToolsCallTrace.record(
                traceId: traceId, via: handle?.cancelled == true ? "process-cancelled" : "process", argv: args, started: started,
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

/// The running child of a cancellable capture. A cancel before the child started terminates it as soon as it does.
final class ProcessCancelHandle: @unchecked Sendable {
    private let lock = NSLock()
    private var process: Process?
    private var _cancelled = false

    var cancelled: Bool { lock.withLock { _cancelled } }

    func adopt(_ process: Process) {
        let stop = lock.withLock { () -> Bool in
            self.process = process
            return _cancelled
        }
        if stop { process.terminate() }
    }

    func cancel() {
        let running = lock.withLock { () -> Process? in
            _cancelled = true
            return process
        }
        if let running, running.isRunning { running.terminate() }
    }
}

// MARK: - Views

struct WorktreeListView: View {
    var model: HubModel
    @StateObject private var prefs = GroupPrefs(key: "worktrees.repos")

    private var groups: [(repo: String, rows: [HubWorktree])] {
        let needle = model.filter.trimmed.lowercased()
        let rows = model.worktrees.filter { needle.isEmpty || "\($0.repo) \($0.branch) \($0.path)".lowercased().contains(needle) }
        let grouped = Dictionary(grouping: rows, by: \.repo)
        return prefs.sorted(Array(grouped.keys)).map { ($0, grouped[$0] ?? []) }
    }

    /// The hand-added folder that brought this repository in, when one did: its header can hide it again.
    private func addedRepo(of rows: [HubWorktree]) -> String? {
        WorktreeDiscovery.addedRepos.first { added in
            rows.contains { added == $0.path || added.hasPrefix("\($0.path)/") }
        }
    }

    var body: some View {
        let _ = RenderProbe.hit("worktrees.list.body")
        let groups = groups
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 2, pinnedViews: [.sectionHeaders]) {
                    if model.loadingWorktrees, model.worktrees.isEmpty {
                        SkeletonRows(count: 8, leading: .dot)
                            .skeletonShimmer()
                            .accessibilityElement(children: .ignore)
                            .accessibilityLabel("Finding worktrees")
                    } else if !model.worktrees.isEmpty {
                        WorktreeCleanupEntry(model: model)
                    }
                    if !model.loadingWorktrees || !model.worktrees.isEmpty {
                        AddRepositoryEntry(model: model)
                    }
                    ForEach(groups, id: \.repo) { group in
                        Section {
                            if !prefs.collapsed.contains(group.repo) {
                                ForEach(group.rows) { worktree in
                                    WorktreeRow(
                                        worktree: worktree,
                                        count: model.sessionCount(for: worktree),
                                        selected: model.selectedWorktree == worktree.path,
                                        select: { model.selectWorktree(worktree) }
                                    )
                                    .equatable()
                                    .id(worktree.path)
                                }
                            }
                        } header: {
                            GroupHeader(
                                title: group.repo,
                                count: group.rows.count,
                                prefs: prefs,
                                allNames: groups.map(\.repo),
                                path: (group.rows.first { $0.isMain } ?? group.rows.first)?.path,
                                remove: addedRepo(of: group.rows).map { added in
                                    {
                                        WorktreeDiscovery.removeRepo(added)
                                        model.worktrees.removeAll { $0.commonDir == group.rows.first?.commonDir }
                                    }
                                }
                            )
                        }
                    }
                }
                .padding(.bottom, 12)
                .genScrollBars()
            }
            .modifier(SidebarReveal(
                proxy: proxy,
                selection: model.selectedWorktree,
                group: groups.first { $0.rows.contains { $0.path == model.selectedWorktree } }?.repo,
                loaded: !model.worktrees.isEmpty,
                prefs: prefs
            ))
        }
    }
}

/// One worktree of the sidebar, from values. Live (`liveRow`: the row button with its hover fill, the tooltips) while
/// the pointer is on it or it is selected; at rest it draws the same labels with no control, so an accessibility
/// client's responder walk no longer visits 38 rows of button, tooltips and count badge per changed node
/// (`mode.worktrees` 253 ms per switch, 2026-10-29). VoiceOver still presses it (the resting `rowButton`).
struct WorktreeRow: View, Equatable {
    let worktree: HubWorktree
    /// Agent sessions that worked in the folder.
    let count: Int
    let selected: Bool
    let select: () -> Void

    static func == (a: WorktreeRow, b: WorktreeRow) -> Bool {
        a.worktree == b.worktree && a.count == b.count && a.selected == b.selected
    }

    var body: some View {
        let _ = RenderProbe.hit("worktrees.row.body")
        HStack(spacing: 8) {
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
                // Siblings share the repository prefix and often a ticket prefix: cut in the middle, so the ending
                // that tells two checkouts apart stays.
                Text(worktree.shortName)
                    .font(.system(size: 11))
                    .foregroundColor(ReviewPalette.dim)
                    .lineLimit(1)
                    .truncationMode(.middle)
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
        .rowButton { select() }
        .accessibilityLabel(Text(verbatim: count > 0
            ? "\(worktree.branch), \(worktree.name), \(count) agent sessions worked here"
            : "\(worktree.branch), \(worktree.name)"))
        // The branch and the folder truncate in the row; the tooltip and the menu carry them whole.
        .instantTooltip("\(worktree.branch)\n\(PathLabel.display(worktree.path))")
        .liveRow(selected: selected)
        .contextMenu {
            Button("Copy branch") { PathOpener.copy(worktree.branch, what: "branch") }
            Divider()
            PathActionsMenu(path: worktree.path)
        }
    }
}

struct WorktreeDetailView: View {
    var model: HubModel
    @ObservedObject private var repos = RepoFactsStore.shared
    let worktree: HubWorktree
    @State private var launchingNew = false

    var body: some View {
        let _ = RenderProbe.hit("worktrees.detail.body")
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
                // One button for the sessions that worked here, with search inside: a sideways strip of 156 chips
                // ran off the edge and hid all but a handful (UX pass 2026-11-09, C30).
                HStack(spacing: 12) {
                    PathLabel(path: worktree.path)
                    if !touching.isEmpty {
                        // A search typed for one worktree does not follow the reader to the next one.
                        WorktreeSessionsButton(model: model, sessions: touching)
                            .id(worktree.path)
                    }
                    Spacer(minLength: 0)
                }
            }

            if let review = model.review(showing: worktree) {
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
        // The branch's MR target is the base its commits count from, also for a review made after the facts arrived.
        .onChange(of: [facts?.pr?.target ?? "", model.review.map { "\(ObjectIdentifier($0))" } ?? ""], initial: true) { _, _ in
            model.review(showing: worktree)?.useBranchTarget(facts?.pr?.target)
        }
        // `--worktree <path>` and a forwarded request set the selection without a click, so nothing made
        // the review: the page showed its header and nothing else.
        .task(id: worktree.path) {
            if model.review?.home.path != worktree.path {
                model.selectWorktree(worktree)
            }
        }
    }
}

/// "156 sessions": the agent sessions that worked in a worktree, in a popover with search. Each row opens the session
/// or resumes it; Resume shows the cmux target picker in the same popover.
struct WorktreeSessionsButton: View {
    var model: HubModel
    let sessions: [HubSession]
    @State private var open = false
    /// Kept here, so a search typed and dismissed by an outside click is still there when the list opens again.
    @State private var query = ""

    var body: some View {
        GhostButton(
            Plural.count(sessions.count, "session"), symbol: "bubble.left.and.bubble.right",
            tooltip: "Agent sessions that worked in this worktree: search them, open one or resume it",
            trailingSymbol: "chevron.down", height: 22
        ) { open.toggle() }
        .popover(isPresented: $open, arrowEdge: .bottom) {
            WorktreeSessionsList(model: model, sessions: sessions, query: $query) { open = false }
        }
    }
}

struct WorktreeSessionsList: View {
    var model: HubModel
    let sessions: [HubSession]
    @Binding var query: String
    let close: () -> Void
    @State private var resuming: HubSession?
    @FocusState private var focused: Bool

    static let rowHeight: CGFloat = 30

    /// The sessions whose title, agent, branch or id holds every word of the search, newest first as the hub lists them.
    private var shown: [HubSession] {
        let words = query.lowercased().split(whereSeparator: \.isWhitespace)
        guard !words.isEmpty else { return sessions }
        return sessions.filter { session in
            let text = "\(session.displayTitle) \(session.provider) \(session.gitBranch ?? "") \(session.sessionId)".lowercased()
            return words.allSatisfy { text.contains($0) }
        }
    }

    var body: some View {
        if let resuming {
            VStack(alignment: .leading, spacing: 4) {
                Button {
                    self.resuming = nil
                } label: {
                    Label("All sessions", systemImage: "chevron.left").font(.system(size: 11.5))
                }
                .buttonStyle(.genHoverPlain())
                .padding(.horizontal, 12)
                .padding(.top, 10)
                .instantTooltip("Back to the list of this worktree's sessions")
                LaunchPicker(mode: .resume(resuming)) { outcome in
                    if let notice = outcome.notice { model.notice = notice }
                    close()
                }
            }
        } else {
            list
        }
    }

    private var list: some View {
        let shown = shown
        return VStack(spacing: 0) {
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass").font(.system(size: 11)).foregroundColor(ReviewPalette.dim)
                TextField(Plural.count(sessions.count, "session") + ": filter by title, agent or branch", text: $query)
                    .textFieldStyle(.plain)
                    .font(.system(size: 12.5))
                    .focused($focused)
                    .onSubmit { if let first = shown.first { open(first) } }
                    .accessibilityLabel("Filter the sessions")
                if !query.isEmpty {
                    IconButton(systemName: "xmark.circle.fill", tooltip: "Clear the filter", size: 10) { query = "" }
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .contentShape(Rectangle())
            .onTapGesture { focused = true }
            Divider()
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if shown.isEmpty {
                        Text(verbatim: "No session matches “\(query.trimmingCharacters(in: .whitespaces))”.")
                            .font(.system(size: 12))
                            .foregroundColor(ReviewPalette.dim)
                            .padding(12)
                    }
                    ForEach(shown) { session in
                        row(session)
                    }
                }
                .padding(.vertical, 4)
                .scrollOverflowContent()
                .genScrollBars()
            }
            .scrollOverflowHints(.vertical)
            .frame(height: min(CGFloat(max(shown.count, 1)) * Self.rowHeight + 8, 420))
        }
        .frame(width: 480)
        .onAppear { focused = true }
    }

    private func row(_ session: HubSession) -> some View {
        HStack(spacing: 8) {
            ProviderBadge(provider: session.provider, size: 15)
            Text(verbatim: session.displayTitle)
                .font(.system(size: 12))
                .foregroundColor(Color.white.opacity(0.88))
                .lineLimit(1)
                .truncationMode(.tail)
                .help(session.displayTitle)
            Spacer(minLength: 6)
            LiveAgo(date: session.lastActivity, style: .brief)
                .font(.system(size: 11))
                .foregroundColor(ReviewPalette.dim)
            Button("Open") { open(session) }
                .accessibilityLabel("Open \(session.displayTitle)")
            Button("Resume") { resuming = session }
                .accessibilityLabel("Resume \(session.displayTitle) in cmux")
        }
        .font(.system(size: 11.5))
        .buttonStyle(.genHoverPlain())
        .padding(.horizontal, 12)
        .frame(height: Self.rowHeight)
    }

    private func open(_ session: HubSession) {
        close()
        model.openSession(session)
    }
}

/// "Add repository…": a folder picker for a repository no listed session worked in. The choice is kept
/// (`WorktreeDiscovery.addedRepos`) and its worktrees join the list at once; the repository header's hide button drops it.
struct AddRepositoryEntry: View {
    var model: HubModel

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "plus")
                .font(.system(size: 11))
                .foregroundColor(ReviewPalette.dim)
                .frame(width: 16)
            Text("Add repository…")
                .font(.system(size: 12.5))
                .foregroundColor(ReviewPalette.dim)
            Spacer(minLength: 4)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .padding(.horizontal, 6)
        .contentShape(Rectangle())
        .rowButton { pick() }
        .instantTooltip("List a repository's worktrees here although no recent session worked in it")
    }

    @MainActor
    private func pick() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.prompt = "Add"
        panel.message = "A folder inside a git repository"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        WorktreeDiscovery.addRepo(url.path)
        model.addWorktreesIfMissing(url.path, intoEmptyList: true)
    }
}
