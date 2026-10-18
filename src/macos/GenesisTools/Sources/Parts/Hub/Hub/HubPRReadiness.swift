import Foundation
import SwiftUI

// PRs mode: a "ready to merge?" badge on each open PR, from `tools hub pr readiness <url>@<head>… --json`
// (src/hub/lib/pr-readiness.ts): unresolved non-outdated threads of every reviewer, CI, whether the
// newest review is older than the newest push, conflicts, drafts, requested changes. Asked once per
// PR list load, never on a timer: the tools side serves a cached answer for an unchanged head (up to
// 10 minutes old) without calling the forge, so a reload costs one `tools` process, not a GraphQL
// query per PR.

struct PRReadiness: Codable, Equatable {
    struct AuthorCount: Codable, Equatable {
        let author: String
        let count: Int
    }

    let url: String
    let headSha: String?
    let state: String
    let draft: Bool
    let ci: String?
    let unresolved: Int
    let unresolvedBy: [AuthorCount]
    let outdatedUnresolved: Int
    let lastReviewAt: String?
    let lastReviewBy: String?
    let lastPushAt: String?
    let reviewedHead: Bool?
    let staleReviewers: [String]
    /// ready, waiting, blocked or closed.
    let verdict: String
    let reasons: [String]
    let summary: String
    let fetchedAt: String
    let cached: Bool

    /// The badge's tooltip: the verdict as its title, then every reason and who still owes a re-review
    /// as bullets. A ready PR has no reasons; its summary's facts ("CI green, no open threads") stand in.
    var tooltip: TooltipContent {
        let title: String
        var bullets = reasons
        switch verdict {
        case "ready":
            title = "Ready to merge"
            if bullets.isEmpty, let facts = summary.split(separator: ":", maxSplits: 1).dropFirst().first {
                bullets = facts.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
            }
        case "closed":
            title = "Closed"
        default:
            title = verdict.prefix(1).uppercased() + verdict.dropFirst()
        }
        if !staleReviewers.isEmpty {
            bullets.append("re-review due from \(staleReviewers.joined(separator: ", "))")
        }
        if outdatedUnresolved > 0 {
            bullets.append("\(outdatedUnresolved) outdated thread\(outdatedUnresolved == 1 ? "" : "s") still unresolved (not blocking)")
        }
        return TooltipContent(title: title, bullets: bullets.map { $0.prefix(1).uppercased() + $0.dropFirst() })
    }
}

struct PRReadinessOutcome: Decodable {
    let input: String
    let readiness: PRReadiness?
    let error: String?
}

enum PRReadinessQuery {
    /// URLs per `tools` call: each call works four PRs at a time, and a call reports as one batch.
    static let batch = 12

    /// `<url>@<head>` for every open PR with a URL: the head lets the tools side answer from its cache.
    static func inputs(_ prs: [HubPR]) -> [String] {
        prs.filter { $0.state.uppercased() == "OPEN" && !$0.url.isEmpty }.map { pr in
            pr.headSha.map { "\(pr.url)@\($0)" } ?? pr.url
        }
    }
}

@MainActor
final class PRReadinessStore: ObservableObject {
    static let shared = PRReadinessStore()

    /// By PR URL (`HubPR.url`).
    @Published private(set) var byURL: [String: PRReadiness] = [:]
    @Published private(set) var loading = false
    private var pending: [HubPR]?
    /// The disk's last verdicts, read once per run; a fresh batch waits for it so it never lands after one.
    private var cachePaint: Task<Void, Never>?
    nonisolated private static let cache = HubSWR.cache("pr-readiness")

    func readiness(for pr: HubPR) -> PRReadiness? {
        guard let found = byURL[pr.url] else { return nil }
        // A push since the answer: the old verdict would lie, so the badge waits for the new one.
        if let head = pr.headSha, let known = found.headSha, head != known { return nil }
        return found
    }

    /// The last known verdicts at once (Hub/HubSWR.swift), when the PR list paints its own cached rows. They
    /// used to wait for the first fresh list, so the rows and the PR header had no badge for as long as the
    /// forge took (`hub.prs.list` 8.6 s for ten projects, 2026-10-10 21:21). `readiness(for:)` still drops a
    /// verdict whose head is not the PR's head now. Not animated: a first paint of every row at once.
    func paintCached() {
        guard cachePaint == nil, byURL.isEmpty else { return }
        cachePaint = Task {
            guard let cached = await Self.cache.load([String: PRReadiness].self, key: "all"), byURL.isEmpty, !cached.isEmpty else { return }
            HubSWR.painted("prs.readiness", "\(cached.count) prs")
            byURL = cached
        }
    }

