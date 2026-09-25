import AppKit
import SwiftUI

// What an Activity row folds open to: `tools hub timeline detail --kind <k> --id <id> --json`
// (src/hub/lib/timeline-detail.ts), one shape per kind, decoded by the `kind` field. Loaded once
// per row off the main thread (HubTimelineModel.loadDetail); a commit's file diff is a second call.

// MARK: - Shapes

struct TimelinePRSummary: Decodable, Hashable {
    let ref: String
    let url: String
    let title: String
    let state: String
}

struct TimelineSessionDetail: Decodable {
    struct Prompt: Decodable, Identifiable {
        let index: Int
        let at: String?
        let text: String
        var id: Int { index }
    }

    struct Reply: Decodable {
        let at: String?
        let text: String
    }

    struct File: Decodable, Identifiable {
        let path: String
        let via: String
        let edits: Int
        let agents: Int
        var id: String { path }
    }

    struct Subagent: Decodable, Identifiable {
        let id: String
        let name: String?
        let description: String?
        let agentType: String?
        let state: String
        let lastAt: String
    }

    struct Tokens: Decodable {
        let calls: Int
        let input: Int
        let cacheRead: Int
        let output: Int
    }

    let sessionId: String
    let provider: String
    let filePath: String?
    let since: String
    let until: String
    let turns: Int
    let prompts: [Prompt]
    let promptsTotal: Int
    let lastReply: Reply?
    let files: [File]
    let filesTotal: Int
    let subagents: [Subagent]
    let tokens: Tokens
    let costUsd: Double?
    let warnings: [String]
}

struct TimelineFileDiff: Decodable {
    let path: String
    let text: String
    let truncated: Bool
}

struct TimelineCommitDetail: Decodable {
    struct File: Decodable, Identifiable {
        let path: String
        let status: String
        let added: Int
        let removed: Int
        let binary: Bool
        var id: String { path }
    }

    let sha: String
    let shortSha: String
    let subject: String
    let body: String
    let author: String
    let email: String
    let at: String
    let files: [File]
    let branches: [String]
    let branchesTruncated: Bool
    let prs: [TimelinePRSummary]
    let diff: TimelineFileDiff?
}

struct TimelinePushDetail: Decodable {
    struct Commit: Decodable, Identifiable {
        let sha: String
        let shortSha: String
        let subject: String
        let at: String
        let author: String
        var id: String { sha }
    }

    struct Remote: Decodable {
        let kind: String?
        let web: String?
    }

    let branch: String
    let from: String
    let to: String
    let newBranch: Bool
    let commits: [Commit]
    let truncated: Bool
    let remote: Remote?
    let pr: TimelinePRSummary?
}

struct TimelinePRDetail: Decodable {
    struct Summary: Decodable {
        struct Check: Decodable, Identifiable {
            let name: String
            let status: String?
            let url: String?
            var id: String { name + (url ?? "") }
        }

        struct WebUrls: Decodable {
            let pr: String?
            let files: String?
            let commits: String?
            let checks: String?
        }

        let ref: String
        let url: String
        let title: String
        let state: String
        let draft: Bool
        let author: String?
        let headBranch: String
        let baseBranch: String
        let additions: Int?
        let deletions: Int?
        let changedFiles: Int?
        let mergeable: String?
        let reviewDecision: String?
        let approvals: Int?
        let ci: String?
        let checks: [Check]
        let webUrls: WebUrls?
        let localWorktree: String?
        let repoRoot: String?
    }

    struct Threads: Decodable {
        struct New: Decodable, Identifiable {
            let id: String
            let threadId: String
            let path: String
            let line: Int
            let author: String
            let title: String
            let at: String
            let resolved: Bool
        }

        let total: Int
        let open: Int
        let newSince: [New]
    }

    let pr: Summary
    let threads: Threads
    let warnings: [String]
}

struct TimelineThreadDetail: Decodable {
    let pr: TimelinePRSummary
    let viewer: String?
    let thread: PRThread
    let fetched: String
}

struct TimelineDecisionDetail: Decodable {
    struct Record: Decodable {
        let id: String
        let sessionId: String
        let number: Int
        let prompt: String
        let options: [String]
        let state: String
        let title: String?
        let proposal: String?
        let recommended: String?
        let reasoning: String?
        let answer: String?
        let option: String?
        let excerpt: String?
    }

    let record: Record
}

