import GenesisKit
import SwiftUI

// Option A of the "transcript" sketch (`--sketch transcript=a`), the hub's half; the transcript's half is GenesisKit
// Sketches/TranscriptSketchA.swift. Hooks: `SessionListView` (the modes) and `SessionDetailView.header` (the subject
// header), both in Hub/HubWindow.swift.

/// The modes as the first section of the sidebar's source list (C1-later, the lead's proposal): one row per mode with
/// its symbol, its whole name, the Inbox's count and its ⌘ key. Seven names never truncate, whatever the sidebar's
/// width, because each has a row of its own.
struct TranscriptSketchModeList: View {
    var model: HubModel
    @ObservedObject var inbox: HubInboxModel

    var body: some View {
        let waiting = inbox.waitingCount
        VStack(spacing: 1) {
            ForEach(Array(HubMode.allCases.enumerated()), id: \.element) { index, mode in
                row(mode, index: index, waiting: waiting)
            }
        }
        .padding(.horizontal, 10)
        .padding(.bottom, 6)
        .overlay(alignment: .bottom) {
            Rectangle().fill(ReviewPalette.hairline).frame(height: 1).padding(.horizontal, 10)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text("Mode"))
    }

    private func row(_ mode: HubMode, index: Int, waiting: Int) -> some View {
        let selected = model.mode == mode
        return Button {
            model.setMode(mode)
        } label: {
            HStack(spacing: 8) {
                Image(systemName: TranscriptSketchModes.symbol(mode, waiting: waiting))
                    .font(.system(size: 12))
                    .foregroundColor(selected ? .white : Color.white.opacity(0.6))
                    .frame(width: 18)
                Text(verbatim: mode.title)
                    .font(.system(size: 12.5, weight: selected ? .semibold : .regular))
                    .foregroundColor(selected ? .white : Color.white.opacity(0.82))
                    .lineLimit(1)
                Spacer(minLength: 6)
                if mode == .inbox, waiting > 0 {
                    Text(verbatim: "\(waiting)")
                        .font(.system(size: 11, weight: .semibold).monospacedDigit())
                        .foregroundColor(Color.white.opacity(0.85))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 1)
                        .background(Capsule().fill(Color.white.opacity(0.12)))
                        .accessibilityLabel(Text("\(waiting) waiting for your answer"))
                }
                Text(verbatim: "⌘\(index + 1)")
                    .font(.system(size: 11))
                    .foregroundColor(Color.white.opacity(0.32))
            }
            .padding(.horizontal, 8)
            .frame(height: 24)
            .background(RoundedRectangle(cornerRadius: 6).fill(selected ? Color.white.opacity(0.13) : Color.clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.genHoverRow(accent: .white, cornerRadius: 6))
        // The app's own tooltip (`.help` alone shows after a long delay and is easy to miss).
        .instantTooltip("\(mode.tooltip(waiting: waiting)) (⌘\(index + 1))")
        .accessibilityLabel(Text(mode.title))
        .accessibilityAddTraits(selected ? [.isSelected] : [])
    }
}

/// The symbols of the modes, one table for both options (the current picker keeps its own private copy).
enum TranscriptSketchModes {
    static func symbol(_ mode: HubMode, waiting: Int) -> String {
        switch mode {
        case .sessions: return "text.bubble"
        case .worktrees: return "arrow.triangle.branch"
        case .prs: return "arrow.triangle.pull"
        case .inbox: return waiting > 0 ? "tray.full" : "tray"
        case .timeline: return "clock"
        case .agents: return "person.2"
        case .usage: return "chart.bar.xaxis"
        }
    }
}

/// One subject header for the whole session detail (C17, Opus's "one subject header"): the title, status, model and
/// account sit in the window's title bar row across every pane, where the PR detail already puts its header. The
/// transcript pane keeps only a slim row with the folder, branch, counters and actions.
///
/// A title bar row starts right of the window's own title, and the hub's title ("Agents") is centred, so the row had
/// only the right half of the window: the subject got less room than the pane's 716 pt and the forecast and a pane
/// button were cut. Under this option the hub hides the window's title (the hook is in `runHub`, Hub/HubWindow.swift),
/// so the row starts at the sidebar's edge and the title has about 1,300 pt in a 2,056 pt window.
struct TranscriptSketchSubjectHeader<Trailing: View>: View {
    var model: HubModel
    let session: HubSession
    let trailing: Trailing
    @ObservedObject private var stuck = HubStuckStore.shared
    /// What the open session does now, from its live tail: the same source as the session list's dot.
    @ObservedObject private var live = HubLiveActivityStore.shared

    /// The status in the pane header's own words (Working, Waiting for you, Idle, Ended), not "live" for every
    /// running process: a session that waits for an answer must say so in the one header the window has.
    private var status: (word: String, color: Color) {
        switch live.work[session.sessionId] {
        case .working: return ("Working", ReviewPalette.added)
        case .waiting: return ("Waiting for you", ReviewPalette.modified)
        case nil: return session.isLive ? ("Idle", Color.white.opacity(0.45)) : ("Ended", Color.white.opacity(0.25))
        }
    }

    init(model: HubModel, session: HubSession, @ViewBuilder trailing: () -> Trailing) {
        self.model = model
        self.session = session
        self.trailing = trailing()
    }

    var body: some View {
        TitlebarHeader {
            HStack(spacing: 10) {
                Group {
                    ProviderBadge(provider: session.provider)
                    Text(session.displayTitle)
                        .font(.system(size: 14, weight: .semibold))
                        .lineLimit(1)
                        // The ending tells similar sessions apart ("… wave 1" and "… wave 1b").
                        .truncationMode(.middle)
                        .layoutPriority(1)
                    let status = status
                    Circle()
                        .fill(status.color)
                        .frame(width: 7, height: 7)
                        .accessibilityHidden(true)
                    Group {
                        if session.isLive {
                            Text(verbatim: status.word)
                        } else {
                            LiveAgo(date: session.lastActivity, style: .brief) { "\(status.word) · \($0)" }
                        }
                    }
                    .font(.system(size: 11.5, weight: .medium))
                    .foregroundColor(session.isLive && live.work[session.sessionId] != nil ? status.color : ReviewPalette.dim)
                    .fixedSize()
                    if let sessionModel = session.model, !sessionModel.isEmpty {
                        SessionPill(text: sessionModel).fixedSize()
                    }
                    if let account = session.account, !account.isEmpty {
                        Text(verbatim: "@\(account)")
                            .font(.system(size: 11.5))
                            .foregroundColor(ReviewPalette.dim)
                            .lineLimit(1)
                            .fixedSize()
                    }
                }
                .titlebarLabel()
                if let verdict = stuck.verdicts[session.sessionId] {
                    StuckBadge(verdict: verdict)
                }
                Spacer(minLength: 16)
                HubForecastChip(account: session.account, provider: Harness(rawValue: session.provider)?.plugin)
                    .layoutPriority(-1)
                if let notice = model.headerNotice {
                    NoticePill(text: notice.text, tone: notice.tone) { model.headerNotice = nil }
                }
                // The pane buttons keep their titles: the forecast gives way first, then the title (middle truncation).
                trailing
                    .layoutPriority(2)
                IconButton(systemName: "doc.richtext", tooltip: "Copy as Markdown (json2md): session, changes, decisions, recent turns") {
                    Task { @MainActor in model.headerNotice = HubNotice(guessing: await model.exportSession(session)) }
                }
            }
        }
    }
}
