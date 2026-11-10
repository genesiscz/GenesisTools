import AppKit
import SwiftUI

/// The transcript beside the review rows, in the meeting's trailing pane slot (`MeetingDetailView.trailingPane`): a
/// header with "Follows playback" and "Jump to now", then the Riverside blocks that follow the player (R39, R42), the
/// selection popover with Comment and Clip 5s, and the comments staged for the listening agent (R43).
struct TranscriptPane: View {
    @Bindable var detail: MeetingDetailModel

    var body: some View {
        LoadablePane(state: detail.transcript, reading: "Reading the transcript…", retry: detail.loadTranscript,
                     noSource: detail.noTranscriptSource("transcript")) { transcript in
            if transcript.entries.isEmpty {
                EmptyState(symbol: "text.alignleft", text: "This meeting has no transcript",
                           detail: "A transcript comes from its source (Wispr Flow) once the meeting is linked.")
            } else {
                TranscriptBlocksPane(detail: detail, entries: transcript.entries, showsHeader: true)
            }
        }
        .onAppear { detail.ensureTranscript() }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Transcript")
    }
}

/// The transcript as Riverside blocks (R39), for the pane and the Transcript tab: the heard line follows the player
/// (R42), a click on a line plays from it, ⇧-click and ⌘-click select lines for a comment or a clip (R43), and the staged
/// comments sit under the blocks with one Send.
struct TranscriptBlocksPane: View {
    @Bindable var detail: MeetingDetailModel
    let entries: [TranscriptLine]
    var filter = ""
    /// The pane's own header ("Transcript", Follows playback, Jump to now); the tab has its filter field instead and
    /// shows the follow controls in a slimmer line.
    var showsHeader = false
    /// The tab's filter field, which takes the header's free room.
    var headerField: AnyView?

    @AppStorage(MeetingsPreferences.Panes.followPlayback.key) private var followSetting =
        MeetingsPreferences.Panes.followPlayback.defaultValue
    @AppStorage(MeetingsPreferences.Transcript.dimPast.key) private var dimPast = MeetingsPreferences.Transcript.dimPast.defaultValue
    @AppStorage(MeetingsPreferences.Transcript.avatars.key) private var avatars = MeetingsPreferences.Transcript.avatars.defaultValue
    @AppStorage(MeetingsPreferences.Transcript.blockBreakSec.key) private var blockBreakSec =
        MeetingsPreferences.Transcript.blockBreakSec.defaultValue
    @AppStorage(MeetingsPreferences.Transcript.clipSec.key) private var clipSec = MeetingsPreferences.Transcript.clipSec.defaultValue
    /// Follows the playback now: the setting's value until the reader scrolls away, then off until "Jump to now".
    @State private var following: Bool?
    @State private var selection: Set<String> = []
    @State private var anchor: TranscriptBlockLine?
    @State private var popoverLine: String?
    @State private var jump = 0

    var body: some View {
        let blocks = TranscriptBlock.filter(built, query: filter)
        VStack(spacing: 0) {
            header
            Divider()
            if blocks.isEmpty {
                EmptyState(symbol: "magnifyingglass", text: "No line holds “\(filter)”")
            } else {
                FollowingBlocks(blocks: blocks, player: detail.window?.player, meeting: detail.id, follows: isFollowing,
                                jump: jump, selection: selection, popoverLine: popoverLine, dimsPast: dimPast, showsAvatar: avatars,
                                play: { detail.play(at: $0, from: .transcript) },
                                select: select,
                                scrolledAway: { if isFollowing { following = false } },
                                popover: { popover(blocks) },
                                closePopover: { popoverLine = nil })
            }
            staged
        }
        .onAppear { detail.ensureComments() }
    }

    // MARK: Blocks

    /// The blocks with their marks: built when the transcript, the hints, the items or the comments change, not per tick.
    private var built: [TranscriptBlock] {
        let marks = MeetingDetailModel.lineMarks(entries: entries, hints: detail.speakers.value?.hints ?? [],
                                                 items: detail.record.value?.items ?? [],
                                                 comments: detail.comments.value?.comments ?? [])
        return TranscriptBlock.build(from: entries, durationSec: durationSec, marks: marks,
                                     breakAfterGapSec: MeetingsPreferences.Transcript.breakAfterGapSec(blockBreakSec))
    }

    private var durationSec: Double? {
        detail.window.map { $0.player.timeline.durationSec(detail.id, fallback: $0.meeting(detail.id)?.durationSec) }
            .flatMap { $0 > 0 ? $0 : nil }
    }

    private var isFollowing: Bool { following ?? followSetting }

    // MARK: Header

    @ViewBuilder
    private var header: some View {
        HStack(spacing: 8) {
            if showsHeader {
                Text("Transcript").font(.system(size: 12, weight: .semibold))
            }
            if let headerField {
                headerField.frame(maxWidth: .infinity)
            } else {
                Spacer(minLength: 6)
            }
            KitToggleChip("Follows playback", isOn: Binding(get: { isFollowing }, set: { following = $0; if $0 { jump += 1 } }),
                          hue: .play, size: .small,
                          tooltip: "The heard line stays in view while a Moment plays; scrolling away stops it",
                          identifier: "meetings.transcript.follows")
            if !isFollowing, detail.window?.player.top?.meeting == detail.id {
                GhostButton("Jump to now", symbol: "scope", tooltip: "Scroll to the heard line and follow the playback again",
                            identifier: "meetings.transcript.jump") {
                    following = true
                    jump += 1
                }
            }
        }
        .padding(.horizontal, 14).padding(.vertical, showsHeader || headerField != nil ? 8 : 5)
    }