private struct TimelineDetailError: Decodable, Error, CustomStringConvertible {
    let error: String
    var description: String { error }
}

enum TimelineDetail {
    case session(TimelineSessionDetail)
    case commit(TimelineCommitDetail)
    case push(TimelinePushDetail)
    case pr(TimelinePRDetail)
    case thread(TimelineThreadDetail)
    case decision(TimelineDecisionDetail)

    private struct Kind: Decodable {
        let kind: String
    }

    /// The CLI's JSON: one shape per `kind`; `{ "error": … }` on stdout when the verb failed.
    static func decode(_ data: Data) throws -> TimelineDetail {
        let decoder = JSONDecoder()
        if let failure = try? decoder.decode(TimelineDetailError.self, from: data) {
            throw failure
        }
        switch try decoder.decode(Kind.self, from: data).kind {
        case "session": return .session(try decoder.decode(TimelineSessionDetail.self, from: data))
        case "commit": return .commit(try decoder.decode(TimelineCommitDetail.self, from: data))
        case "push": return .push(try decoder.decode(TimelinePushDetail.self, from: data))
        case "pr": return .pr(try decoder.decode(TimelinePRDetail.self, from: data))
        case "thread": return .thread(try decoder.decode(TimelineThreadDetail.self, from: data))
        case "decision": return .decision(try decoder.decode(TimelineDecisionDetail.self, from: data))
        case let other: throw ReviewError.git("tools hub timeline detail answered an unknown kind: \(other)")
        }
    }

    /// Blocking: runs `tools` and decodes; call off the main thread.
    static func load(_ args: [String]) throws -> TimelineDetail {
        let capture = try ToolsCLIRunner.capture(args)
        if capture.status != 0, let failure = try? JSONDecoder().decode(TimelineDetailError.self, from: capture.stdout) {
            throw failure
        }
        if capture.status != 0 {
            throw ReviewError.git("tools hub timeline detail exited \(capture.status): \(String(decoding: capture.stderr, as: UTF8.self).trimmed.suffix(300))")
        }
        return try decode(capture.stdout)
    }
}

/// What ⌘F searches in a folded-open row: one field per detail text the pane draws, under the keys
/// the pane's `FindText`s use (Hub/HubPanelFind.swift). A closed row contributes nothing, so no
/// match points at hidden text.
enum TimelineDetailFind {
    static func agentLabel(_ agent: TimelineSessionDetail.Subagent) -> String {
        [agent.name, agent.description ?? agent.agentType].compactMap { $0 }.joined(separator: ": ")
    }

    static func fields(_ detail: TimelineDetail) -> [PanelFindField] {
        switch detail {
        case .session(let session):
            var fields = session.prompts.map { PanelFindField("prompt.\($0.index)", $0.text) }
            if let reply = session.lastReply { fields.append(PanelFindField("reply", reply.text)) }
            // The pane draws a PathLabel ("~/…"), so the field text is the shown text, not the raw path.
            fields += session.files.map { PanelFindField("file.\($0.path)", PathLabel.display($0.path)) }
            fields += session.subagents.map { PanelFindField("agent.\($0.id)", agentLabel($0)) }
            return fields
        case .commit(let commit):
            var fields = [PanelFindField("body", commit.body), PanelFindField("branches", commit.branches.joined(separator: ", "))]
            fields += commit.files.map { PanelFindField("file.\($0.path)", $0.path) }
            fields += commit.prs.map { PanelFindField("pr.\($0.ref)", "\($0.ref) \($0.title)") }
            return fields
        case .push(let push):
            var fields = push.commits.map { PanelFindField("commit.\($0.sha)", $0.subject) }
            if let pr = push.pr { fields.append(PanelFindField("pr", "\(pr.ref) \(pr.title)")) }
            return fields
        case .pr(let detail):
            return [PanelFindField("ref", detail.pr.ref), PanelFindField("pr-title", detail.pr.title)]
                + detail.pr.checks.map { PanelFindField("check.\($0.id)", $0.name) }
                + detail.threads.newSince.map { PanelFindField("thread.\($0.id)", $0.title) }
        case .thread(let thread):
            return thread.thread.comments.flatMap { comment in
                [PanelFindField("comment-author.\(comment.id)", comment.author.username), PanelFindField("comment.\(comment.id)", comment.bodyMarkdown)]
            }
        case .decision(let decision):
            var fields = [PanelFindField("prompt", decision.record.prompt)]
            fields += decision.record.options.enumerated().map { PanelFindField("option.\($0.offset)", $0.element) }
            if let answer = decision.record.answer, !answer.isEmpty { fields.append(PanelFindField("answer", answer)) }
            return fields
        }
    }
}

