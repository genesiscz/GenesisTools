import SwiftUI

// The stuck-agent detector's hub side: a live session whose last tool call has waited too long, or
// that repeats one call, gets a badge in the session list and a line in the session header. The
// verdicts come from `tools hub stuck --json --session …` (src/hub/lib/insights/stuck.ts), the same
// command a terminal runs, polled while the session list shows live sessions.

struct StuckCheckEnvelope: Decodable {
    struct Session: Decodable {
        let sessionId: String
        let verdict: StuckVerdict?
        let error: String?
    }

    let thresholds: StuckThresholds
    let checked: Int
    let sessions: [Session]
}

enum HubStuck {
    static func decode(_ data: Data) throws -> StuckCheckEnvelope {
        try JSONDecoder().decode(StuckCheckEnvelope.self, from: MonitorJSON.dataByDroppingPreamble(data))
    }

    /// Blocking: call off the main thread.
    static func check(_ sessionIds: [String]) throws -> StuckCheckEnvelope {
        try decode(ToolsCLIRunner.run(arguments(sessionIds)))
    }

    static func arguments(_ sessionIds: [String]) -> [String] {
        ["hub", "stuck", "check", "--json", "--session"] + sessionIds
    }

    /// `tools hub stuck config`: blocking, off the main thread.
    static func save(toolMinutes: Int? = nil, repeats: Int? = nil) throws {
        var args = ["hub", "stuck", "config", "--json"]
        if let toolMinutes { args += ["--tool-minutes", String(toolMinutes)] }
        if let repeats { args += ["--repeats", String(repeats)] }
        _ = try ToolsCLIRunner.run(args)
    }

    /// The sessions worth watching: live now, or held by a cmux pane (a long tool call stops the file
    /// writes that `isLive` reads, the pane keeps holding the process).
    static func watched(_ sessions: [HubSession]) -> [String] {
        sessions.filter { $0.isLive || $0.cmux != nil }.map(\.sessionId).sorted()
    }
}

@MainActor
final class HubStuckStore: ObservableObject {
    static let shared = HubStuckStore()
    @Published private(set) var verdicts: [String: StuckVerdict] = [:]
    @Published private(set) var thresholds: StuckThresholds?

    /// Two minutes: the wait threshold is ten, and each poll reads every watched session's tail.
    static let interval: Duration = .seconds(120)
    /// The ids the running `watch` polls, for a poll right after a threshold change.
    private var watchedIds: [String] = []

    /// Polls until cancelled (the session list's `.task` ends it when the watched set changes).
    func watch(_ sessionIds: [String]) async {
        watchedIds = sessionIds
        while !Task.isCancelled {
            await refresh(sessionIds)
            try? await Task.sleep(for: Self.interval)
        }
    }

    func refresh(_ sessionIds: [String]) async {
        guard !sessionIds.isEmpty else {
            if !verdicts.isEmpty { verdicts = [:] }
            return
        }

        let span = HubPerf.begin("stuck.poll", "\(sessionIds.count) sessions", awaits: true)
        let result = await Task.detached(priority: .utility) { Result { try HubStuck.check(sessionIds) } }.value
        switch result {
        case .success(let envelope):
            var next: [String: StuckVerdict] = [:]
            for session in envelope.sessions {
                if let verdict = session.verdict { next[session.sessionId] = verdict }
            }
            span.end("\(next.count) of \(envelope.checked) flagged")
            if next != verdicts { verdicts = next }
            if thresholds != envelope.thresholds { thresholds = envelope.thresholds }
        case .failure(let error):
            span.end("failed: \(error.localizedDescription)")
        }
    }

    /// A verdict the session's insights brought (the open session, between polls).
    func apply(_ verdict: StuckVerdict?, sessionId: String) {
        guard verdicts[sessionId] != verdict else { return }
        verdicts[sessionId] = verdict
    }

    /// Saves a threshold and polls again, so the badges follow at once.
    func save(toolMinutes: Int? = nil, repeats: Int? = nil) async -> String? {
        let result = await Task.detached(priority: .userInitiated) { Result { try HubStuck.save(toolMinutes: toolMinutes, repeats: repeats) } }.value
        if case .failure(let error) = result {
            return "Saving the thresholds failed: \(error.localizedDescription)"
        }

        await refresh(watchedIds)
        return nil
    }
}

/// The session row's badge: `stuck` (orange) or `loop` (red), the verdict in its tooltip.
struct StuckBadge: View {
    let verdict: StuckVerdict

    var body: some View {
        Text(verbatim: verdict.badge)
            .font(.system(size: 9.5, weight: .bold))
            .foregroundColor(verdict.color)
            .padding(.horizontal, 5)
            .padding(.vertical, 1)
            .background(Capsule().fill(verdict.color.opacity(0.16)))
            .overlay(Capsule().stroke(verdict.color.opacity(0.5), lineWidth: 0.5))
            .fixedSize()
            .instantTooltip(verdict.line)
            .accessibilityLabel(Text(verbatim: verdict.line))
    }
}

/// The thresholds as a pull-down: presets for the wait and the repeat count, saved through the CLI.
struct StuckThresholdsMenu: View {
    let thresholds: StuckThresholds?
    let onSave: (_ toolMinutes: Int?, _ repeats: Int?) -> Void

    var body: some View {
        MenuButton {
            let minutes = thresholds?.toolMinutes
            let repeats = thresholds?.repeats
            return [
                .note("A call waiting this long is stuck"),
            ] + [5, 10, 15, 30, 60].map { value in
                MenuButtonItem.action("\(value) min", checked: value == minutes) { onSave(value, nil) }
            } + [
                .divider,
                .note("This many identical calls in a row is a loop"),
            ] + [3, 5, 8, 12].map { value in
                MenuButtonItem.action("\(value) calls", checked: value == repeats) { onSave(nil, value) }
            }
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "exclamationmark.octagon")
                    .font(.system(size: 10))
                Text(verbatim: thresholds.map { "Stuck after \($0.toolMinutes) min or \($0.repeats) repeats" } ?? "Stuck thresholds")
                Image(systemName: "chevron.down")
                    .font(.system(size: 7, weight: .bold))
            }
            .font(.system(size: 11))
            .foregroundStyle(SessionPalette.dim)
            .lineLimit(1)
        }
        .fixedSize()
        .instantTooltip("When the session list and header call an agent stuck (tools hub stuck config)")
        .accessibilityIdentifier("session-details-stuck-thresholds")
    }
}
