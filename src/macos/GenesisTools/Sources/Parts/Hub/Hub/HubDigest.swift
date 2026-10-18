import AppKit
import SwiftUI

// ⌥⌘D: the Today digest. What the agents did on one day, from `tools hub digest --json`
// (src/hub/lib/digest.ts: the Activity feed folded into sessions, commits, files changed, PRs,
// decisions), with the usage forecast (Hub/HubForecast.swift) and a way into the notification rules
// (Hub/HubRules.swift). "Export to vault" writes the markdown note with `--export` into the folder
// kept in the hub config (`tools hub digest config --folder`), asked for once with a folder picker.

package struct HubDigest: Decodable, Equatable, Sendable {
    package struct Session: Decodable, Equatable, Identifiable, Sendable {
        package let sessionId: String
        package let provider: String?
        package let title: String
        package let project: String?
        package let cwd: String?
        package let branch: String?
        package let startedAt: String?
        package let lastAt: String
        package let commits: Int
        package var id: String { sessionId }
    }

    package struct Commit: Decodable, Equatable, Identifiable, Sendable {
        package let sha: String
        package let subject: String
        package let at: String
        package let project: String?
        package let repo: String?
        package let sessionId: String?
        package var id: String { sha }
    }

    package struct RepoFiles: Decodable, Equatable, Identifiable, Sendable {
        package struct Path: Decodable, Equatable, Hashable, Sendable {
            package let path: String
            package let added: Int
            package let removed: Int
        }

        package let repo: String
        package let project: String
        package let files: Int
        package let added: Int
        package let removed: Int
        package let paths: [Path]
        package var id: String { repo }
    }

    package struct Files: Decodable, Equatable, Sendable {
        package let total: Int
        package let added: Int
        package let removed: Int
        package let repos: [RepoFiles]
    }

    package struct Pr: Decodable, Equatable, Identifiable, Sendable {
        package let ref: String
        package let title: String
        package let url: String?
        package let at: String
        package var id: String { "\(ref)@\(at)" }
    }

    package struct Prs: Decodable, Equatable, Sendable {
        package let opened: [Pr]
        package let merged: [Pr]
    }

    package struct Decision: Decodable, Equatable, Identifiable, Sendable {
        package let id: String
        package let number: Int
        package let title: String
        package let state: String
        package let sessionId: String
        package let project: String?
        package let at: String
        package let answer: String?
    }

    package struct Decisions: Decodable, Equatable, Sendable {
        package let posted: [Decision]
        package let answered: [Decision]
    }

    package struct Ci: Decodable, Equatable, Sendable {
        package let failed: Int
        package let passed: Int
    }

    package let date: String
    package let sessions: [Session]
    package let commits: [Commit]
    package let files: Files
    package let prs: Prs
    package let decisions: Decisions
    package let ci: Ci
    package let pushes: Int
    package let warnings: [String]
    package let exported: String?

    /// "7 sessions · 12 commits · 31 files · 2 PRs opened · 3 decisions": the header line.
    package var summary: String {
        [
            Plural.count(sessions.count, "session"),
            Plural.count(commits.count, "commit"),
            "\(Plural.count(files.total, "file")) (+\(files.added) −\(files.removed))",
            "\(Plural.count(prs.opened.count, "PR")) opened, \(prs.merged.count) merged",
            "\(Plural.count(decisions.posted.count, "decision")) posted, \(decisions.answered.count) answered",
        ].joined(separator: " · ")
    }
}

package struct HubDigestConfig: Decodable, Equatable, Sendable {
    package let folder: String?
}

package enum HubDigestDay {
    package static let format: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()

    package static func string(_ date: Date) -> String { format.string(from: date) }

    /// The day before or after `day` (YYYY-MM-DD); never past today.
    package static func step(_ day: String, by offset: Int, today: Date = Date()) -> String {
        guard let date = format.date(from: day), let next = Calendar.current.date(byAdding: .day, value: offset, to: date) else { return day }
        return next > today ? string(today) : string(next)
    }

    package static func title(_ day: String, today: Date = Date()) -> String {
        if day == string(today) { return "Today" }
        if let yesterday = Calendar.current.date(byAdding: .day, value: -1, to: today), day == string(yesterday) { return "Yesterday" }
        guard let date = format.date(from: day) else { return day }
        let pretty = DateFormatter()
        pretty.locale = Locale(identifier: "en_GB")
        pretty.dateFormat = "EEEE d MMMM"
        return pretty.string(from: date)
    }
}