// MARK: - Views

struct TimelineDetailView: View {
    @ObservedObject var model: HubModel
    @ObservedObject var timeline: HubTimelineModel
    let event: TimelineEvent

    var body: some View {
        Group {
            if let detail = timeline.details[event.id] {
                content(detail)
            } else if let error = timeline.detailErrors[event.id] {
                HStack(spacing: 8) {
                    Image(systemName: "exclamationmark.triangle").foregroundColor(ReviewPalette.modified)
                    Text(error).font(.system(size: 11.5)).foregroundColor(ReviewPalette.dim).lineLimit(3)
                    Button("Retry") { timeline.loadDetail(event, fresh: true) }.buttonStyle(.genHoverPlain()).font(.system(size: 11.5))
                }
            } else {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Reading the details…").font(.system(size: 11.5)).foregroundColor(ReviewPalette.dim)
                }
                .frame(height: 24)
            }
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.white.opacity(0.035)))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(ReviewPalette.hairline))
    }

    @ViewBuilder
    private func content(_ detail: TimelineDetail) -> some View {
        switch detail {
        case .session(let session): TimelineSessionDetailView(model: model, timeline: timeline, event: event, detail: session)
        case .commit(let commit): TimelineCommitDetailView(model: model, timeline: timeline, event: event, detail: commit)
        case .push(let push): TimelinePushDetailView(model: model, event: event, detail: push)
        case .pr(let pr): TimelinePRDetailView(model: model, event: event, detail: pr)
        case .thread(let thread): TimelineThreadDetailView(model: model, event: event, detail: thread)
        case .decision(let decision): TimelineDecisionDetailView(detail: decision)
        }
    }
}

/// A kicker and a row of facts, the shape every detail shares.
private struct DetailLine<Content: View>: View {
    let kicker: String
    @ViewBuilder let content: () -> Content

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(kicker.uppercased())
                .font(.system(size: 9.5, weight: .semibold))
                .foregroundColor(ReviewPalette.dim)
                .frame(width: 64, alignment: .trailing)
            content()
        }
    }
}

private enum DetailFormat {
    static let time: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm"
        return formatter
    }()

    static func clock(_ iso: String?) -> String {
        HubFormat.date(iso).map { time.string(from: $0) } ?? ""
    }

    static func tokens(_ value: Int) -> String {
        value >= 1_000_000 ? String(format: "%.1fM", Double(value) / 1_000_000) : value >= 1000 ? String(format: "%.1fk", Double(value) / 1000) : "\(value)"
    }
}

