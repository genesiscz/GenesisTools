import Foundation
import SwiftUI

// History search in the session list: the filter text also runs `tools claude history --all --json`
// (the same search as the CLI: every project, titles, prompts, replies, tool inputs), and the hits the
// list does not already show appear under "History". A hit older than the list's window becomes a row
// on the spot, so it opens like any other session.

struct HubHistoryHit: Decodable, Identifiable, Equatable {
    let kind: String?
    let sessionId: String
    let title: String?
    let cwd: String?
    let project: String?
    let gitBranch: String?
    let mtime: String?
    let matchedText: String?

    var id: String { sessionId }

    var when: Date? { HubFormat.date(mtime) }

    /// The first non-empty line of the match, for one row.
    var snippet: String? {
        matchedText?.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.first { !$0.isEmpty }
    }

    /// A list row for a session older than the list's window (only what the history search knows).
    var sessionRow: HubSession {
        let folder = cwd ?? ""
        return HubSession(
            provider: kind ?? HubSession.claudeProvider,
            sessionId: sessionId,
            title: title,
            cwd: folder,
            cwdShort: (folder as NSString).lastPathComponent,
            project: project,
            gitBranch: gitBranch,
            mtime: (when?.timeIntervalSince1970 ?? 0) * 1000,
            modelSwitched: false,
            filePath: ""
        )
    }
}

@MainActor
final class HubHistoryModel: ObservableObject {
    @Published private(set) var hits: [HubHistoryHit] = []
    @Published private(set) var running = false
    @Published private(set) var query = ""
    @Published private(set) var error: String?
    private var generation = 0
    /// One `tools claude history` at a time: a query typed while one runs waits here (the newest
    /// wins) and starts when it ends, so stale searches never pile up as parallel processes.
    private var inFlight = false
    private var pending: String?

    func search(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        guard trimmed.count >= 3 else {
            clear()
            return
        }
        guard trimmed != query || error != nil else { return }
        generation += 1
        query = trimmed
        running = true
        error = nil
        if inFlight {
            pending = trimmed
        } else {
            start(trimmed, token: generation)
        }
    }

    private func start(_ trimmed: String, token: Int) {
        inFlight = true
        Task {
            let span = HubPerf.begin("history.search", "\(trimmed.count) chars", awaits: true)
            let result = await Task.detached(priority: .userInitiated) { () -> Result<[HubHistoryHit], Error> in
                Result {
                    let data = try ToolsCLIRunner.run(["claude", "history", "--all", "--json", "--limit", "30", "-q", trimmed])
                    return try JSONDecoder().decode([HubHistoryHit].self, from: data)
                }
            }.value
            inFlight = false
            if let next = pending {
                pending = nil
                span.end("superseded")
                start(next, token: generation)
                return
            }
            guard token == generation else {
                span.end("superseded")
                return
            }
            running = false
            switch result {
            case .success(let found):
                span.end("\(found.count) hits")
                hits = found
            case .failure(let failure):
                span.end("failed")
                hits = []
                error = "History search failed: \(failure)"
            }
        }
    }

    func clear() {
        generation += 1
        pending = nil
        hits = []
        query = ""
        running = false
        error = nil
    }
}

struct HubHistorySection: View {
    @ObservedObject var model: HubModel
    @ObservedObject var history: HubHistoryModel
    /// Sessions the list already shows for this filter: not repeated here.
    let shown: Set<String>

    var body: some View {
        let hits = history.hits.filter { !shown.contains($0.sessionId) }
        if history.running || !hits.isEmpty || history.error != nil {
            Section {
                if let error = history.error {
                    Text(verbatim: error).font(.system(size: 11)).foregroundColor(ReviewPalette.removed).padding(.horizontal, 14)
                }
                ForEach(hits) { hit in
                    Button { model.openHistory(hit) } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(verbatim: hit.title ?? hit.sessionId)
                                .font(.system(size: 12, weight: .medium))
                                .foregroundColor(Color.white.opacity(0.88))
                                .lineLimit(1)
                            Text(verbatim: [hit.project ?? (hit.cwd as NSString?)?.lastPathComponent, hit.when.map { HubFormat.ago($0) }].compactMap { $0 }.joined(separator: " · "))
                                .font(.system(size: 10.5))
                                .foregroundColor(ReviewPalette.dim)
                                .lineLimit(1)
                            if let snippet = hit.snippet {
                                Text(verbatim: snippet)
                                    .font(.system(size: 10.5, design: .monospaced))
                                    .foregroundColor(ReviewPalette.dim)
                                    .lineLimit(1)
                                    .truncationMode(.middle)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 5)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.genHoverRow(accent: .white, cornerRadius: 6))
                    .instantTooltip("Open this session (from tools claude history)")
                }
            } header: {
                HStack {
                    Text("History")
                    if history.running {
                        ProgressView().controlSize(.mini)
                    }
                    Spacer()
                    Text(verbatim: "\(hits.count)").font(.system(size: 10.5, design: .monospaced))
                }
                .font(.system(size: 11.5, weight: .semibold))
                .foregroundColor(ReviewPalette.dim)
                .padding(.horizontal, 14)
                .padding(.vertical, 6)
                .hubSurface(.bar)
                .instantTooltip("Every project's history for “\(history.query)” (tools claude history --all)")
            }
        }
    }
}