@MainActor
package final class HubDigestModel: ObservableObject {
    @Published package var day = HubDigestDay.string(Date())
    @Published package private(set) var digest: HubDigest?
    @Published package private(set) var loading = false
    @Published package private(set) var error: String?
    @Published package var notice: String?
    @Published package private(set) var exporting = false
    private var generation = 0

    package func load() {
        generation += 1
        let token = generation
        loading = true
        error = nil
        let day = day
        Task {
            do {
                let found = try await HubDailyCLI.decode(HubDigest.self, ["digest", "--json", "--date", day], span: "digest.load")
                guard token == generation else { return }
                digest = found
            } catch {
                guard token == generation else { return }
                digest = nil
                self.error = "Digest failed: \(error)"
            }
            loading = false
        }
    }

    package func step(_ offset: Int) {
        day = HubDigestDay.step(day, by: offset)
        load()
    }

    /// Writes the note into the configured folder; with none yet, asks for one first and saves it.
    package func export() {
        guard !exporting else { return }
        exporting = true
        let day = day
        Task {
            defer { exporting = false }
            do {
                var folder = try await HubDailyCLI.decode(HubDigestConfig.self, ["digest", "config", "--json"], span: "digest.config").folder
                if folder == nil {
                    guard let picked = Self.pickFolder() else { return }
                    try await HubDailyCLI.run(["digest", "config", "--folder", picked], span: "digest.config.set")
                    folder = picked
                }
                let written = try await HubDailyCLI.decode(HubDigest.self, ["digest", "--json", "--date", day, "--export"], span: "digest.export")
                if let path = written.exported {
                    notice = "Exported \(path)"
                    PathOpener.reveal(path)
                }
            } catch {
                notice = "Export failed: \(error)"
            }
        }
    }

    package func changeFolder() {
        guard let picked = Self.pickFolder() else { return }
        Task {
            do {
                try await HubDailyCLI.run(["digest", "config", "--folder", picked], span: "digest.config.set")
                notice = "Exports go to \(picked)"
            } catch {
                notice = "Could not save the folder: \(error)"
            }
        }
    }

    private static func pickFolder() -> String? {
        let panel = NSOpenPanel()
        panel.title = "Folder for the daily agents digest"
        panel.prompt = "Use this folder"
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.allowsMultipleSelection = false
        return panel.runModal() == .OK ? panel.url?.path : nil
    }
}

