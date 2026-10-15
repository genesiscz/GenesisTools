//
//  GenesisKitGTProvider.swift
//  GenesisKit
//
//  Where GenesisKit's git and agent components get the data that lives outside Swift today: the git CLI and the
//  GenesisTools `tools` CLI. Every component reads through `GenesisKitGT.provider`; a host replaces it (GenesisTools
//  hands it its resident `tools` server), and a Swift-native provider can replace the whole thing later without a
//  component changing. The questions are the components' own (a file's git state, its history, a version of it),
//  so a native provider answers them directly; the CLI provider answers them with `git` and `tools`.
//

import AppKit
import Foundation

/// One `git` run: its exit status and both streams.
public typealias GitRunResult = ProcessCapture

public protocol GenesisKitGTProvider: AnyObject {
    // MARK: Primitives

    /// `git` in `repo`, or against another object store (`gitDirectory`, the agents change log's).
    func git(_ arguments: [String], in repo: URL, input: Data?, gitDirectory: String?, environment: [String: String]?) throws -> GitRunResult
    /// `tools <arguments>`: stdout, or a thrown error for a non-zero exit.
    func tools(_ arguments: [String]) throws -> Data

    // MARK: Git questions

    /// A diff of `scope` in the repository holding `folder`.
    func diff(_ scope: DiffScope, in folder: URL, preferredBase: String?, session: String?) throws -> GitWorkingTreeSource.Snapshot
    /// The file's place in git: branch, whether it is tracked, and its staged and unstaged line counts. nil outside a
    /// repository.
    func fileState(_ file: URL) throws -> GitFileState?
    /// The file's text at a revision (`HEAD`, a commit, the index); nil when the revision has no such file.
    func contents(of file: URL, at revision: GitRevision) throws -> String?
    /// The commits that changed the file, newest first, following renames.
    func history(of file: URL, limit: Int) throws -> [GitCommit]
    /// The repository around `folder`: branch, ahead and behind, the changed files, the recent commits.
    func repoStatus(_ folder: URL, commits: Int) throws -> GitRepoStatus?

    // MARK: Agents (GenesisTools)

    /// The files an agent session's last turns changed (`tools agents changes`).
    func agentTurnChanges(session: String, lastTurns: Int) throws -> GitWorkingTreeSource.TurnChanges
    /// Which agent session and turn wrote each line of these files (`tools agents blame`).
    func agentBlame(repo: String, paths: [String]) throws -> AgentBlameResult
    /// Shows the session that wrote a line: the GenesisTools hub, its transcript searched for the turn's prompt.
    func openAgentSession(_ source: AgentBlameSource)
}

/// The provider every GenesisKit git and agent component uses: the one set here, else the host's
/// (`GenesisKitHost.gtProvider`), else the CLI provider.
public enum GenesisKitGT {
    nonisolated(unsafe) private static var current: GenesisKitGTProvider?
    private static let lock = NSLock()

    public static var provider: GenesisKitGTProvider {
        get {
            lock.lock()
            defer { lock.unlock() }
            if let current { return current }
            let made = GenesisKit.host?.gtProvider ?? GenesisKitGTCLIProvider()
            current = made
            return made
        }
        set {
            lock.lock()
            current = newValue
            lock.unlock()
        }
    }
}

/// The default provider: `/usr/bin/git` and the `tools` binary (`GenesisKitHost.toolsBinaryPath`).
open class GenesisKitGTCLIProvider: GenesisKitGTProvider {
    public init() {}