    // MARK: Selection (R43)

    /// ⇧ extends from the last clicked line through the lines between; ⌘ adds or removes one. The popover opens at the
    /// line clicked last.
    private func select(_ line: TranscriptBlockLine, _ click: TranscriptLineClick) {
        switch click {
        case .play:
            return
        case .toggleSelection:
            if selection.contains(line.id) { selection.remove(line.id) } else { selection.insert(line.id) }
        case .extendSelection:
            if let anchor {
                let range = min(anchor.index, line.index)...max(anchor.index, line.index)
                for block in built { for other in block.lines where range.contains(other.index) { selection.insert(other.id) } }
            } else {
                selection.insert(line.id)
            }
        }
        anchor = line
        popoverLine = selection.isEmpty ? nil : line.id
    }

    private var selectedLines: [TranscriptBlockLine] {
        built.flatMap(\.lines).filter { selection.contains($0.id) }
    }

    private func popover(_ blocks: [TranscriptBlock]) -> AnyView {
        guard let chosen = TranscriptSelection.lines(selectedLines) else { return AnyView(EmptyView()) }
        return AnyView(SelectionPopover(
            selection: chosen,
            clipLengthSec: clipSec > 0 ? clipSec : MeetingsPreferences.Transcript.clipSec.defaultValue,
            stage: { selection, text in
                detail.stageComment(selection, text: text)
                clearSelection()
            },
            clip: { target, length in
                detail.window?.player.play(target, in: detail.id, from: .selection, lengthSec: length)
            },
            close: { clearSelection() }))
    }

    private func clearSelection() {
        selection = []
        anchor = nil
        popoverLine = nil
    }

    // MARK: Staged comments (G60)

    @ViewBuilder
    private var staged: some View {
        let comments = detail.comments.value?.comments.filter { $0.state == "staged" } ?? []
        if !comments.isEmpty || detail.commentDelivery != .idle {
            Divider()
            StagedCommentsBar(comments: comments.map(StagedCommentLine.init), listeners: detail.comments.value?.listeners ?? [],
                              delivery: detail.commentDelivery, send: { detail.sendComments() },
                              unstage: { detail.unstageComment($0) })
        }
    }
}

/// The blocks and the only reader of the player's position in the transcript: each tick computes the heard line, so
/// only the heard block redraws (G-TR-2); a new heard block scrolls into view while the pane follows, instantly under
/// Reduce Motion.
private struct FollowingBlocks: View {
    let blocks: [TranscriptBlock]
    let player: MomentPlayer?
    let meeting: String
    let follows: Bool
    /// Bumped by "Jump to now": scroll to the heard block once more.
    let jump: Int
    let selection: Set<String>
    let popoverLine: String?
    let dimsPast: Bool
    let showsAvatar: Bool
    let play: (Double) -> Void
    let select: (TranscriptBlockLine, TranscriptLineClick) -> Void
    let scrolledAway: () -> Void
    let popover: () -> AnyView
    let closePopover: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let position = player?.top?.meeting == meeting ? player?.position : nil
        let heard = TranscriptBlock.heard(in: blocks, at: position)
        ScrollViewReader { proxy in
            ScrollView {
                TranscriptBlocksList(blocks: blocks, heard: heard, selection: selection, dimsPast: dimsPast,
                                     showsAvatar: showsAvatar, pastBefore: dimsPast ? position : nil,
                                     popoverLine: popoverLine, popover: popover, closePopover: closePopover,
                                     play: play, select: select)
                    .padding(.vertical, 4)
                    .background(UserScrollProbe(onUserScroll: scrolledAway))
            }
            .onChange(of: heard?.blockID) { _, block in
                guard follows, let block else { return }
                scroll(proxy, to: block)
            }
            // A pane that opens while a Moment plays starts at the heard line: it scrolled only when the heard block
            // changed, so beside a clip that stays in one block it showed the meeting's first lines to the end.
            .onAppear {
                guard follows, let block = heard?.blockID else { return }
                DispatchQueue.main.async { proxy.scrollTo(block, anchor: .center) }
            }
            .onChange(of: jump) { _, _ in
                if let block = heard?.blockID { scroll(proxy, to: block) }
            }
        }
    }

    private func scroll(_ proxy: ScrollViewProxy, to block: String) {
        if reduceMotion {
            proxy.scrollTo(block, anchor: .center)
        } else {
            withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(block, anchor: .center) }
        }
    }
}

/// Tells when the reader scrolls the enclosing scroll view by hand (a wheel or trackpad drag), never for a scroll the
/// code makes, so following the playback stops only when they scroll away.
private struct UserScrollProbe: NSViewRepresentable {
    let onUserScroll: () -> Void

    func makeNSView(context: Context) -> ProbeView {
        let view = ProbeView()
        view.onUserScroll = onUserScroll
        return view
    }

    func updateNSView(_ view: ProbeView, context: Context) {
        view.onUserScroll = onUserScroll
    }

    final class ProbeView: NSView {
        var onUserScroll: (() -> Void)?
        private var observer: NSObjectProtocol?

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if let observer { NotificationCenter.default.removeObserver(observer) }
            observer = nil
            guard window != nil, let scroll = enclosingScrollView else { return }
            observer = NotificationCenter.default.addObserver(forName: NSScrollView.willStartLiveScrollNotification, object: scroll,
                                                              queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.onUserScroll?() }
            }
        }

        deinit {
            if let observer { NotificationCenter.default.removeObserver(observer) }
        }
    }
}
