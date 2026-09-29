import Foundation
import SwiftUI

// The PR detail's Checks section. A failed check opens to the failing part of its job log
// (`tools hub pr check-log`, src/hub/lib/checks.ts: a GitHub Actions job sliced to its failed steps,
// or a GitLab job trace), fetched on demand and cached by the CLI once the job has finished.
// "Send to agent" hands the log to the session that owns the branch, through the same task path as
// "Fix these threads" (`tools hub pr fix-check`, Review/FixThreads.swift).

struct HubCheckLog: Decodable, Equatable {
    struct Section: Decodable, Equatable, Identifiable {
        let name: String
        let url: String?
        let status: String?
        let lines: [String]
        let totalLines: Int
        var id: String { name }
    }

    let url: String
    let provider: String?
    let sections: [Section]
    let errors: [String]
    let final: Bool
    let cached: Bool
    let elapsedMs: Int
    let error: String?

    /// Everything as plain text, for Copy.
    var plainText: String {
        var parts = errors.map { "error: \($0)" }
        for section in sections {
            parts.append("── \(section.name) ──")
            parts.append(contentsOf: section.lines)
        }
        return parts.joined(separator: "\n")
    }
}

/// One failed section's lines as a single attributed text (one `Text`, not one view per line), with
/// error and warning lines tinted. Built off the main thread when the log arrives.
struct CheckLogRender: Equatable {
    let log: HubCheckLog
    let sections: [String: AttributedString]

    static func build(_ log: HubCheckLog) -> CheckLogRender {
        var sections: [String: AttributedString] = [:]
        for section in log.sections {
            var text = AttributedString()
            for (index, line) in section.lines.enumerated() {
                var piece = AttributedString(line + (index == section.lines.count - 1 ? "" : "\n"))
                let lower = line.lowercased()
                if line.hasPrefix("##[error]") || lower.contains("error") || line.contains("FAIL") || line.contains("✗") {
                    piece.foregroundColor = ReviewPalette.removed
                } else if line.hasPrefix("##[warning]") || lower.hasPrefix("warning") {
                    piece.foregroundColor = ReviewPalette.modified
                }
                text.append(piece)
            }
            sections[section.id] = text
        }
        return CheckLogRender(log: log, sections: sections)
    }
}

@MainActor
final class CheckLogStore: ObservableObject {
    static let shared = CheckLogStore()

    @Published private(set) var logs: [String: CheckLogRender] = [:]
    @Published private(set) var loading: Set<String> = []
    @Published private(set) var failures: [String: String] = [:]

    func load(_ url: String, fresh: Bool = false) {
        guard !loading.contains(url), fresh || logs[url] == nil else { return }
        loading.insert(url)
        failures[url] = nil
        let args = ["hub", "pr", "check-log", url, "--json"] + (fresh ? ["--no-cache"] : [])
        Task {
            let span = HubPerf.begin("prs.checkLog", url, awaits: true)
            let result = await Task.detached(priority: .userInitiated) { () -> Result<CheckLogRender, Error> in
                Result {
                    // A run URL can fetch three jobs' logs; the CLI's own host calls time out at 90 s each.
                    let output = try ToolsCLIRunner.capture(args, timeout: 180)
                    return CheckLogRender.build(try JSONDecoder().decode(HubCheckLog.self, from: output.stdout))
                }
            }.value
            loading.remove(url)
            switch result {
            case .success(let render):
                span.end("\(render.log.sections.count) sections \(render.log.cached ? "cached" : "\(render.log.elapsedMs) ms")")
                logs[url] = render
            case .failure(let error):
                span.end("failed")
                failures[url] = "\(error)"
            }
        }
    }
}

/// Failed first, then running, pending, passed and skipped; the host's order inside each.
private func checkRank(_ status: String?) -> Int {
    switch status {
    case "failed": return 0
    case "running": return 1
    case "pending": return 2
    case "success": return 3
    default: return 4
    }
}

struct PRChecksSection: View {
    @ObservedObject var model: HubModel
    let pr: HubPR
    let checks: [HubPRDetail.Check]
    @Binding var folded: Bool
    @ObservedObject private var store = CheckLogStore.shared
    @State private var expanded: Set<String> = []
    @State private var sending: HubPRDetail.Check?