struct TimelineSessionDetailView: View {
    @ObservedObject var model: HubModel
    @ObservedObject var timeline: HubTimelineModel
    let event: TimelineEvent
    let detail: TimelineSessionDetail

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            DetailLine(kicker: "Period") {
                Text(verbatim: "\(detail.turns) turns · \(detail.promptsTotal) prompts · \(detail.filesTotal) files · \(detail.subagents.count) sub-agents")
                    .font(.system(size: 11.5))
                Spacer()
                spendLabel
            }
            if !detail.prompts.isEmpty {
                DetailLine(kicker: "Prompts") {
                    VStack(alignment: .leading, spacing: 2) {
                        if detail.promptsTotal > detail.prompts.count {
                            Text("the last \(detail.prompts.count) of \(detail.promptsTotal)")
                                .font(.system(size: 10.5)).foregroundColor(ReviewPalette.dim)
                        }
                        ForEach(detail.prompts) { prompt in
                            HStack(alignment: .firstTextBaseline, spacing: 6) {
                                Text(verbatim: DetailFormat.clock(prompt.at))
                                    .font(.system(size: 10.5, design: .monospaced)).foregroundColor(ReviewPalette.dim)
                                FindText(prompt.text, field: "prompt.\(prompt.index)").font(.system(size: 11.5)).lineLimit(2)
                                Spacer(minLength: 4)
                                IconButton(systemName: "text.magnifyingglass", tooltip: "Open the transcript at this prompt", size: 10) {
                                    model.openTimelineSession(event, transcriptQuery: String(prompt.text.prefix(60)))
                                }
                            }
                        }
                    }
                }
            }
            if let reply = detail.lastReply {
                DetailLine(kicker: "Last reply") {
                    FindText(reply.text, field: "reply").font(.system(size: 11.5)).foregroundColor(Color.white.opacity(0.8)).lineLimit(4)
                }
            }
            if !detail.files.isEmpty {
                DetailLine(kicker: "Files") {
                    VStack(alignment: .leading, spacing: 1) {
                        ForEach(detail.files) { file in
                            HStack(spacing: 6) {
                                Text(verbatim: "\(file.edits)×")
                                    .font(.system(size: 10.5, design: .monospaced)).foregroundColor(ReviewPalette.dim)
                                    .frame(width: 30, alignment: .trailing)
                                PathLabel(path: file.path, showIcons: false, findField: "file.\(file.path)")
                                Text(file.via).font(.system(size: 10)).foregroundColor(ReviewPalette.dim)
                                if file.agents > 0 {
                                    Image(systemName: "person.2").font(.system(size: 9)).foregroundColor(ReviewPalette.dim)
                                        .instantTooltip("Changed by a sub-agent")
                                }
                            }
                        }
                        if detail.filesTotal > detail.files.count {
                            Text("and \(detail.filesTotal - detail.files.count) more").font(.system(size: 10.5)).foregroundColor(ReviewPalette.dim)
                        }
                    }
                }
            }
            if !detail.subagents.isEmpty {
                DetailLine(kicker: "Agents") {
                    VStack(alignment: .leading, spacing: 1) {
                        ForEach(detail.subagents) { agent in
                            HStack(spacing: 6) {
                                Circle().fill(agent.state == "running" ? ReviewPalette.added : ReviewPalette.dim).frame(width: 6, height: 6)
                                FindText(TimelineDetailFind.agentLabel(agent), field: "agent.\(agent.id)")
                                    .font(.system(size: 11.5)).lineLimit(1)
                                Text(verbatim: "\(agent.state) · \(DetailFormat.clock(agent.lastAt))")
                                    .font(.system(size: 10.5)).foregroundColor(ReviewPalette.dim)
                            }
                        }
                    }
                }
            }
            DetailLine(kicker: "Tokens") {
                Text(verbatim: detail.tokens.calls > 0
                    ? "\(detail.tokens.calls) calls · in \(DetailFormat.tokens(detail.tokens.input)) · cache \(DetailFormat.tokens(detail.tokens.cacheRead)) · out \(DetailFormat.tokens(detail.tokens.output))"
                    : "not in this transcript (the cost below comes from tools ai-spend)")
                    .font(.system(size: 11)).foregroundColor(ReviewPalette.dim)
                if let path = detail.filePath {
                    Spacer()
                    PathLabel(path: path, showIcons: false)
                }
            }
            ForEach(detail.warnings, id: \.self) { warning in
                Text(warning).font(.system(size: 10.5)).foregroundColor(ReviewPalette.modified)
            }
        }
    }

    @ViewBuilder
    private var spendLabel: some View {
        switch timeline.spend[detail.sessionId] {
        case .some(.some(let estimate)):
            Text(verbatim: SessionFormat.usd(estimate.usd))
                .font(.system(size: 11.5, weight: .semibold, design: .monospaced))
                .instantTooltip(estimate.note)
        case .some(.none):
            Text(detail.costUsd.map { SessionFormat.usd($0) } ?? "no spend recorded")
                .font(.system(size: 11)).foregroundColor(ReviewPalette.dim)
        case .none:
            ProgressView().controlSize(.mini)
        }
    }
}

