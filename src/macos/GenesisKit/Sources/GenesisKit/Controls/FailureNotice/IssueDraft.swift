import AppKit
import Foundation

/// An issue about to be opened: what the person reviews and edits in the draft window before it is posted.
public struct IssueDraft: Equatable, Sendable {
    /// `owner/repo`.
    public var repo: String
    public var title: String
    public var body: String
    /// Run the title and body through `tools github issues post --redact` (personal data and secrets) before posting.
    public var redact: Bool
    public var labels: [String]

    public init(repo: String, title: String, body: String, redact: Bool = true, labels: [String] = []) {
        self.repo = repo
        self.title = title
        self.body = body
        self.redact = redact
        self.labels = labels
    }

    /// "Recording failed: The camera did not start", at most 120 characters, cut at a word with "…".
    public static func defaultTitle(for report: FailureReport, limit: Int = 120) -> String {
        var headline = report.headline.trimmingCharacters(in: .whitespacesAndNewlines)
        if headline.hasSuffix(".") {
            headline.removeLast()
        }
        let full = "\(report.title): \(headline)"
        guard full.count > limit else { return full }
        var cut = String(full.prefix(limit))
        if let space = cut.lastIndex(of: " ") {
            cut = String(cut[..<space])
        }
        return cut.trimmingCharacters(in: .whitespaces.union(CharacterSet(charactersIn: ",.:;"))) + "…"
    }

    /// The draft of a failure: its title, and the agent context as the body.
    public static func failure(_ report: FailureReport, repo: String, labels: [String] = ["bug"]) -> IssueDraft {
        IssueDraft(repo: repo, title: defaultTitle(for: report), body: report.agentContext(), labels: labels)
    }
}

/// What the post command answered: the issue's number and link, or nothing for a dry run.
public struct IssuePostResult: Equatable, Sendable {
    public var posted: Bool
    public var number: Int?
    public var url: String?
    /// How many values `--redact` replaced in the title and body together.
    public var replaced: Int

    public init(posted: Bool, number: Int?, url: String?, replaced: Int) {
        self.posted = posted
        self.number = number
        self.url = url
        self.replaced = replaced
    }
}

public struct IssuePostError: Error, Equatable, Sendable {
    public var message: String

    public init(message: String) {
        self.message = message
    }
}

/// Posts a draft and names the browser its link opens in. The app uses `ToolsIssuePoster`; a test or a preview a fake.
public protocol IssuePosting: Sendable {
    func post(_ draft: IssueDraft) async -> Result<IssuePostResult, IssuePostError>
    /// The browser a click on `url` really reaches ("Brave Browser"), nil when it cannot tell.
    func browserName(for url: String) async -> String?
}

/// `tools github issues post` and `tools browser-router browser`, so the app holds no GitHub token and no routing rules.
public struct ToolsIssuePoster: IssuePosting {
    let bridge: ToolsBridge
    /// `--dry-run`: the command returns what it would post and sends nothing.
    let dryRun: Bool

    public init(bridge: ToolsBridge = ToolsBridge(binaryPath: ToolsBridge.defaultBinaryPath()), dryRun: Bool = false) {
        self.bridge = bridge
        self.dryRun = dryRun
    }

    public func post(_ draft: IssueDraft) async -> Result<IssuePostResult, IssuePostError> {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("issue-draft-\(UUID().uuidString).md")
        do {
            try draft.body.write(to: file, atomically: true, encoding: .utf8)
        } catch {
            return .failure(IssuePostError(message: "The draft could not be saved for the command: \(error.localizedDescription)"))
        }
        defer { try? FileManager.default.removeItem(at: file) }
        do {
            let run = try await bridge.run(subcommand: "github", args: Self.arguments(draft, bodyFile: file.path, dryRun: dryRun),
                                           timeoutSeconds: 60)
            return Self.parse(exitCode: run.exitCode, stdout: run.stdout, stderr: run.stderr)
        } catch {
            return .failure(IssuePostError(message: "tools did not run: \(error.localizedDescription)"))
        }
    }

    public func browserName(for url: String) async -> String? {
        guard let run = try? await bridge.run(subcommand: "browser-router", args: ["browser", url, "--json"], timeoutSeconds: 15),
              run.exitCode == 0 else { return nil }
        return Self.browserName(fromJSON: run.stdout)
    }

    nonisolated static func arguments(_ draft: IssueDraft, bodyFile: String, dryRun: Bool) -> [String] {
        var args = ["issue", "post", "--repo", draft.repo, "--title", draft.title, "--body-file", bodyFile, "--json"]
        if draft.redact {
            args.append("--redact")
        }
        for label in draft.labels {
            args += ["--label", label]
        }
        if dryRun {
            args.append("--dry-run")
        }
        return args
    }

    /// The command's JSON answer, or its `Error: …` line (else its last line) when it failed.
    nonisolated static func parse(exitCode: Int32, stdout: String, stderr: String) -> Result<IssuePostResult, IssuePostError> {
        guard exitCode == 0 else {
            let lines = stderr.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
            let line = lines.last { $0.hasPrefix("Error:") }.map { String($0.dropFirst("Error:".count)).trimmingCharacters(in: .whitespaces) }
                ?? lines.last ?? "The command failed (exit \(exitCode))."
            return .failure(IssuePostError(message: line))
        }
        guard let data = stdout.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return .failure(IssuePostError(message: "The command's answer was not JSON."))
        }
        let replaced = (object["replaced"] as? [String: Any])?.values.compactMap { $0 as? Int }.reduce(0, +) ?? 0
        return .success(IssuePostResult(posted: object["posted"] as? Bool ?? false, number: object["number"] as? Int,
                                        url: object["url"] as? String, replaced: replaced))
    }

    nonisolated static func browserName(fromJSON text: String) -> String? {
        guard let data = text.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let effective = object["defaultBrowserEffective"] as? [String: Any] else { return nil }
        return effective["name"] as? String
    }
}

/// The draft window's state: editing, posting, posted (with its link) or failed (with the reason and a retry).
@MainActor
public final class IssueDraftModel: ObservableObject {
    public enum State: Equatable {
        case editing
        case posting
        case posted(IssuePostResult)
        case failed(String)
    }

    @Published public var draft: IssueDraft
    @Published public private(set) var state: State = .editing
    @Published public private(set) var browserName: String?
    @Published var copied = false
    let poster: IssuePosting

    public init(draft: IssueDraft, poster: IssuePosting, state: State = .editing, browserName: String? = nil) {
        self.draft = draft
        self.poster = poster
        self.state = state
        self.browserName = browserName
    }

    public var canPost: Bool {
        state != .posting && !draft.title.trimmingCharacters(in: .whitespaces).isEmpty
            && !draft.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    public func post() async {
        guard canPost else { return }
        state = .posting
        switch await poster.post(draft) {
        case let .success(result):
            state = .posted(result)
            if let url = result.url {
                browserName = await poster.browserName(for: url)
            }
        case let .failure(error):
            state = .failed(error.message)
        }
    }

    /// Back to editing after a failure, the text as the person left it.
    public func edit() {
        if case .failed = state {
            state = .editing
        }
    }

    func copyLink() {
        guard case let .posted(result) = state, let url = result.url else { return }
        Clipboard.copy(url, what: "the issue's link")
        copied = true
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(1400))
            self?.copied = false
        }
    }

    /// Opens the link the way a click does (the default browser, through the link router when it is installed), so it
    /// lands in the browser the button names.
    func openLink() {
        guard case let .posted(result) = state, let text = result.url, let url = URL(string: text) else { return }
        NSWorkspace.shared.open(url)
    }
}
