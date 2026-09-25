import AppKit
import Foundation
import SwiftUI

// Hub "Worktrees" mode: the repositories the recent sessions worked in, one row per worktree
// (branch), with the sessions that touched it. From a worktree you see its changes (default scope:
// the whole branch) and can resume one of its sessions or start a new one in cmux.

struct HubWorktree: Identifiable, Hashable {
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
        let span = HubPerf.begin("tools.\(args.prefix(3).joined(separator: "."))")
        defer { span.end() }
        let process = Process()
        let plan = ToolsBridge.launchPlan(binaryPath: HubSource.bridge.binaryPath, argv: args)
        process.executableURL = plan.executable
        process.currentDirectoryURL = plan.workingDirectory
        process.arguments = plan.arguments
        process.standardInput = FileHandle.nullDevice
        do {
            return try process.runCapturing(timeout: timeout)
        } catch let timeout as ProcessTimeout {
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
                Text(verbatim: "\(count)")
                    .font(.system(size: 10.5, weight: .semibold, design: .monospaced))
                    .padding(.horizontal, 6)
                    .padding(.vertical, 1)
                    .background(Capsule().fill(Color.white.opacity(0.08)))
                    .instantTooltip("\(count) agent sessions worked here")
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
            Button("Copy path") { PathOpener.copy(worktree.path, what: "path") }
            Divider()
            Button("Open in Finder") { PathOpener.finder(worktree.path) }
            Button("Open in Cursor") { PathOpener.cursor(worktree.path) }
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
            VStack(alignment: .leading, spacing: 8) {
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
            .padding(.leading, 18)
            .padding(.trailing, 14)
            .padding(.top, 34)
            .padding(.bottom, 10)
            .overlay(Rectangle().fill(ReviewPalette.hairline).frame(height: 1), alignment: .bottom)

            if let review = model.review {
                ReviewRootView(model: review)
            }
        }
    }

    private func sessionChip(_ session: HubSession) -> some View {
        HStack(spacing: 6) {
            Text(session.provider.prefix(1).uppercased())
                .font(.system(size: 9.5, weight: .bold))
                .foregroundColor(.black.opacity(0.8))
                .frame(width: 15, height: 15)
                .background(RoundedRectangle(cornerRadius: 4).fill(Color.white.opacity(0.6)))
            Text(session.displayTitle).lineLimit(1).frame(maxWidth: 220, alignment: .leading)
            Text(HubFormat.ago(session.lastActivity)).foregroundColor(ReviewPalette.dim)
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
