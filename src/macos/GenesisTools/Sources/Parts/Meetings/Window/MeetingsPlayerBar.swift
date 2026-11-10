import SwiftUI

/// The dock (R48): the Moment that plays, which meeting and which Moment (R18), the context stack (R38), the controls,
/// the whole-conversation strip and the zoomed timeline (`TimelineDock`), with the cutting line and a failure above
/// them. It floats over the whole window (MeetingsRootView), so it stays while the reader opens another meeting, and it
/// is gone while nothing plays. At a short window, or with `meetings.timeline.shown` off, it folds to one line
/// (G-LAYOUT-1).
struct MeetingsPlayerBar: View {
    let player: MomentPlayer
    /// The playing meeting's title, when the overview knows it.
    let title: String?
    /// The window, for the pins' rows and a pin's click; the menu's model when the root view does not pass it.
    var window: MeetingsWindowModel? = nil

    @AppStorage(MeetingsPreferences.Panes.timelineShown.key) private var timelineShown =
        MeetingsPreferences.Panes.timelineShown.defaultValue
    @AppStorage(MeetingsPreferences.Panes.collapseHeight.key) private var collapseHeight =
        MeetingsPreferences.Panes.collapseHeight.defaultValue
    @State private var windowHeight: CGFloat = 0

    /// Below `collapseHeight` (`meetings.timeline.collapseHeight`, 700 pt) the dock folds to one line: the full dock is
    /// about 330 pt with the strip and the screen, and the rows keep the rest. 0 never folds it.
    static func collapses(timelineShown: Bool, windowHeight: CGFloat,
                          collapseHeight: Int = MeetingsPreferences.Panes.collapseHeight.defaultValue) -> Bool {
        !timelineShown || (windowHeight > 0 && windowHeight < CGFloat(collapseHeight))
    }

    var body: some View {
        if player.isActive {
            VStack(spacing: 0) {
                Divider()
                TimelineDock(player: player, title: title, window: window ?? MeetingsMenuTarget.shared.model,
                             collapsed: Self.collapses(timelineShown: timelineShown, windowHeight: windowHeight,
                                                       collapseHeight: collapseHeight))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    // Over the breadcrumb line, not above it: a cut or a failure never changes the dock's height.
                    .overlay(alignment: .top) { status }
            }
            // It floats over the columns (MeetingsRootView), so it carries its own bar material.
            .background(.bar)
            .background(WindowHeightProbe(height: $windowHeight))
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Player")
            .accessibilityIdentifier("meetings.player")
            .transition(.opacity)
        }
    }

    /// The cut in progress or the failure, over the dock's first line; nothing while the Moment plays.
    @ViewBuilder
    private var status: some View {
        switch player.phase {
        case .cutting(let since):
            CuttingLine(since: since, name: name, cancel: { player.cancelCut() })
                .padding(.horizontal, 16).padding(.top, 8)
        case .failed(let failure):
            NoticePill(text: failure.sentence, more: failure.detail, tone: .error, dismiss: { player.dismissFailure() })
                .padding(.horizontal, 16).padding(.top, 6)
        default:
            EmptyView()
        }
    }

    /// "Design review · i12", or the Moment alone when the overview does not know the meeting.
    private var name: String {
        let moment = player.top?.label ?? ""
        guard let title else { return moment }
        return moment.isEmpty ? title : "\(title) · \(moment)"
    }
}

/// The height of the window the dock floats in, kept up to date on resizes (the dock folds below `collapseHeight`).
private struct WindowHeightProbe: NSViewRepresentable {
    @Binding var height: CGFloat

    func makeNSView(context: Context) -> ProbeView {
        let view = ProbeView()
        view.report = { height = $0 }
        return view
    }

    func updateNSView(_ view: ProbeView, context: Context) {
        view.report = { height = $0 }
    }

    final class ProbeView: NSView {
        var report: ((CGFloat) -> Void)?
        private var observer: NSObjectProtocol?

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if let observer { NotificationCenter.default.removeObserver(observer) }
            observer = nil
            guard let window else { return }
            send(window)
            observer = NotificationCenter.default.addObserver(forName: NSWindow.didResizeNotification, object: window, queue: .main) { [weak self] note in
                guard let window = note.object as? NSWindow else { return }
                MainActor.assumeIsolated { self?.send(window) }
            }
        }

        private func send(_ window: NSWindow) {
            let height = window.contentLayoutRect.height.rounded()
            DispatchQueue.main.async { [weak self] in self?.report?(height) }
        }

        deinit {
            if let observer { NotificationCenter.default.removeObserver(observer) }
        }
    }
}

/// "Cutting the clip" only after 200 ms (most clips are cut by then, G-PLAY-11), with Cancel from 5 s.
/// The dock's own Stop stays reachable under it.
private struct CuttingLine: View {
    let since: Date
    let name: String
    let cancel: () -> Void

    var body: some View {
        TimelineView(.periodic(from: since, by: 0.1)) { context in
            let shows = MomentPlayer.cuttingShows(elapsed: context.date.timeIntervalSince(since))
            if shows.words {
                HStack(spacing: 10) {
                    ProgressView().controlSize(.small)
                    Text(verbatim: "Cutting the clip of \(name)").font(.system(size: 12)).lineLimit(1).truncationMode(.middle)
                    if shows.cancel {
                        GhostButton("Cancel", symbol: "xmark", tooltip: "Stop cutting this clip", identifier: "meetings.player.cancel", action: cancel)
                    }
                }
                .padding(.horizontal, 8).padding(.vertical, 3)
                .background(.bar, in: RoundedRectangle(cornerRadius: 6))
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }
}
