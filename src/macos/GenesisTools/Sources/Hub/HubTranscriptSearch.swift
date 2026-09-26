import SwiftUI

// ⌥⌘F: search the transcripts of every indexed session (claude, codex, grok) through
// `tools hub search --json` (src/hub/lib/search.ts, each provider's own history search, no second
// index). Provider, project and date filters go into the query. Results are grouped by session with
// their matching snippets; a click opens the session with its transcript searched for the same text,
// which scrolls to the first matching turn. ⌘⇧F stays find in files (Hub/HubFind.swift).

struct HubSearchSnippet: Decodable, Equatable, Hashable, Sendable {
    let role: String
    let text: String
    let line: Int
    let timestamp: String?
    let tool: String?
}

struct HubSearchHit: Decodable, Equatable, Identifiable, Sendable {
    let provider: String
    let sessionId: String
    let title: String
    let project: String?
    let cwd: String
    let gitBranch: String?
    let mtime: String
    let account: String?
    let matchCount: Int
    let snippets: [HubSearchSnippet]

    var id: String { "\(provider):\(sessionId)" }
    var when: Date? { HubFormat.date(mtime) }
}

struct HubSearchProviderReport: Decodable, Equatable, Sendable {
    let hits: Int
    let ms: Int
    let error: String?
}

struct HubSearchResult: Decodable, Equatable, Sendable {
    let query: String
    let results: [HubSearchHit]
    let providers: [String: HubSearchProviderReport]
    let elapsedMs: Int
}

/// The date presets of the panel, as `--since` values.
enum HubSearchRange: String, CaseIterable, Sendable {
    case today, week, month, all

    var title: String {
        switch self {
        case .today: return "Today"
        case .week: return "7 days"
        case .month: return "30 days"
        case .all: return "Any time"
        }
    }

    var since: String? {
        switch self {
        case .today: return "today"
        case .week: return "7 days ago"
        case .month: return "30 days ago"
        case .all: return nil
        }
    }
}

enum HubSearchArgs {
    static let providers = ["claude", "codex", "grok"]

    /// The `tools hub search` argv for the panel's state: every filter goes into the query.
    static func build(query: String, providers: Set<String>, project: String, range: HubSearchRange, limit: Int = 40) -> [String] {
        var args = ["search", query, "--json", "--limit", String(limit)]
        let picked = Self.providers.filter { providers.contains($0) }
        if !picked.isEmpty, picked.count < Self.providers.count {
            args += ["--provider", picked.joined(separator: ",")]
        }
        let project = project.trimmingCharacters(in: .whitespaces)
        if !project.isEmpty {
            args += ["--project", project]
        }
        if let since = range.since {
            args += ["--since", since]
        }
        return args
    }
}

@MainActor
final class HubTranscriptSearchModel: ObservableObject {
    @Published var query = ""
    @Published var providers: Set<String> = Set(HubSearchArgs.providers)
    @Published var project = ""
    @Published var range: HubSearchRange = .month
    @Published private(set) var result: HubSearchResult?
    @Published private(set) var running = false
    @Published private(set) var error: String?
    private var generation = 0
    /// One search at a time: the newest request waits here and starts when the running one ends.
    private var inFlight = false
    private var pending: [String]?

    func search() {
        let text = query.trimmingCharacters(in: .whitespaces)
        guard text.count >= 2 else {
            result = nil
            error = text.isEmpty ? nil : "Type at least two characters."
            return
        }
        generation += 1
        running = true
        error = nil
        let args = HubSearchArgs.build(query: text, providers: providers, project: project, range: range)
        if inFlight {
            pending = args
        } else {
            start(args, token: generation)
        }
    }

    private func start(_ args: [String], token: Int) {
        inFlight = true
        Task {
            let outcome: Result<HubSearchResult, Error>
            do {
                outcome = .success(try await HubDailyCLI.decode(HubSearchResult.self, args, span: "search.sessions"))
            } catch {
                outcome = .failure(error)
            }
            inFlight = false
            if let next = pending {
                pending = nil
                start(next, token: generation)
                return
            }
            guard token == generation else { return }
            running = false
            switch outcome {
            case .success(let found):
                result = found
            case .failure(let failure):
                result = nil
                error = "Search failed: \(failure)"
            }
        }
    }

    /// "12 sessions · claude 8, codex 3, grok 1 · 4.2 s", with a failed provider named.
    var summary: String {
        guard let result else { return "" }
        let parts = HubSearchArgs.providers.compactMap { name -> String? in
            guard let report = result.providers[name] else { return nil }
            return report.error == nil ? "\(name) \(report.hits)" : "\(name) failed"
        }
        return "\(result.results.count) sessions · \(parts.joined(separator: ", ")) · \(String(format: "%.1f", Double(result.elapsedMs) / 1000)) s"
    }
}

struct HubTranscriptSearchPanel: View {
    @ObservedObject var hub: HubModel
    let seed: String
    let close: () -> Void
    @StateObject private var search = HubTranscriptSearchModel()
    @FocusState private var focused: Bool

