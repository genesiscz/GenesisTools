import AppKit
import SwiftUI

// The hub's cross-session and daily overlays: transcript search over every session (⌥⌘F,
// Hub/HubTranscriptSearch.swift), the Today digest (⌥⌘D, Hub/HubDigest.swift) with the usage forecast
// (Hub/HubForecast.swift) and the notification rules (Hub/HubRules.swift). Each reads one `tools hub`
// door (`search`, `digest`, `forecast`, `rules`) off the main thread; the root view adds them with
// `.hubDaily(model:)`, one line, so HubWindow.swift carries no state of theirs.

@MainActor
final class HubDailyModel: ObservableObject {
    static let shared = HubDailyModel()

    /// The transcript search panel is open, seeded with this text ("" = empty field).
    @Published var searchQuery: String?
    @Published var digestOpen = false
    @Published var rulesOpen = false

    func toggleSearch() {
        searchQuery = searchQuery == nil ? "" : nil
    }

    func toggleDigest() {
        digestOpen.toggle()
    }
}

/// `tools hub <args> --json` decoded off the main thread (a `tools` run is 0.1 s to several seconds).
enum HubDailyCLI {
    static func decode<T: Decodable & Sendable>(_ type: T.Type, _ args: [String], span name: String) async throws -> T {
        let span = HubPerf.begin(name, args.dropFirst().prefix(3).joined(separator: " "), awaits: true)
        do {
            let value = try await Task.detached(priority: .userInitiated) { () throws -> T in
                let data = try ToolsCLIRunner.run(["hub"] + args)
                return try JSONDecoder().decode(T.self, from: data)
            }.value
            span.end()
            return value
        } catch {
            span.end("failed")
            HubPerf.log("\(name) failed: \(error)")
            throw error
        }
    }

    /// A `tools hub` write (rules add/set/rm, digest config) whose output is not needed.
    static func run(_ args: [String], span name: String) async throws {
        let span = HubPerf.begin(name, args.prefix(2).joined(separator: " "), awaits: true)
        do {
            _ = try await Task.detached(priority: .userInitiated) { try ToolsCLIRunner.run(["hub"] + args) }.value
            span.end()
        } catch {
            span.end("failed")
            throw error
        }
    }
}

/// The dimmed backdrop and the card every daily overlay draws in, like find in files.
struct HubDailyCard<Content: View>: View {
    let width: CGFloat
    let close: () -> Void
    @ViewBuilder let content: () -> Content

    var body: some View {
        ZStack(alignment: .top) {
            Color.black.opacity(0.45)
                .ignoresSafeArea()
                .onTapGesture { close() }
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 0, content: content)
                .frame(width: width)
                .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color.settingsBackground))
                .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Color.jarvisTeal.opacity(0.28), lineWidth: 1))
                .padding(.top, 56)
                .padding(.bottom, 24)
        }
        .onExitCommand { close() }
        .panelFindModal()
    }
}

/// A small toggle chip (provider filters, range presets, rule kinds): a drawn button, never a Picker.
struct HubDailyChip: View {
    let title: String
    let on: Bool
    var tooltip: String?
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(verbatim: title)
                .font(.system(size: 11, weight: on ? .semibold : .regular))
                .foregroundColor(on ? Color.white.opacity(0.92) : ReviewPalette.dim)
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(Capsule().fill(on ? Color.jarvisTeal.opacity(0.22) : Color.white.opacity(0.05)))
                .overlay(Capsule().stroke(on ? Color.jarvisTeal.opacity(0.5) : Color.white.opacity(0.08)))
                .contentShape(Capsule())
        }
        .buttonStyle(.genHoverPlain())
        .instantTooltip(tooltip ?? title)
    }
}

private struct HubDailyOverlays: ViewModifier {
    @ObservedObject var model: HubModel
    @ObservedObject var daily = HubDailyModel.shared

    func body(content: Content) -> some View {
        content
            .background(
                Button("") { daily.toggleSearch() }
                    .keyboardShortcut("f", modifiers: [.command, .option])
                    .opacity(0)
                    .accessibilityHidden(true)
            )
            .background(
                Button("") { daily.toggleDigest() }
                    .keyboardShortcut("d", modifiers: [.command, .option])
                    .opacity(0)
                    .accessibilityHidden(true)
            )
            .overlay {
                if let query = daily.searchQuery {
                    HubTranscriptSearchPanel(hub: model, seed: query) { daily.searchQuery = nil }
                }
                if daily.digestOpen {
                    HubDigestPanel(hub: model) { daily.digestOpen = false }
                }
                if daily.rulesOpen {
                    HubRulesPanel { daily.rulesOpen = false }
                }
            }
            .onReceive(NotificationCenter.default.publisher(for: NSWindow.didBecomeKeyNotification)) { _ in
                // Coming back to the window refreshes the forecast when it is older than two minutes; no timer.
                HubForecastStore.shared.loadIfStale()
            }
            .onAppear { HubForecastStore.shared.loadIfStale() }
    }
}

extension View {
    /// ⌥⌘F transcript search, ⌥⌘D Today digest (with the usage forecast and the rules), for the hub root.
    func hubDaily(model: HubModel) -> some View {
        modifier(HubDailyOverlays(model: model))
    }
}

extension HubModel {
    /// Opens a session named by a search hit or a digest row, adding a row for one older than the
    /// list's window, and runs the transcript's whole-session search for `query` (it jumps to the
    /// first matching turn).
    @MainActor
    func openDailySession(provider: String?, sessionId: String, title: String?, cwd: String?, project: String?, branch: String?, mtime: Date?, query: String?) {
        HubPerf.log("daily.open \(sessionId.prefix(8))")
        let session: HubSession
        if let known = sessions.first(where: { $0.sessionId == sessionId }) {
            session = known
        } else {
            let folder = cwd ?? ""
            session = HubSession(
                provider: provider ?? HubSession.claudeProvider,
                sessionId: sessionId,
                title: title,
                cwd: folder,
                cwdShort: (folder as NSString).lastPathComponent,
                project: project,
                gitBranch: branch,
                mtime: (mtime?.timeIntervalSince1970 ?? 0) * 1000,
                modelSwitched: false,
                filePath: ""
            )
            sessions.append(session)
        }
        openSession(session)
        if let query, !query.isEmpty {
            // The match is shown in the transcript, so that pane opens if it was closed.
            if !panes.contains(.transcript) {
                togglePane(.transcript)
            }
            transcriptQuery = query
        }
    }
}