struct TimelineCommitDetailView: View {
    @ObservedObject var model: HubModel
    @ObservedObject var timeline: HubTimelineModel
    let event: TimelineEvent
    let detail: TimelineCommitDetail

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            DetailLine(kicker: "Commit") {
                CopyChip(label: detail.shortSha, value: detail.sha, tooltip: "Copy \(detail.sha)")
                Text(verbatim: "\(detail.author) · \(DetailFormat.clock(detail.at))").font(.system(size: 11)).foregroundColor(ReviewPalette.dim)
                if let url = model.timelineHostURL(event) {
                    ExternalLink(text: "on the host", url: url, font: .system(size: 11), glyph: .onHover, tooltip: "The commit page")
                }
            }
            if !detail.body.isEmpty {
                DetailLine(kicker: "Message") {
                    FindText(detail.body, field: "body").font(.system(size: 11.5)).foregroundColor(Color.white.opacity(0.8)).lineLimit(12)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            DetailLine(kicker: "Files") {
                VStack(alignment: .leading, spacing: 1) {
                    ForEach(detail.files) { file in
                        fileRow(file)
                    }
                    if detail.files.isEmpty {
                        Text("no file changed").font(.system(size: 11)).foregroundColor(ReviewPalette.dim)
                    }
                }
            }
            if !detail.branches.isEmpty {
                DetailLine(kicker: "Branches") {
                    FindText(detail.branches.joined(separator: ", ") + (detail.branchesTruncated ? ", …" : ""), field: "branches")
                        .font(.system(size: 11, design: .monospaced)).foregroundColor(ReviewPalette.dim).lineLimit(2)
                }
            }
            DetailLine(kicker: "PRs") {
                if detail.prs.isEmpty {
                    Text("no PR of this repository contains it").font(.system(size: 11)).foregroundColor(ReviewPalette.dim)
                } else {
                    ForEach(detail.prs, id: \.ref) { pr in
                        prLink(pr)
                    }
                }
            }
        }
    }

    private func prLink(_ pr: TimelinePRSummary) -> some View {
        HStack(spacing: 4) {
            Button {
                if let ref = HubPRRef(pr.ref) {
                    model.setMode(.prs)
                    model.prs.request(ref)
                }
            } label: {
                FindText("\(pr.ref) \(pr.title)", field: "pr.\(pr.ref)").font(.system(size: 11.5)).lineLimit(1)
            }
            .buttonStyle(.genHoverPlain())
            .instantTooltip("Open \(pr.ref) in the hub (\(pr.state.lowercased()))")
            ExternalLink(text: "", url: URL(string: pr.url), font: .system(size: 10), glyph: .always, tooltip: "Open on the host")
        }
    }

    private func fileRow(_ file: TimelineCommitDetail.File) -> some View {
        let key = HubTimelineModel.diffKey(sha: detail.sha, path: file.path)
        let open = timeline.fileDiffs[key]
        return VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Text(file.status)
                    .font(.system(size: 10, weight: .semibold, design: .monospaced))
                    .foregroundColor(file.status == "A" ? ReviewPalette.added : file.status == "D" ? ReviewPalette.removed : ReviewPalette.modified)
                    .frame(width: 12)
                Button {
                    timeline.loadFileDiff(event, path: file.path)
                } label: {
                    FindText(file.path, field: "file.\(file.path)").font(.system(size: 11.5, design: .monospaced)).lineLimit(1).truncationMode(.middle)
                }
                .buttonStyle(.genHoverPlain())
                .instantTooltip(open == nil ? "Show this file's diff here" : "Hide the diff")
                if file.binary {
                    Text("binary").font(.system(size: 10)).foregroundColor(ReviewPalette.dim)
                } else {
                    Text(verbatim: "+\(file.added)").font(.system(size: 10.5, design: .monospaced)).foregroundColor(ReviewPalette.added)
                    Text(verbatim: "−\(file.removed)").font(.system(size: 10.5, design: .monospaced)).foregroundColor(ReviewPalette.removed)
                }
                // A fixed slot: the Cursor button after it stays put while the file's diff loads.
                ZStack {
                    if timeline.loadingDiffs.contains(key) {
                        ProgressView().controlSize(.mini)
                    }
                }
                .frame(width: 12, height: 12)
                if let repo = event.repo {
                    IconButton(systemName: "chevron.left.forwardslash.chevron.right", tooltip: "Open in Cursor", size: 9) {
                        PathOpener.cursor((repo as NSString).appendingPathComponent(file.path))
                    }
                }
            }
            if let open {
                // Both axes: the text runs to 400 lines, and the frame below shows about 20.
                ScrollView([.horizontal, .vertical]) {
                    Text(open.text + (open.truncated ? "\n… (cut at 400 lines; open the commit in the diff for the rest)" : ""))
                        .font(.system(size: 10.5, design: .monospaced))
                        .foregroundColor(Color.white.opacity(0.8))
                        .textSelection(.enabled)
                        .padding(6)
                }
                .frame(maxHeight: 260)
                .background(RoundedRectangle(cornerRadius: 6).fill(Color.black.opacity(0.3)))
            }
        }
    }
}