    /// After each PR list load. A load that lands while one runs is kept and runs next.
    func refresh(_ prs: [HubPR]) {
        let inputs = PRReadinessQuery.inputs(prs)
        guard !inputs.isEmpty else { return }
        guard !loading else {
            pending = prs
            return
        }

        loading = true
        paintCached()
        Task {
            await cachePaint?.value
            defer {
                let snapshot = byURL
                Task.detached(priority: .utility) { Self.cache.write(snapshot, key: "all") }
            }
            var index = 0
            while index < inputs.count {
                let batch = Array(inputs[index..<min(index + PRReadinessQuery.batch, inputs.count)])
                index += batch.count
                let span = HubPerf.begin("prs.readiness", "\(batch.count) prs", awaits: true)
                let result = await Task.detached(priority: .utility) { () -> Result<[PRReadinessOutcome], Error> in
                    Result {
                        // Exit 1 means "some failed"; each outcome carries its own error.
                        let capture = try ToolsCLIRunner.capture(["hub", "pr", "readiness"] + batch + ["--json", "--max-cache-age", "600"], timeout: 120)
                        return try JSONDecoder().decode([PRReadinessOutcome].self, from: capture.stdout)
                    }
                }.value
                switch result {
                case .success(let outcomes):
                    let found = outcomes.compactMap(\.readiness)
                    span.end("\(found.count) answered, \(found.filter(\.cached).count) cached, \(outcomes.count - found.count) failed")
                    // Which PR failed and why: the count alone could not be traced to a PR (the call's argv is
                    // cut at 300 characters), and the one failure on record was a forge token that could not
                    // see a private repository (GraphQL NOT_FOUND, 2026-10-04).
                    for outcome in outcomes where outcome.readiness == nil {
                        HubPerf.log("prs.readiness \(outcome.input) failed: \(outcome.error ?? "no answer")")
                    }
                    var next = byURL
                    for readiness in found {
                        next[readiness.url] = readiness
                    }
                    if next != byURL {
                        byURL = next
                        HubMainBusy.measure("prs.readiness.render")
                    }
                case .failure(let error):
                    span.end("failed: \(error)")
                }
            }
            loading = false
            if let next = pending {
                pending = nil
                refresh(next)
            }
        }
    }
}

/// The PR detail header's verdict with its first reason in words; it observes the store itself, so the
/// header does not re-render for other PRs' answers.
struct PRReadinessHeaderChip: View {
    let pr: HubPR
    @ObservedObject private var store = PRReadinessStore.shared

    var body: some View {
        if let readiness = store.readiness(for: pr), readiness.verdict != "closed" {
            HStack(spacing: 6) {
                // The verdict word: the reason beside it already says "4 unresolved threads".
                PRReadinessBadge(readiness: readiness, verdictWord: true)
                Text(verbatim: readiness.reasons.first ?? readiness.summary)
                    .font(.system(size: 11))
                    .foregroundColor(ReviewPalette.dim)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .instantTooltip(readiness.tooltip)
            }
        }
    }
}

/// A PR row's readiness chip: a value, drawn with a tooltip that holds every reason.
struct PRReadinessBadge: View {
    let readiness: PRReadiness?
    /// "blocked" instead of "4 open", where the reason is shown beside it.
    var verdictWord = false

    var body: some View {
        if let readiness, readiness.verdict != "closed" {
            let (symbol, color, text) = Self.look(readiness, verdictWord: verdictWord)
            Label(text, systemImage: symbol)
                .labelStyle(.titleAndIcon)
                .font(.system(size: 10.5, weight: .semibold))
                .foregroundColor(color)
                .lineLimit(1)
                .fixedSize()
                .instantTooltip(readiness.tooltip)
        }
    }

    static func look(_ readiness: PRReadiness, verdictWord: Bool = false) -> (String, Color, String) {
        switch readiness.verdict {
        case "ready":
            return ("checkmark.seal.fill", ReviewPalette.added, "ready")
        case "blocked":
            let text = verdictWord ? "blocked" : readiness.unresolved > 0 ? "\(readiness.unresolved) open" : readiness.ci == "failed" ? "CI" : "blocked"
            return ("xmark.octagon.fill", ReviewPalette.removed, text)
        default:
            return ("clock", ReviewPalette.modified, readiness.reviewedHead == false ? "re-review" : "waiting")
        }
    }
}