package struct HubDigestPanel: View {
    @ObservedObject package var hub: HubModel
    package let close: () -> Void
    @StateObject private var model = HubDigestModel()

    package var body: some View {
        HubDailyCard(width: 860, close: close) {
            header
                .padding(12)
            if let notice = model.notice {
                NoticePill(text: notice, isError: notice.hasPrefix("Export failed") || notice.hasPrefix("Could not")) { model.notice = nil }
                    .padding(.horizontal, 12)
                    .padding(.bottom, 8)
            }
            Divider().background(Color.jarvisBorder)
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if let error = model.error {
                        Text(verbatim: error).foregroundColor(ReviewPalette.removed)
                    }
                    if let digest = model.digest {
                        sections(digest)
                    } else if model.loading {
                        Text("Reading the day…").foregroundColor(.settingsTextMuted)
                    }
                    section("Usage forecast", count: nil) { HubForecastList() }
                }
                .padding(14)
                .scrollOverflowContent()
            }
            // The last row sat cut at the panel's bottom edge with nothing saying the list goes on (H16).
            .scrollOverflowHints()
            .frame(maxHeight: 600)
        }
        .onAppear {
            model.load()
            HubForecastStore.shared.loadIfStale(maxAge: 30)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text("Today digest"))
    }

    private var header: some View {
        HStack(spacing: 8) {
            Image(systemName: "sun.max").foregroundColor(Color.jarvisTeal)
            IconButton(systemName: "chevron.left", tooltip: "The day before") { model.step(-1) }
            Text(verbatim: HubDigestDay.title(model.day))
                .font(.system(size: 14, weight: .semibold))
                .instantTooltip(model.day)
            IconButton(systemName: "chevron.right", tooltip: "The day after") { model.step(1) }
                .disabled(model.day == HubDigestDay.string(Date()))
            if model.loading {
                ProgressView().controlSize(.small)
            }
            Spacer()
            IconButton(systemName: "arrow.clockwise", tooltip: "Read the day again") {
                model.load()
                HubForecastStore.shared.load()
            }
            IconButton(systemName: "bell.badge", tooltip: "Notification rules") { HubDailyModel.shared.rulesOpen = true }
            MenuButton(items: {
                [
                    .action("Export to vault", enabled: model.digest != nil) { model.export() },
                    .action("Choose the export folder…") { model.changeFolder() },
                ]
            }) {
                HStack(spacing: 4) {
                    Image(systemName: model.exporting ? "hourglass" : "square.and.arrow.up").font(.system(size: 11))
                    Text("Export").font(.system(size: 12))
                }
                .padding(.horizontal, 6)
            }
            .instantTooltip("Write this day as a markdown note into your vault folder (tools hub digest --export)")
            IconButton(systemName: "xmark", tooltip: "Close (Esc)", size: 10, action: close)
        }
    }

    @ViewBuilder
    private func sections(_ digest: HubDigest) -> some View {
        Text(verbatim: digest.summary)
            .font(.system(size: 11.5, design: .monospaced))
            .foregroundColor(.settingsTextMuted)
        ForEach(digest.warnings, id: \.self) { warning in
            Text(verbatim: "⚠︎ \(warning)").font(.system(size: 11)).foregroundColor(ReviewPalette.modified)
        }
        section("Sessions", count: digest.sessions.count) {
            ForEach(digest.sessions) { session in
                row {
                    hub.openDailySession(
                        provider: session.provider, sessionId: session.sessionId, title: session.title, cwd: session.cwd,
                        project: session.project, branch: session.branch, mtime: HubFormat.date(session.lastAt), query: nil
                    )
                    close()
                } label: {
                    Text(verbatim: clock(session.lastAt)).font(.system(size: 11, design: .monospaced)).foregroundColor(.settingsTextMuted)
                    // The event title is the first prompt, harness tags and all; the session list cleans it the same way.
                    Text(verbatim: TitleFormatter.cleanSessionTitle(session.title) ?? session.title).font(.system(size: 12)).foregroundColor(Color.white.opacity(0.88)).lineLimit(1)
                    Spacer(minLength: 8)
                    Text(verbatim: [session.provider, session.project, session.commits > 0 ? Plural.count(session.commits, "commit") : nil].compactMap { $0 }.joined(separator: " · "))
                        .font(.system(size: 10.5)).foregroundColor(ReviewPalette.dim).lineLimit(1)
                }
                .instantTooltip("Open this session")
            }
        }
        section("Commits", count: digest.commits.count) {
            ForEach(digest.commits) { commit in
                HStack(spacing: 8) {
                    Text(verbatim: clock(commit.at)).font(.system(size: 11, design: .monospaced)).foregroundColor(.settingsTextMuted)
                    CopyChip(label: String(commit.sha.prefix(8)), value: commit.sha, tooltip: "Copy the commit hash")
                    Text(verbatim: commit.subject).font(.system(size: 12)).foregroundColor(Color.white.opacity(0.85)).lineLimit(1)
                    Spacer(minLength: 8)
                    Text(verbatim: commit.project ?? "").font(.system(size: 10.5)).foregroundColor(ReviewPalette.dim)
                }
                .frame(minHeight: 22)
            }
        }
        section("Files changed", count: digest.files.total) {
            ForEach(digest.files.repos) { repo in
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        PathLabel(path: repo.repo, font: .system(size: 12, weight: .medium), showIcons: false)
                        Text(verbatim: "\(repo.files) files").font(.system(size: 11)).foregroundColor(ReviewPalette.dim)
                        Text(verbatim: "+\(repo.added)").font(.system(size: 11, design: .monospaced)).foregroundColor(ReviewPalette.added)
                        Text(verbatim: "−\(repo.removed)").font(.system(size: 11, design: .monospaced)).foregroundColor(ReviewPalette.removed)
                    }
                    ForEach(repo.paths, id: \.self) { path in
                        HStack(spacing: 6) {
                            PathLabel(path: (repo.repo as NSString).appendingPathComponent(path.path), showIcons: false, title: path.path, color: Color.white.opacity(0.7))
                            Spacer(minLength: 8)
                            Text(verbatim: "+\(path.added) −\(path.removed)").font(.system(size: 10.5, design: .monospaced)).foregroundColor(ReviewPalette.dim)
                        }
                        .padding(.leading, 14)
                    }
                }
            }
        }
        section("Pull requests", count: digest.prs.opened.count + digest.prs.merged.count) {
            ForEach(digest.prs.opened) { pr in prRow("opened", pr) }
            ForEach(digest.prs.merged) { pr in prRow("merged", pr) }
        }
        section("Decisions", count: digest.decisions.posted.count + digest.decisions.answered.count) {
            ForEach(digest.decisions.posted) { decision in decisionRow("posted", decision) }
            ForEach(digest.decisions.answered) { decision in decisionRow("answered", decision) }
        }
        if digest.ci.failed + digest.ci.passed + digest.pushes > 0 {
            Text(verbatim: "CI: \(digest.ci.failed) failed, \(digest.ci.passed) passed · \(digest.pushes) pushes")
                .font(.system(size: 11))
                .foregroundColor(ReviewPalette.dim)
        }
    }

    private func section<Content: View>(_ title: String, count: Int?, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text(verbatim: title).font(.system(size: 12.5, weight: .semibold)).foregroundColor(.settingsText)
                if let count {
                    Text(verbatim: "\(count)").font(.system(size: 10.5, design: .monospaced)).foregroundColor(.settingsTextMuted)
                }
            }
            if count == 0 {
                Text("Nothing on this day.").font(.system(size: 11)).foregroundColor(.settingsTextMuted)
            } else {
                content()
            }
        }
    }

    private func row<Label: View>(_ action: @escaping () -> Void, @ViewBuilder label: () -> Label) -> some View {
        HStack(spacing: 8, content: label)
            .frame(minHeight: 22)
            .padding(.horizontal, 6)
            .rowButton(cornerRadius: 5, action)
    }

    private func prRow(_ verb: String, _ pr: HubDigest.Pr) -> some View {
        HStack(spacing: 8) {
            Text(verbatim: verb).font(.system(size: 10.5)).foregroundColor(verb == "merged" ? ReviewPalette.added : Color.jarvisTeal).frame(width: 50, alignment: .leading)
            ExternalLink(text: pr.ref, url: pr.url.flatMap(URL.init(string:)), font: .system(size: 11.5, design: .monospaced))
            Text(verbatim: pr.title).font(.system(size: 12)).foregroundColor(Color.white.opacity(0.85)).lineLimit(1)
            Spacer(minLength: 0)
        }
        .frame(minHeight: 22)
    }

    private func decisionRow(_ verb: String, _ decision: HubDigest.Decision) -> some View {
        row {
            hub.openDailySession(provider: nil, sessionId: decision.sessionId, title: nil, cwd: nil, project: decision.project, branch: nil, mtime: nil, query: "DECISION \(decision.number)")
            close()
        } label: {
            Text(verbatim: verb).font(.system(size: 10.5)).foregroundColor(verb == "answered" ? ReviewPalette.added : ReviewPalette.modified).frame(width: 58, alignment: .leading)
            Text(verbatim: "#\(decision.number) \(decision.title)").font(.system(size: 12)).foregroundColor(Color.white.opacity(0.85)).lineLimit(1)
            Spacer(minLength: 8)
            Text(verbatim: decision.answer ?? decision.project ?? "").font(.system(size: 10.5)).foregroundColor(ReviewPalette.dim).lineLimit(1)
        }
        .instantTooltip("Open the session at this decision")
    }

    private func clock(_ iso: String) -> String {
        guard let date = HubFormat.date(iso) else { return "" }
        return HubForecastFormat.clock(date)
    }
}