struct TimelinePushDetailView: View {
    @ObservedObject var model: HubModel
    let event: TimelineEvent
    let detail: TimelinePushDetail

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            DetailLine(kicker: "Push") {
                Text(verbatim: detail.newBranch ? "new branch \(detail.branch) at \(detail.to.prefix(8))" : "\(detail.branch): \(detail.from.prefix(8))..\(detail.to.prefix(8))")
                    .font(.system(size: 11.5, design: .monospaced))
                if let url = model.timelineHostURL(event, compare: true) {
                    ExternalLink(text: "compare", url: url, font: .system(size: 11), glyph: .onHover, tooltip: "The host's compare view")
                }
                if let web = detail.remote?.web, let url = URL(string: web) {
                    ExternalLink(text: "remote", url: url, font: .system(size: 11), glyph: .onHover, tooltip: web)
                }
            }
            DetailLine(kicker: "Commits") {
                VStack(alignment: .leading, spacing: 1) {
                    ForEach(detail.commits) { commit in
                        HStack(spacing: 6) {
                            Text(verbatim: DetailFormat.clock(commit.at)).font(.system(size: 10.5, design: .monospaced)).foregroundColor(ReviewPalette.dim)
                            Button {
                                guard let repo = event.repo else { return }
                                model.setMode(.worktrees)
                                model.selectedWorktree = repo
                                let next = ReviewModel(repo: URL(fileURLWithPath: repo), options: DiffViewOptions())
                                next.embedded = true
                                next.setScope(.commit(sha: commit.sha, title: commit.subject))
                                model.review = next
                            } label: {
                                HStack(spacing: 6) {
                                    Text(verbatim: commit.shortSha).font(.system(size: 11, design: .monospaced)).foregroundColor(ReviewPalette.dim)
                                    FindText(commit.subject, field: "commit.\(commit.sha)").font(.system(size: 11.5)).lineLimit(1)
                                }
                            }
                            .buttonStyle(.genHoverPlain())
                            // The subject truncates in the row; the tooltip carries it whole.
                            .instantTooltip("\(commit.subject)\nShow \(commit.shortSha) in the in-app diff")
                            .contextMenu {
                                Button("Copy sha") { PathOpener.copy(commit.sha, what: "sha") }
                                Button("Copy subject") { PathOpener.copy(commit.subject, what: "subject") }
                            }
                            Text(commit.author).font(.system(size: 10.5)).foregroundColor(ReviewPalette.dim)
                        }
                    }
                    if detail.truncated {
                        Text("and more (the list is cut)").font(.system(size: 10.5)).foregroundColor(ReviewPalette.dim)
                    }
                }
            }
            if let pr = detail.pr {
                DetailLine(kicker: "PR") {
                    Button {
                        if let ref = HubPRRef(pr.ref) {
                            model.setMode(.prs)
                            model.prs.request(ref)
                        }
                    } label: {
                        FindText("\(pr.ref) \(pr.title) (\(pr.state.lowercased()))", field: "pr").font(.system(size: 11.5)).lineLimit(1)
                    }
                    .buttonStyle(.genHoverPlain())
                    .instantTooltip("Open \(pr.ref) in the hub")
                    ExternalLink(text: "", url: URL(string: pr.url), font: .system(size: 10), glyph: .always, tooltip: "Open on the host")
                }
            }
        }
    }
}

struct TimelinePRDetailView: View {
    @ObservedObject var model: HubModel
    let event: TimelineEvent
    let detail: TimelinePRDetail