    var body: some View {
        HubDailyCard(width: 820, close: close) {
            HStack(spacing: 8) {
                Image(systemName: "text.bubble").foregroundColor(Color.jarvisTeal)
                TextField("Search every session's transcript", text: $search.query)
                    .textFieldStyle(.plain)
                    .font(.system(size: 13))
                    .focused($focused)
                    .onSubmit { search.search() }
                    .accessibilityIdentifier("hub-session-search-input")
                HStack(spacing: 6) {
                    if search.running {
                        ProgressView().controlSize(.small)
                    }
                }
                .frame(width: 22, alignment: .trailing)
                IconButton(systemName: "xmark", tooltip: "Close (Esc)", size: 10, action: close)
            }
            .padding(12)
            filters
                .padding(.horizontal, 12)
                .padding(.bottom, 8)
            Divider().background(Color.jarvisBorder)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 2) {
                    if let error = search.error {
                        Text(verbatim: error).foregroundColor(ReviewPalette.removed).padding(16)
                    } else if let result = search.result, result.results.isEmpty {
                        Text(verbatim: "No session mentions “\(result.query)” with these filters.").foregroundColor(.settingsTextMuted).padding(16)
                    } else if search.result == nil, !search.running {
                        Text("Press Return to search titles, prompts, replies and tool calls of every session.")
                            .foregroundColor(.settingsTextMuted)
                            .padding(16)
                    }
                    ForEach(search.result?.results ?? []) { hit in
                        HubSearchHitRow(hit: hit) { open(hit) }
                    }
                }
                .padding(.vertical, 6)
            }
            .frame(maxHeight: 520)
            if !search.summary.isEmpty {
                Divider().background(Color.jarvisBorder)
                Text(verbatim: search.summary)
                    .font(.system(size: 10.5, design: .monospaced))
                    .foregroundColor(.settingsTextMuted)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
            }
        }
        .onAppear {
            search.query = seed
            focused = true
            if !seed.isEmpty {
                search.search()
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text("Search sessions"))
    }

    private var filters: some View {
        HStack(spacing: 6) {
            ForEach(HubSearchArgs.providers, id: \.self) { name in
                HubDailyChip(title: AIProviders.meta(for: name).displayName, on: search.providers.contains(name), tooltip: "Include \(name) sessions") {
                    if search.providers.contains(name) {
                        if search.providers.count > 1 { search.providers.remove(name) }
                    } else {
                        search.providers.insert(name)
                    }
                    search.search()
                }
            }
            Divider().frame(height: 14)
            ForEach(HubSearchRange.allCases, id: \.self) { range in
                HubDailyChip(title: range.title, on: search.range == range, tooltip: "Sessions active \(range == .all ? "at any time" : "in the last \(range.title.lowercased())")") {
                    search.range = range
                    search.search()
                }
            }
            Divider().frame(height: 14)
            TextField("Project", text: $search.project)
                .textFieldStyle(.plain)
                .font(.system(size: 11.5))
                .frame(width: 130)
                .onSubmit { search.search() }
                .instantTooltip("Only sessions of this project (its folder name); Return applies it")
            Spacer()
        }
    }

    private func open(_ hit: HubSearchHit) {
        hub.openDailySession(
            provider: hit.provider, sessionId: hit.sessionId, title: hit.title, cwd: hit.cwd, project: hit.project,
            branch: hit.gitBranch, mtime: hit.when, query: search.result?.query ?? search.query
        )
        close()
    }
}

/// One session of the results: its title line, then up to three matching snippets.
private struct HubSearchHitRow: View {
    let hit: HubSearchHit
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(verbatim: AIProviders.meta(for: hit.provider).displayName)
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundColor(Color.jarvisTeal)
                    Text(verbatim: TitleFormatter.cleanSessionTitle(hit.title) ?? String(hit.sessionId.prefix(8)))
                        .font(.system(size: 12.5, weight: .medium))
                        .foregroundColor(Color.white.opacity(0.9))
                        .lineLimit(1)
                    Spacer(minLength: 8)
                    LiveAgo(date: hit.when) { ago in
                        [hit.project ?? (hit.cwd as NSString).lastPathComponent, ago].filter { !$0.isEmpty }.joined(separator: " · ")
                    }
                    .font(.system(size: 10.5))
                    .foregroundColor(ReviewPalette.dim)
                    .lineLimit(1)
                }
                ForEach(hit.snippets, id: \.self) { snippet in
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(verbatim: snippet.tool ?? snippet.role)
                            .font(.system(size: 9.5, design: .monospaced))
                            .foregroundColor(.settingsTextMuted)
                            .frame(width: 58, alignment: .trailing)
                            .lineLimit(1)
                        Text(verbatim: snippet.text)
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundColor(Color.white.opacity(0.7))
                            .lineLimit(2)
                            .truncationMode(.tail)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .contentShape(Rectangle())
        }
        .buttonStyle(HubRowButtonStyle(cornerRadius: 6))
        .padding(.horizontal, 4)
        .instantTooltip("Open this session at the first matching turn")
    }
}