    private var sorted: [HubPRDetail.Check] { Self.sorted(checks) }

    /// Failed first, then running, then the rest, each in the host's order (the overview's find
    /// reads the same order).
    static func sorted(_ checks: [HubPRDetail.Check]) -> [HubPRDetail.Check] {
        checks.enumerated()
            .sorted { (checkRank($0.element.status), $0.offset) < (checkRank($1.element.status), $1.offset) }
            .map(\.element)
    }

    private var failedCount: Int { checks.filter { $0.status == "failed" }.count }

    private static var snapshotOpensLogs: Bool {
        ProcessInfo.processInfo.environment["GENESIS_HUB_OPEN_FAILED_LOGS"] == "1" && HubDefaults.isolated
    }

    /// Scripted snapshots of the log panel fold the sections above Checks, so the lazy overview
    /// realizes it. Scratch store only (`HubDefaults.isolated`): the live layout is never touched.
    static func prepareSnapshot() {
        guard snapshotOpensLogs else { return }
        for key in ["hub.prs.fold.description", "hub.prs.fold.sessions", "hub.prs.fold.commits"] {
            HubDefaults.store.set(true, forKey: key)
        }
    }

    var body: some View {
        PRSection(title: "Checks", count: checks.count, folded: $folded, trailing: failedCount == 0 ? nil : AnyView(
            Text(verbatim: "\(failedCount) failed")
                .font(.system(size: 11))
                .foregroundColor(ReviewPalette.removed)
        )) {
            ForEach(sorted) { check in
                row(check)
                    .findRow("check:\(check.id)", cornerRadius: 6)
                if expanded.contains(check.id), let url = check.url {
                    logPanel(check, url: url)
                }
            }
        }
        .onAppear {
            // Scripted snapshots of the log panel: `GENESIS_HUB_OPEN_FAILED_LOGS=1 GenesisTools --hub … --snapshot`.
            guard Self.snapshotOpensLogs else { return }
            for check in checks where check.status == "failed" && check.url != nil && !expanded.contains(check.id) {
                toggle(check)
            }
        }
    }

    private func row(_ check: HubPRDetail.Check) -> some View {
        let open = expanded.contains(check.id)
        let canLog = check.status == "failed" && check.url != nil
        return HStack(spacing: 8) {
            CIBadge(ci: check.status)
            ExternalLink(text: check.name, url: check.url.flatMap(URL.init(string:)), glyph: .onHover)
            Spacer(minLength: 4)
            if canLog {
                Button {
                    toggle(check)
                } label: {
                    HStack(spacing: 4) {
                        Text(open ? "Hide log" : "Log")
                        Image(systemName: "chevron.right")
                            .font(.system(size: 9, weight: .semibold))
                            .rotationEffect(.degrees(open ? 90 : 0))
                    }
                    .font(.system(size: 11.5))
                    .foregroundColor(ReviewPalette.dim)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.genHoverPlain())
                .instantTooltip(open ? "Hide the failing log" : "Show the failing part of this check's job log")
            }
        }
    }

    private func toggle(_ check: HubPRDetail.Check) {
        guard let url = check.url else { return }
        if expanded.contains(check.id) {
            expanded.remove(check.id)
        } else {
            expanded.insert(check.id)
            store.load(url)
        }
    }