    var body: some View {
        let pr = detail.pr
        VStack(alignment: .leading, spacing: 6) {
            DetailLine(kicker: "PR") {
                ExternalLink(text: pr.ref, url: URL(string: pr.url), font: .system(size: 11.5, weight: .semibold), color: Color(red: 0.62, green: 0.78, blue: 1), findField: "ref")
                FindText(pr.title, field: "pr-title").font(.system(size: 11.5)).lineLimit(1)
                Text(verbatim: "\(pr.draft ? "draft · " : "")\(pr.state.lowercased()) · \(pr.headBranch) → \(pr.baseBranch)")
                    .font(.system(size: 10.5)).foregroundColor(ReviewPalette.dim).lineLimit(1)
            }
            DetailLine(kicker: "Size") {
                HStack(spacing: 8) {
                    if let files = pr.changedFiles { Text(verbatim: "\(files) files").font(.system(size: 11)) }
                    if let add = pr.additions { Text(verbatim: "+\(add)").font(.system(size: 11, design: .monospaced)).foregroundColor(ReviewPalette.added) }
                    if let del = pr.deletions { Text(verbatim: "−\(del)").font(.system(size: 11, design: .monospaced)).foregroundColor(ReviewPalette.removed) }
                    if let mergeable = pr.mergeable {
                        Text(mergeable).font(.system(size: 11)).foregroundColor(mergeable == "conflicting" ? ReviewPalette.removed : ReviewPalette.dim)
                    }
                    if let files = pr.webUrls?.files, let url = URL(string: files) {
                        ExternalLink(text: "files", url: url, font: .system(size: 11), glyph: .onHover)
                    }
                }
            }
            DetailLine(kicker: "Review") {
                Text(verbatim: [pr.reviewDecision?.lowercased().replacingOccurrences(of: "_", with: " "), pr.approvals.map { "\($0) approvals" }].compactMap { $0 }.joined(separator: " · "))
                    .font(.system(size: 11)).foregroundColor(ReviewPalette.dim)
                Text(verbatim: "\(detail.threads.open) open of \(detail.threads.total) threads")
                    .font(.system(size: 11)).foregroundColor(detail.threads.open > 0 ? ReviewPalette.modified : ReviewPalette.dim)
            }
            DetailLine(kicker: "Checks") {
                VStack(alignment: .leading, spacing: 1) {
                    if pr.checks.isEmpty {
                        Text(pr.ci.map { "CI \($0)" } ?? "no checks reported").font(.system(size: 11)).foregroundColor(ReviewPalette.dim)
                    }
                    ForEach(pr.checks) { check in
                        HStack(spacing: 6) {
                            Circle().fill(checkColor(check.status)).frame(width: 7, height: 7)
                            FindText(check.name, field: "check.\(check.id)").font(.system(size: 11.5))
                            if let url = check.url.flatMap(URL.init(string:)) {
                                ExternalLink(text: "", url: url, font: .system(size: 10), glyph: .always, tooltip: "\(check.status ?? "unknown"): open the run")
                            }
                            Text(check.status ?? "unknown").font(.system(size: 10.5)).foregroundColor(ReviewPalette.dim)
                        }
                    }
                    if pr.checks.contains(where: { $0.status == "failed" }) {
                        Button {
                            model.openTimelinePR(event)
                        } label: {
                            Label("Fix the failed checks in the PR view (Send to agent)", systemImage: "wrench.and.screwdriver")
                                .font(.system(size: 11))
                        }
                        .buttonStyle(.genHoverPlain())
                        .instantTooltip("Opens the PR; its Checks section sends a failing log to an agent")
                    }
                }
            }
            if !detail.threads.newSince.isEmpty {
                DetailLine(kicker: "New threads") {
                    VStack(alignment: .leading, spacing: 1) {
                        ForEach(detail.threads.newSince) { thread in
                            HStack(spacing: 6) {
                                Text(verbatim: DetailFormat.clock(thread.at)).font(.system(size: 10.5, design: .monospaced)).foregroundColor(ReviewPalette.dim)
                                Text(thread.author).font(.system(size: 11)).foregroundColor(ReviewPalette.dim)
                                FindText(thread.title, field: "thread.\(thread.id)").font(.system(size: 11.5)).lineLimit(1)
                                Text(verbatim: "\(thread.path):\(thread.line)").font(.system(size: 10.5, design: .monospaced)).foregroundColor(ReviewPalette.dim).lineLimit(1)
                                if thread.resolved {
                                    Image(systemName: "checkmark.circle.fill").font(.system(size: 10)).foregroundColor(ReviewPalette.added)
                                }
                            }
                        }
                    }
                }
            }
            ForEach(detail.warnings, id: \.self) { warning in
                Text(warning).font(.system(size: 10.5)).foregroundColor(ReviewPalette.modified)
            }
        }
    }

    private func checkColor(_ status: String?) -> Color {
        switch status {
        case "success": return ReviewPalette.added
        case "failed": return ReviewPalette.removed
        case "running", "pending": return ReviewPalette.modified
        default: return ReviewPalette.dim
        }
    }
}

struct TimelineThreadDetailView: View {
    @ObservedObject var model: HubModel
    let event: TimelineEvent
    let detail: TimelineThreadDetail