    open func git(_ arguments: [String], in repo: URL, input: Data? = nil, gitDirectory: String? = nil, environment: [String: String]? = nil) throws -> GitRunResult {
        let span = PerfSpans.begin("git.\(arguments.first ?? "")", repo.lastPathComponent)
        defer { span.end() }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        let location = gitDirectory.map { ["--git-dir", $0] } ?? ["-C", repo.path]
        process.arguments = location + ["-c", "core.quotepath=off"] + arguments
        if let environment {
            process.environment = ProcessInfo.processInfo.environment.merging(environment) { _, new in new }
        }
        let inPipe = Pipe()
        process.standardInput = input == nil ? FileHandle.nullDevice : inPipe
        return try process.runCapturing {
            guard let input else { return }
            // Feed stdin on its own queue: a large batch can fill the stdout pipe before stdin is drained.
            DispatchQueue.global().async {
                inPipe.fileHandleForWriting.write(input)
                try? inPipe.fileHandleForWriting.close()
            }
        }
    }

    open func tools(_ arguments: [String]) throws -> Data {
        let span = PerfSpans.begin("tools.\(arguments.prefix(3).joined(separator: "."))")
        defer { span.end() }
        let binary = ToolsBridge.resolveBinaryPath(configured: GenesisKit.host?.toolsBinaryPath)
        let plan = ToolsBridge.launchPlan(binaryPath: binary, argv: arguments)
        let process = Process()
        process.executableURL = plan.executable
        process.currentDirectoryURL = plan.workingDirectory
        process.arguments = plan.arguments
        process.standardInput = FileHandle.nullDevice
        let result = try process.runCapturing()
        guard result.status == 0 else {
            let message = String(decoding: result.stderr, as: UTF8.self)
            throw ReviewError.git("tools \(arguments.first ?? "") exited \(result.status): \(message.trimmed.suffix(300))")
        }
        return result.stdout
    }

    open func diff(_ scope: DiffScope, in folder: URL, preferredBase: String?, session: String?) throws -> GitWorkingTreeSource.Snapshot {
        try GitWorkingTreeSource(repo: folder, preferredBase: preferredBase).load(scope: scope, session: session)
    }

    open func fileState(_ file: URL) throws -> GitFileState? {
        try GitQueries(provider: self).fileState(file)
    }

    open func contents(of file: URL, at revision: GitRevision) throws -> String? {
        try GitQueries(provider: self).contents(of: file, at: revision)
    }

    open func history(of file: URL, limit: Int) throws -> [GitCommit] {
        try GitQueries(provider: self).history(of: file, limit: limit)
    }

    open func repoStatus(_ folder: URL, commits: Int) throws -> GitRepoStatus? {
        try GitQueries(provider: self).repoStatus(folder, commits: commits)
    }

    open func agentTurnChanges(session: String, lastTurns: Int) throws -> GitWorkingTreeSource.TurnChanges {
        // `--store-blobs`: the before-states come from the object store, and `changes` writes them only when asked.
        let data = try tools(["agents", "changes", session, "--last-turns", String(lastTurns), "--json", "--store-blobs"])
        return try JSONDecoder().decode(GitWorkingTreeSource.TurnChanges.self, from: data)
    }

    open func agentBlame(repo: String, paths: [String]) throws -> AgentBlameResult {
        let data = try tools(AgentBlame.arguments(repo: repo, paths: paths))
        return try JSONDecoder().decode(AgentBlameResult.self, from: data)
    }

    /// The GenesisTools app with `--hub --session …`: a running hub takes the arguments (its single-instance
    /// hand-off), otherwise this starts one. Inside GenesisTools that is its own executable.
    open func openAgentSession(_ source: AgentBlameSource) {
        let executable = Bundle.main.bundleIdentifier == Self.genesisToolsBundleID
            ? Bundle.main.executablePath
            : NSWorkspace.shared.urlForApplication(withBundleIdentifier: Self.genesisToolsBundleID)
                .flatMap { Bundle(url: $0)?.executablePath }
        PerfSpans.log("blame open \(source.session.prefix(8)) turn \(source.turn.prefix(8))")
        guard let executable else {
            PerfSpans.log("blame open: GenesisTools.app is not installed")
            return
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = AgentBlame.hubArguments(for: source)
        do {
            try process.run()
        } catch {
            PerfSpans.log("blame open failed: \(error)")
        }
    }

    public static let genesisToolsBundleID = "com.genesiscz.genesistools"
}