    @ViewBuilder
    private func logPanel(_ check: HubPRDetail.Check, url: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if store.loading.contains(url) && store.logs[url] == nil {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text("Fetching the failing log…").font(.system(size: 11.5)).foregroundColor(ReviewPalette.dim)
                }
            } else if let failure = store.failures[url] {
                NoticePill(text: "The log could not be read", detail: failure, isError: true) {}
            } else if let render = store.logs[url] {
                logBody(render)
                toolbar(check, url: url, render: render)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 6).fill(Color.black.opacity(0.28)))
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(ReviewPalette.hairline))
        .padding(.leading, 18)
        .popover(isPresented: Binding(get: { sending?.id == check.id }, set: { if !$0 { sending = nil } }), arrowEdge: .bottom) {
            CheckSendForm(model: model, pr: pr, check: check) { sending = nil }
        }
    }

    @ViewBuilder
    private func logBody(_ render: CheckLogRender) -> some View {
        let log = render.log
        if let error = log.error {
            Text(verbatim: error).font(.system(size: 11.5)).foregroundColor(ReviewPalette.dim).textSelection(.enabled)
        }
        if !log.errors.isEmpty {
            VStack(alignment: .leading, spacing: 2) {
                ForEach(log.errors, id: \.self) { line in
                    Text(verbatim: line)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundColor(ReviewPalette.removed)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        ForEach(log.sections) { section in
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(verbatim: section.name).font(.system(size: 11.5, weight: .semibold)).lineLimit(1).truncationMode(.middle)
                        .instantTooltip(section.name)
                    Text(verbatim: section.totalLines > section.lines.count ? "last \(section.lines.count) of \(section.totalLines) lines" : "\(section.lines.count) lines")
                        .font(.system(size: 10.5, design: .monospaced))
                        .foregroundColor(ReviewPalette.dim)
                    Spacer(minLength: 4)
                    if let job = section.url.flatMap(URL.init(string:)) {
                        ExternalLink(text: "Job", url: job, font: .system(size: 11))
                    }
                }
                // Opens at the bottom, where a failure shows.
                ScrollViewReader { proxy in
                    ScrollView(.vertical) {
                        Text(render.sections[section.id] ?? AttributedString())
                            .font(.system(size: 10.5, design: .monospaced))
                            .foregroundColor(Color.white.opacity(0.82))
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .fixedSize(horizontal: false, vertical: true)
                        Color.clear.frame(height: 1).id("end")
                    }
                    .frame(maxHeight: 260)
                    .onAppear { proxy.scrollTo("end", anchor: .bottom) }
                }
            }
        }
    }

    private func toolbar(_ check: HubPRDetail.Check, url: String, render: CheckLogRender) -> some View {
        HStack(spacing: 10) {
            Button {
                sending = check
            } label: {
                Label("Send to agent", systemImage: "paperplane")
            }
            .buttonStyle(.genHoverPlain())
            .disabled(pr.repoRoot == nil)
            .instantTooltip(pr.repoRoot == nil
                ? "This PR has no local checkout to start or find an agent in"
                : "Give this log to the session that owns the branch (or a new one) as a task file; nothing is posted")
            Button {
                PathOpener.copy(render.log.plainText)
                model.notice = "Log copied"
            } label: {
                Label("Copy", systemImage: "doc.on.doc")
            }
            .buttonStyle(.genHoverPlain())
            .instantTooltip("Copy the error lines and the failed sections")
            Spacer(minLength: 4)
            Text(verbatim: render.log.cached ? "cached" : render.log.final ? "\(render.log.elapsedMs) ms" : "still running")
                .font(.system(size: 10.5, design: .monospaced))
                .foregroundColor(ReviewPalette.dim)
            IconButton(systemName: "arrow.clockwise", tooltip: "Fetch the log again") { store.load(url, fresh: true) }
        }
        .font(.system(size: 11.5))
        .foregroundColor(ReviewPalette.dim)
    }
}

/// "Send to agent" for one failed check: the shared task form (Review/FixThreads.swift) with the
/// `tools hub pr fix-check` verb, which puts the failing log into the task file.
struct CheckSendForm: View {
    @ObservedObject var model: HubModel
    let pr: HubPR
    let check: HubPRDetail.Check
    let close: () -> Void

    var body: some View {
        let repo = pr.localWorktree ?? pr.repoRoot ?? ""
        let ref = pr.url.isEmpty ? "\(repo)#\(pr.number)" : pr.url
        PRTaskForm(
            title: "Send the \(check.name) log",
            subtitle: "The failing log goes into a task file; the agent gets one line that names it. Nothing is posted on the \(pr.isGitLab ? "MR" : "PR").",
            what: "the \(check.name) log",
            cwd: repo,
            newAgentName: "Fix \(pr.repo) \(pr.label) CI",
            branch: pr.headBranch,
            perfArea: "prs.fixCheck",
            disabled: check.url == nil || repo.isEmpty,
            argv: { session, send, dryRun in
                PRCommand.fixCheck(.ref(ref), repo: repo, checkURL: check.url ?? "", name: check.name,
                                   session: session, send: send, dryRun: dryRun)
            },
            finished: { notice, _ in model.notice = notice },
            close: close
        ) {
            EmptyView()
        }
    }
}