    var body: some View {
        let forge = event.repo.flatMap { RepoFactsStore.shared.facts(for: $0)?.forge }
        VStack(alignment: .leading, spacing: 6) {
            DetailLine(kicker: "Thread") {
                Text(verbatim: "\(detail.thread.path):\(detail.thread.line)").font(.system(size: 11.5, design: .monospaced))
                Text(detail.thread.resolved ? "resolved" : detail.thread.outdated ? "open · outdated" : "open")
                    .font(.system(size: 10.5)).foregroundColor(detail.thread.resolved ? ReviewPalette.added : ReviewPalette.modified)
                Text(verbatim: "\(detail.thread.comments.count) comments · \(detail.fetched == "cache" ? "from the hub's cache" : "from the host")")
                    .font(.system(size: 10.5)).foregroundColor(ReviewPalette.dim)
                Spacer()
                Button("Open in the diff") { model.openTimelinePR(event, reveal: event.path) }
                    .buttonStyle(.genHoverPlain()).font(.system(size: 11))
                    .instantTooltip("Open \(detail.pr.ref) in the hub at this file")
            }
            ForEach(detail.thread.comments) { comment in
                HStack(alignment: .top, spacing: 8) {
                    VStack(alignment: .trailing, spacing: 1) {
                        ExternalLink(
                            text: comment.author.username,
                            url: forge?.user(comment.author.username),
                            font: .system(size: 11, weight: detail.viewer == comment.author.username ? .semibold : .regular),
                            glyph: .onHover,
                            tooltip: detail.viewer == comment.author.username ? "\(comment.author.username) (you)" : "\(comment.author.username)'s profile",
                            findField: "comment-author.\(comment.id)"
                        )
                        Text(verbatim: PRThreadRendering.ago(comment.createdAt))
                            .font(.system(size: 10)).foregroundColor(ReviewPalette.dim)
                    }
                    .frame(width: 110, alignment: .trailing)
                    FindText(comment.bodyMarkdown, field: "comment.\(comment.id)")
                        .font(.system(size: 11.5))
                        .foregroundColor(Color.white.opacity(comment.isDraft ? 0.6 : 0.85))
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                        .lineLimit(14)
                    if comment.isDraft {
                        Text("draft").font(.system(size: 10)).foregroundColor(ReviewPalette.modified)
                    }
                }
                .padding(.vertical, 2)
            }
        }
    }
}

struct TimelineDecisionDetailView: View {
    let detail: TimelineDecisionDetail

    var body: some View {
        let record = detail.record
        VStack(alignment: .leading, spacing: 6) {
            DetailLine(kicker: "Question") {
                FindText(record.prompt, field: "prompt").font(.system(size: 11.5)).fixedSize(horizontal: false, vertical: true).lineLimit(8)
            }
            if !record.options.isEmpty {
                DetailLine(kicker: "Options") {
                    VStack(alignment: .leading, spacing: 1) {
                        ForEach(Array(record.options.enumerated()), id: \.offset) { index, option in
                            let letter = String(option.prefix(1))
                            HStack(spacing: 6) {
                                Image(systemName: record.option == letter ? "checkmark.circle.fill" : (record.recommended == letter ? "star" : "circle"))
                                    .font(.system(size: 10))
                                    .foregroundColor(record.option == letter ? ReviewPalette.added : ReviewPalette.dim)
                                FindText(option, field: "option.\(index)").font(.system(size: 11.5)).lineLimit(2)
                            }
                        }
                    }
                }
            }
            if let proposal = record.proposal, !proposal.isEmpty {
                DetailLine(kicker: "Proposal") {
                    Text(proposal).font(.system(size: 11.5)).foregroundColor(Color.white.opacity(0.8)).lineLimit(6).fixedSize(horizontal: false, vertical: true)
                }
            }
            DetailLine(kicker: "Answer") {
                FindText(record.answer.flatMap { $0.isEmpty ? nil : $0 } ?? record.option.map { "\($0))" } ?? "none yet (\(record.state))", field: "answer")
                    .font(.system(size: 11.5, weight: .semibold))
                    .foregroundColor(record.answer != nil || record.option != nil ? ReviewPalette.added : ReviewPalette.modified)
                Text(record.state).font(.system(size: 10.5)).foregroundColor(ReviewPalette.dim)
            }
        }
    }
}
