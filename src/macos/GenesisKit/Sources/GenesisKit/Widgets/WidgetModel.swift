import AppKit
import Combine
import SwiftUI
import UniformTypeIdentifiers

@MainActor
public final class WidgetModel: ObservableObject {
    /// Matches the 64,000-character cap the hub's draft actions accept.
    nonisolated static let draftTextLimit = 64_000
    private static var draftTooLong: ToolsBridgeError {
        .refused("The combined draft is too long. Shorten it before attaching.")
    }

    @Published public private(set) var snapshot: WidgetSnapshot? {
        didSet {
            sessionIndex = Dictionary(
                (snapshot?.sessions ?? []).map { ($0.key, $0) }, uniquingKeysWith: { first, _ in first })
            sessionRoster.update(snapshot?.sessions ?? [])
            updateInbox(snapshot?.notifications ?? .empty)
        }
    }
    private var sessionRoster = WidgetSessionRoster()
    /// Every snapshot session by key. `selected` is read many times per body; a linear search over ~1000 sessions
    /// there was a measurable part of building the expanded panel.
    private var sessionIndex: [String: WidgetSession] = [:]
    /// The height the agents pane needs to show everything without scrolling (LiveWidgetView measures it), or nil
    /// before it was laid out. The expanded panel fits it, up to its maximum (W3).
    public private(set) var agentFitHeight: CGFloat?
    /// Each session's cards as last seen, so a switch never waits for the next snapshot (`WidgetSessionCache`).
    private(set) var sessionCache = WidgetSessionCache()
    /// The session whose first load keeps the pane at its height: the loading row is short, and the pane shrank to it
    /// and grew back a moment later (app-perf.log, 2026-10-24: 1004x900, 1004x321, 1004x900 on each switch).
    private var loadingFitHold: String?
    public var railSessions: [WidgetSession] { sessionRoster.rail }
    /// Rail sessions that are working or hold unread items. Stored, because every layout pass of every edge panel reads
    /// it: filtering ~1000 sessions there cost a quarter of the main thread while panels animated.
    public private(set) var railActivitySessions: [WidgetSession] = []
    /// The agents hover list (`previewRows`): every session that needs you, with the "active" filter also the
    /// sessions that work now. Stored with the inbox, because every hover layout reads it.
    public private(set) var previewList: [WidgetSession] = []
    @Published public private(set) var inbox = WidgetInboxSummary.empty
    @Published public private(set) var inboxPulse = 0
    /// Bumped only when an item that waits for an answer arrives: the rail badge counts those (`waitingCount`), so it
    /// pulses only when its own number rises, never for an unread answer it does not count.
    @Published public private(set) var waitingPulse = 0
    private var inboxSessions: [String: WidgetInboxSession] = [:]
    private var inboxObserved = false
    private var inboxStartedAt = 0.0
    private var inboxSessionPulses: [String: Int] = [:]
    private var inboxWatermarks: [String: (at: Double, id: String)] = [:]
    private var openingInbox: WidgetInboxItem?
    private var inboxReadRequests: Set<String> = []
    @Published public var selectedKey = ""
    /// The expanded agents pane shows the inbox entries of every session instead of one session (the inbox button).
    /// Opening a session ends it.
    @Published public var inboxOverview = false { didSet { if inboxOverview != oldValue { presentationChanged?() } } }
    @Published public var selectedCardID: String? { didSet { presentationChanged?() } }
    @Published public var section = "Inbox" {
        didSet {
            resumeTranscript()
            presentationChanged?()
        }
    }
    @Published public var expanded: EdgePanelPlacement?
    @Published public var activeSideGroup = 0
    @Published public var hoveredSurface: WidgetSurfaceID?
    /// A new inbox item the widget pops up by itself (an alert). The agents preview shows it until `showPeek`'s
    /// timer ends, or until the pointer leaves the panel when the user moved onto it.
    @Published public private(set) var peekItem: WidgetInboxItem?
    private var peekTask: Task<Void, Never>?
    /// The module a peek replaced on its surface (`previous`, nil when none was chosen) and the one it showed. The
    /// end of the peek puts `previous` back, unless the selection is no longer `shown`: the user picked a module.
    private var peekReplaced: (surface: WidgetSurfaceID, previous: String?, shown: String)?
    /// Surfaces the pointer is in now, without the hover delay: a popup never opens under the user's pointer.
    private var pointerInside: Set<String> = []
    /// Called with the items that arrived in a complete inbox snapshot (never the first one).
    public var inboxArrived: (([WidgetInboxItem]) -> Void)?
    public func session(forKey key: String) -> WidgetSession? { sessionIndex[key] }
    @Published public var moduleSelections: [String: String] = [:]
    @Published public var draggedSidePosition: Double?
    @Published public var draggingSide = false
    public var sideClusterHeight: CGFloat = 300
    private var followedTranscript: String?
    private var receiptContextCache: [String: (at: Date, value: WidgetReceiptContext)] = [:]
    private var hoverTask: Task<Void, Never>?
    /// The surface the pointer left while the side rail was dragged; its collapse waits for the drag end.
    private var exitedDuringDrag: WidgetSurfaceID?
    private var hoveredSession: (key: String, surface: WidgetSurfaceID)?
    private var transcriptHoverTask: Task<Void, Never>?
    /// One sentence about what failed. An error never fades: it stays until the user closes it or a new one replaces
    /// it. A new error is announced to VoiceOver. A new or cleared error drops `errorDetail`, so set the detail after
    /// the sentence (`fail(_:detail:)` does both).
    @Published public var error: String? {
        didSet {
            guard error != oldValue else { return }
            errorDetail = nil
            if let error { GenAnnounce.post(error, priority: .high) }
        }
    }
    /// The raw text behind `error` (a process's stderr), shown only behind a "Details" disclosure.
    @Published public var errorDetail: String?
    @Published public var drafts: [String: WidgetDraft] = [:]
    /// The watch worker exited on its own. The snapshot is stale and nothing dispatches queued messages until
    /// `start()` runs again, so the view keeps a Reconnect action visible even after the error is dismissed.
    @Published public private(set) var connectionLost = false
    @Published public var formAnswers: [String: [String: WidgetFormAnswer]] = [:] {
        didSet {
            do {
                defaults.set(
                    try JSONEncoder().encode(formAnswers), forKey: "widget.formDrafts")
            } catch { PerfLog.mark("widget.form draft save \(error.localizedDescription)") }
        }
    }
    @Published public var transcript: [TranscriptTurn] = []
    @Published public var transcriptError: String?
    @Published public var transcriptLoading = false
    @Published public var importing = 0
    @Published public var voiceText = ""
    /// Everything said in the running dictation: the finished sentences and the one still being recognised.
    public var voiceTranscript: String {
        (voiceFinals + [voiceText]).filter { !$0.isEmpty }.joined(separator: " ")
    }
    @Published public var voiceLevel = 0.0
    @Published public var voiceActive = false
    @Published public var reading = false
    @Published public var reduceMotion = false {
        didSet {
            defaults.set(reduceMotion, forKey: "widget.reduceMotion")
            appearance.reduceMotion = reduceMotion
        }
    }
    @Published public var reduceTransparency = false {
        didSet {
            defaults.set(reduceTransparency, forKey: "widget.reduceTransparency")
            appearance.reduceTransparency = reduceTransparency
        }
    }
    @Published private var hostDialogOpen = false
    /// Set by the session chooser alone, so closing it (or its view going away) cannot release a window still open.
    @Published public var sessionChooserOpen = false
    /// Set by a session's cmux popover alone, for the same reason.
    @Published public var cmuxPopoverOpen = false
    /// A list row's "Open cmux" accessibility action, for that row's `WidgetCmuxButton` (which exists only under the
    /// pointer) to open its popover. The button clears it.
    @Published public var cmuxRequest: WidgetCmuxRequest?

    /// Opens the cmux popover of `key`'s row in the list `scope` (its `WidgetCmuxButton(requestScope:)`).
    public func requestCmux(_ key: String, scope: String?) {
        cmuxRequest = WidgetCmuxRequest(key: key, scope: scope)
    }
    /// Hover previews and the outside-click collapse stay off while a window, picker or the chooser is open.
    public var dialogOpen: Bool {
        get { hostDialogOpen || sessionChooserOpen || cmuxPopoverOpen }
        set { hostDialogOpen = newValue }
    }
    private var mediaPicker: NSOpenPanel?
    public var presentationChanged: (() -> Void)?
    /// The pointer entered or left an edge panel, before any hover delay.
    public var pointerChanged: ((WidgetSurfaceID, Bool) -> Void)?
    /// SwiftUI's own hover of a panel, for the log only (the coordinator names what is under the pointer).
    public var swiftUIHoverChanged: ((WidgetSurfaceID, Bool) -> Void)?
    public var showSettings: (() -> Void)?
    /// Opens Settings at a page, or at a card on it (`widgets.sessions#inbox-preview`), which then pulses.
    public var showSettingsPage: ((String) -> Void)?
    public var showMedia: ((WidgetMediaSelection) -> Void)?
    public var openHub: ((WidgetSession?) -> Void)?
    /// A path for a voice note's audio; nil where no voice notes run (the preview studio), so a note is only dictated.
    public var voiceNoteClip: (() async throws -> String)?
    /// Counts voice starts, so a Stop during a clip-path request keeps that start from opening the microphone later.
    private var voiceStart = 0
    /// Keeps a finished dictation as a voice note: its audio file, its text, and where it was spoken.
    public var fileVoiceNote: ((_ clip: String, _ text: String, _ context: WidgetVoiceNoteContext) -> Void)?
    /// The mode of the dictation that runs, or nil.
    @Published public private(set) var voiceMode: WidgetVoiceMode?
    private var voiceNotePlan: (clip: String, context: WidgetVoiceNoteContext)?
    static let lastVoiceModeKey = "widget.voice.last-mode"

    /// `composerVoice`: "ask" (default) offers both modes on every press of the microphone (Martin, 2026-10-23: "i want
    /// to be able to pick when i click the "record" every time"); "note" or "live" starts that one at once.
    public var composerVoiceChoice: String { snapshot?.state.preferences.composerVoice ?? "ask" }
    /// What a press starts without asking: the setting, or the mode picked last when it asks.
    public var preferredVoiceMode: WidgetVoiceMode {
        if let fixed = WidgetVoiceMode(rawValue: composerVoiceChoice) { return fixed }
        return defaults.string(forKey: Self.lastVoiceModeKey).flatMap(WidgetVoiceMode.init) ?? .note
    }
    public var voiceActionLabel: String {
        if voiceActive { return voiceMode == .note ? "Stop and keep the voice note" : "Stop dictation" }
        switch composerVoiceChoice {
        case "note": return "Record a voice note into the reply box"
        case "live": return "Dictate into the reply box"
        default: return "Dictate, or record a voice note, into the reply box"
        }
    }
    public var openDestination: ((WidgetSession, String, String?) -> Void)?
    /// Called with each preference patch once the hub has stored it.
    public var preferencesSaved: (([String: WidgetJSON]) -> Void)?
    /// One line under the header; a new line drops the button the old one had. A note fades by itself
    /// (`scheduleNoticeFade`) and is announced to VoiceOver; prefer `postNote(_:action:)`, which also restarts the fade
    /// and the announcement when the same text is posted again.
    @Published public var notice: String? {
        didSet {
            guard notice != oldValue else { return }
            noticeAction = nil
            noticeDetail = nil
            // A hover that ended with the panel (it closed under the pointer) must not keep the next note forever.
            noticeHeld = false
            if let notice { GenAnnounce.post(notice) }
            scheduleNoticeFade()
        }
    }
    /// A button beside `notice`: "Send again" after a send no session took. A note with a button stays longer.
    @Published public var noticeAction: WidgetNoticeAction? {
        didSet { scheduleNoticeFade() }
    }
    /// The reasons behind `notice` (each session a queued send did not reach, and why), shown behind Details. A new
    /// note drops them.
    @Published public var noticeDetail: String?
    private var noticeFade: Task<Void, Never>?
    /// The pointer is on the note: its fade waits until the pointer leaves (ux checklist, Attention).
    private var noticeHeld = false

    /// Shows `text` as the widget's note, with an optional button (Undo, Send again). It is announced, and it fades
    /// after the note duration setting (`noteSeconds`, 6 s by default); a note with a button stays at least 10 s. A
    /// newer note replaces it and cancels its fade. Errors go to `error`, which never fades.
    public func postNote(_ text: String, action: WidgetNoticeAction? = nil, detail: String? = nil) {
        // The same text again does not change `notice`, so its didSet would neither announce nor restart the fade.
        if notice == text { GenAnnounce.post(text) }
        notice = text
        noticeAction = action
        noticeDetail = detail
        scheduleNoticeFade()
    }

    /// Seconds a note stays: the `noteSeconds` preference (0 keeps it until it is closed), at least 10 with a button.
    nonisolated static func noteSeconds(_ preferences: WidgetPreferences?, hasAction: Bool) -> Double? {
        let base = max(0, min(60, preferences?.noteSeconds ?? 6))
        guard base > 0 else { return nil }
        return hasAction ? max(base, 10) : base
    }

    /// The pointer entered or left the note: a note under the pointer does not fade, and leaving it starts the full
    /// duration again. For the view that draws the note.
    public func noticeHovered(_ inside: Bool) {
        noticeHeld = inside
        scheduleNoticeFade()
    }

    private func scheduleNoticeFade() {
        noticeFade?.cancel()
        noticeFade = nil
        guard let text = notice, !noticeHeld,
              let seconds = Self.noteSeconds(snapshot?.state.preferences, hasAction: noticeAction != nil) else { return }
        noticeFade = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(seconds)) } catch { return }
            guard let self, self.notice == text, !self.noticeHeld else { return }
            self.notice = nil
        }
    }

    /// An error in one sentence, with the raw text behind it for "Details".
    public func fail(_ message: String, detail: String? = nil) {
        error = message
        let trimmed = detail?.trimmingCharacters(in: .whitespacesAndNewlines)
        errorDetail = trimmed?.isEmpty == false ? trimmed : nil
    }
    public private(set) var openedAt: TimeInterval = 0
    public let bridge: ToolsBridge
    public let appearance: NativeSettingsAppearance

    /// The theme the widget panel and its media window draw with: the widget's own Panel background setting, so the
    /// hub's View > Look or the General theme no longer turns the widget from dark to glass (Martin, 2026-10-25: "most
    /// of the time it shows like this"). Reduce Transparency still turns glass solid.
    public var panelTheme: NativeSettingsTheme {
        switch snapshot?.state.preferences.panelBackground ?? "dark" {
        case "glass":
            return NativeSettingsTheme.glass.effective(reduceTransparency: appearance.reduceTransparency,
                                                       systemReduceTransparency: false)
        case "theme":
            return appearance.theme
        default:
            return .graphite
        }
    }
    private let defaults: UserDefaults
    private var appearanceSubscription: AnyCancellable?
    private var settingsOnly = false
    private var settingsTask: Task<Void, Never>?
    private var settingsRefreshAgain = false
    /// A settings read came back stale while a preference write was in flight; the last write to land reads again.
    private var settingsRefreshAfterWrites = false
    /// Bumped when a preference write starts and when it lands. A settings snapshot read across either holds the
    /// preferences from before the write; applied, it undid the optimistic change, and the next toggle built its
    /// patch on that stale layout, so two quick module toggles lost one (settings V2 pass, 2026-10-10).
    private var preferenceWriteEpoch = 0
    private var preferenceWritesInFlight = 0
    private var settingsWatcher: DirectoryWatcher?
    private let stateRoot: String?
    private let journal: URL
    private var watcher: ToolsLineStream?
    private let snapshotDecoder = WidgetSnapshotDecoder()
    private var voice: ToolsLineStream?
    private var tail: TranscriptLiveTail?
    private var transcriptTask: Task<Void, Never>?
    private let transcriptCache: SessionTranscriptCache
    private var speechTask: Task<Void, Never>?
    private var mutationTask: Task<Void, Never>?
    private var preferenceTask: Task<Void, Never>?
    private var pendingPreferences: [String: WidgetJSON] = [:]
    /// Saved preference patches, still shown over every snapshot until one read at or after their write arrives
    /// (`fence`: state.json's revision once the write landed; nil while that is read). The watch builds a snapshot
    /// from state it read earlier, so one read before the write can arrive after it; applied bare, it undid the
    /// saved preference in the live widget.
    private var savedPreferences: [(id: UUID, fence: Int?, patch: [String: WidgetJSON])] = []
    /// The last snapshot as it arrived, before any overlay.
    private var lastReceived: WidgetSnapshot?
    /// What the callers of `updatePreferences` asked to hear about the write that carries their patch.
    private var pendingPreferenceOutcomes: [(saved: () -> Void, failed: () -> Void)] = []
    private var draftTasks: [String: Task<Void, Never>] = [:]
    private var dirtyDrafts: Set<String> = []
    private var draftRevisions: [String: Int] = [:]
    /// Sending replaces the composer; bindings retained by its disposed field cannot write into the new draft.
    @Published private var composerGeneration = 0
    var actionRunner: ((WidgetJSON) async throws -> WidgetJSON)?
    private var submittedAssets: Set<String> = []
    private var submittedCards: Set<String> = []
    private var lastSelected: WidgetSession?
    private var voiceKey: String?
    private var voiceFinals: [String] = []
    private var stopping = false
    private var quietTask: Task<Void, Never>?
    private var quietSignature = ""

    public init(
        binaryPath: String, stateRoot: String? = nil, defaults: UserDefaults = .standard,
        appearance: NativeSettingsAppearance? = nil, transcriptCache: SessionTranscriptCache? = nil
    ) {
        self.defaults = defaults
        self.appearance = appearance ?? .shared
        bridge = ToolsBridge(binaryPath: binaryPath)
        self.transcriptCache = transcriptCache ?? SessionTranscriptCache(bridge: bridge)
        self.stateRoot = stateRoot
        let base =
            stateRoot.map { URL(fileURLWithPath: $0) }
            ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent(Bundle.main.bundleIdentifier ?? "GenesisTools")
        journal = base.appendingPathComponent("native-submissions", isDirectory: true)
        moduleSelections = defaults.dictionary(forKey: "widget.moduleSelections") as? [String: String] ?? [:]
        self.appearance.migrateIfNeeded(
            reduceMotion: defaults.bool(forKey: "widget.reduceMotion"),
            reduceTransparency: defaults.bool(forKey: "widget.reduceTransparency"))
        reduceMotion = self.appearance.reduceMotion
        reduceTransparency = self.appearance.reduceTransparency
        appearanceSubscription = self.appearance.objectWillChange.sink { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                if self.reduceMotion != self.appearance.reduceMotion {
                    self.reduceMotion = self.appearance.reduceMotion
                }
                if self.reduceTransparency != self.appearance.reduceTransparency {
                    self.reduceTransparency = self.appearance.reduceTransparency
                }
                self.presentationChanged?()
            }
        }
        if let data = defaults.data(forKey: "widget.formDrafts") {
            do {
                formAnswers = try JSONDecoder().decode(
                    [String: [String: WidgetFormAnswer]].self, from: data)
            } catch {
                // The first edit rewrites this key with only that edit, so the typed drafts get a key of their own first.
                defaults.set(data, forKey: "widget.formDrafts.undecodable.\(Int(Date().timeIntervalSince1970))")
                PerfLog.mark("widget.form draft restore \(error.localizedDescription)")
            }
        }
    }

    public var sessions: [WidgetSession] { sessionRoster.visible }
    public var previewSessions: [WidgetSession] { sessionRoster.preview }
    public var waitingSessionCount: Int { sessionRoster.waiting }
    /// Top-level sessions working now or waiting for an answer; subagents and quiet sessions do not count.
    public var activeSessionCount: Int { sessionRoster.active }
    /// The agents preview's measured height. The old estimate (100 + 54 per row) was 11 pt plus 2 pt per row short,
    /// so the centred content lost its header and the top of its first row (2026-10-10, Martin's screenshot).
    public private(set) var previewFitHeight: CGFloat?
    /// The hover list's last measured height. The list is built again on every hover; it starts at this height so its
    /// first layout is already the real one (`FittedScroll.initialHeight`). Not published: it must not re-render.
    var previewListHeight: CGFloat = 0
    public var previewHeight: CGFloat {
        if let previewFitHeight { return previewFitHeight }
        return sessionRoster.preview.isEmpty ? 180 : 112 + CGFloat(sessionRoster.preview.count) * 56
    }

    /// Whole points and a 2 pt hysteresis, as `reportAgentFit`, so the measurement cannot chase its own resize.
    ///
    /// A taller measurement applies at once; a shorter one only after it held for `previewShrinkDelay`. The list is
    /// built again on every hover, and its first layout passes measured it short (header and footer, then the rows):
    /// one hover asked for 336, 295 and 489 pt within 42 ms, the panel shrank and grew back, and its content blinked
    /// or opened cut at the top (edge.request log and Martin's screenshots, 2026-10-23).
    ///
    /// Before the first measurement the panel opens at the estimate (`previewHeight`), so a short first pass waits as
    /// well: the first alert after a launch asked for 336 (the estimate), 295 and 489 pt (2026-10-23 17:10).
    func reportPreviewFit(_ height: CGFloat) {
        let rounded = ceil(height)
        let current = previewFitHeight ?? previewHeight
        previewShrink?.cancel()
        if abs(rounded - current) < 2 {
            if previewFitHeight == nil { previewFitHeight = rounded }
            return
        }
        if rounded < current {
            previewShrink = Task { [weak self] in
                do { try await Task.sleep(for: Self.previewShrinkDelay) } catch { return }
                guard let self else { return }
                self.previewFitHeight = rounded
                self.presentationChanged?()
            }
            return
        }
        previewFitHeight = rounded
        presentationChanged?()
    }

    static let previewShrinkDelay = Duration.milliseconds(300)
    private var previewShrink: Task<Void, Never>?

    public var selected: WidgetSession? {
        sessionIndex[selectedKey] ?? (lastSelected?.key == selectedKey ? lastSelected : nil)
    }

    /// The height a filter change may not shrink the pane below, for the view (overview, section, session) it was
    /// taken in. A filter that shows fewer rows, or none, used to drop the open panel by hundreds of points and grow
    /// it back on the next click (Martin, 2026-10-23: "it probably doesn't need to lower the height").
    private var agentFitFloor: (view: String, height: CGFloat)?
    private var fitView: String { "\(inboxOverview)|\(section)|\(selectedKey)" }

    /// Called just before a filter changes what an open pane lists: the pane keeps at least its current height.
    public func holdAgentFit() {
        guard expanded != nil, let height = agentFitHeight else { return }
        agentFitFloor = (fitView, max(height, agentFitFloor?.view == fitView ? agentFitFloor?.height ?? 0 : 0))
    }

    /// A row folding or another view: the pane fits its content again.
    public func releaseAgentFit() {
        agentFitFloor = nil
    }

    /// Whole points, and only a change of 2 pt or more, so a measurement cannot chase its own resize.
    func reportAgentFit(_ height: CGFloat?) {
        if loadingFitHold != nil, loadingFitHold != selectedKey || !inboxLoading {
            loadingFitHold = nil
            agentFitFloor = nil
        }
        var rounded = height.map { ceil($0) }
        if let floor = agentFitFloor {
            if floor.view == fitView, let value = rounded { rounded = max(value, floor.height) } else { agentFitFloor = nil }
        }
        if let rounded, let current = agentFitHeight, abs(rounded - current) < 2 { return }
        guard rounded != agentFitHeight else { return }
        agentFitHeight = rounded
        presentationChanged?()
    }
    /// The selected session's cards: from the snapshot that names it, else as last seen (`sessionCache`).
    public var cards: [WidgetCard] {
        guard let snapshot else { return [] }
        if snapshot.selectedKey != selectedKey, let cached = sessionCache[selectedKey] { return cached.cards }
        return snapshot.cards.filter { $0.sessionKey == selectedKey }
    }
    /// Nothing is known about the selected session yet: no snapshot named it, and none carried its cards.
    public var inboxLoading: Bool {
        !selectedKey.isEmpty && snapshot?.selectedKey != selectedKey && sessionCache[selectedKey] == nil
            && cards.isEmpty && error == nil
    }
    /// For the test driver's `state` command and logs.
    public var selectionDescription: String {
        "selected=\(selectedKey) snapshot=\(snapshot?.selectedKey ?? "-") loading=\(inboxLoading) cards=\(cards.count) "
            + "cached=\(sessionCache.count) warm=\(snapshot?.warmKeys?.count ?? 0)"
    }
    /// The selected session's decision activity and changes, under the same rule as `cards`.
    public var sessionActivity: [WidgetActivityEvent] {
        snapshot?.selectedKey == selectedKey ? snapshot?.activity ?? [] : sessionCache[selectedKey]?.activity ?? []
    }
    public var sessionChanges: WidgetSnapshot.Changes? {
        snapshot?.selectedKey == selectedKey ? snapshot?.changes : sessionCache[selectedKey]?.changes
    }
    public var card: WidgetCard? {
        cards.first { $0.id == selectedCardID } ?? cards.last(where: \.needsAnswer) ?? cards.last
    }
    /// Inbox rows the user folded. A folded decision stays selected, but nothing answers it until it opens again.
    @Published public var foldedCardIDs: Set<String> = []
    /// Inbox rows shown as dismissed or done while their Undo runs or their change is on its way
    /// (`WidgetLedgerUndo`). Opened again, such a row is still not answered.
    @Published public var heldCardIDs: Set<String> = []
    /// The decision ids of `heldCardIDs`: such a decision is out of every staged send until its Undo brings it back.
    @Published public var heldDecisionIDs: Set<String> = []
    /// The decision the composer and the number keys answer: the selected one, unanswered, not folded and not held.
    public var answerCard: WidgetCard? {
        guard let card, card.kind == "decision", card.needsAnswer, !foldedCardIDs.contains(card.id),
              !heldCardIDs.contains(card.id) else { return nil }
        return card
    }
    /// `answerCard` while a session's inbox shows it: not behind the inbox of every session, another tab or the staged
    /// list. Only then do the number keys answer it; a key used to stage an option of a decision nobody could see.
    public var answerCardOnScreen: WidgetCard? {
        guard activeModuleID == "agents", !inboxOverview, section == "Inbox", stagedView == nil else { return nil }
        return answerCard
    }
    /// The decision whose own answer field holds the draft (its toolbar open, the reply composer parked).
    @Published public var ownAnswerCardID: String?
    /// A decision whose own answer field takes the keyboard as soon as its card shows it (the alert's "Write my own
    /// answer" opens the panel first, so the field is not there yet when it is asked for).
    @Published public var ownAnswerFocusRequest: String?
    /// `ownAnswerCardID` while that decision is still the one the composer answers.
    public var ownAnswerCard: WidgetCard? {
        guard let card = answerCard, card.id == ownAnswerCardID else { return nil }
        return card
    }
    public var draft: WidgetDraft { drafts[selectedKey] ?? WidgetDraft() }
    public var outgoing: [WidgetOutgoing] {
        WidgetOutgoing.shown(snapshot?.state.outgoing.filter { $0.target.hasSameIdentity(as: selected?.target) } ?? [])
    }
    public var cardPending: Bool {
        guard let card else { return false }
        return outgoing.contains { message in
            guard !["failed", "cancelled"].contains(message.state), case .object(let payload) = message.payload else {
                return false
            }
            return payload["id"] == .string(card.sourceId)
        }
    }

    public var effectiveReduceMotion: Bool {
        reduceMotion || NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    }
    public var placement: String { snapshot?.state.preferences.placement ?? "both" }
    public var side: EdgePanelPlacement {
        snapshot?.state.preferences.side == "left" ? .left : .right
    }
    public var hasActivity: Bool {
        sessions.contains { $0.status == "working" || $0.status == "waiting" }
    }
    public var preferredHeight: CGFloat {
        if section != "Inbox" { return 660 }
        guard let card else { return 440 }
        let bodyLines = min(8, card.body.count / 65)
        let choices = card.choices.count * 38
        let forms = (card.formItems ?? []).reduce(0) { $0 + 48 + ($1.choices?.count ?? 0) * 32 }
        let media = card.attachments.isEmpty ? 0 : 110
        return CGFloat(min(660, max(440, 330 + bodyLines * 16 + choices + forms + media)))
    }

    private var widgetArgs: [String] { ["widget"] + (stateRoot.map { ["--state-root", $0] } ?? []) }

    /// The settings-only face: one snapshot now, and another whenever the widget state file changes, so a
    /// preference the widget face, the CLI or another window writes shows here without reopening the page.
    public func startSettings() {
        settingsOnly = true
        do {
            try FileManager.default.createDirectory(at: journal, withIntermediateDirectories: true)
            refreshSettings()
            watchSettingsState()
        } catch { report(error) }
    }

    /// Whether the settings pages have the stored preferences to show. Until then they show a loading state, never
    /// the defaults as if they were the stored values ("Show the widget" read off while the widget was on screen).
    public var settingsLoaded: Bool { snapshot != nil }

    /// Loads a fresh snapshot for the settings pages. A load already running is never cancelled and restarted:
    /// one `hub widget snapshot` takes seconds, and every page change used to kill it and start again, so the first
    /// load could miss its window entirely. A request made meanwhile runs once more after the current one.
    public func refreshSettings() {
        guard settingsTask == nil else {
            settingsRefreshAgain = true
            return
        }
        settingsRefreshAgain = false
        let epoch = preferenceWriteEpoch
        let clean = preferenceWritesInFlight == 0
        settingsTask = Task { [weak self] in
            guard let self else { return }
            do {
                let result = try await self.bridge.run(
                    subcommand: "hub", args: self.widgetArgs + ["snapshot", "--json"], timeoutSeconds: 30)
                guard result.exitCode == 0 else { throw ToolsBridgeError.refused(result.stderr) }
                let current = clean && epoch == self.preferenceWriteEpoch
                if !Task.isCancelled, current || self.snapshot == nil {
                    self.receive([result.stdout])
                } else if !current {
                    // Read again, but not while a write is still landing: every read until it lands is stale too,
                    // and they would run back to back. The write asks for the read when it lands.
                    if self.preferenceWritesInFlight == 0 {
                        self.settingsRefreshAgain = true
                    } else {
                        self.settingsRefreshAfterWrites = true
                    }
                }
            } catch {
                if !Task.isCancelled { self.report(error) }
            }
            guard !Task.isCancelled else { return }
            self.settingsTask = nil
            if self.settingsRefreshAgain { self.refreshSettings() }
        }
    }

    /// `state.json` of this model's widget root, the file `hub widget` reads preferences from
    /// (`src/hub/lib/widget/storage.ts`: the state root, else `$GENESIS_TOOLS_HOME/.genesis-tools/hub/widget`).
    nonisolated static func widgetStateFile(stateRoot: String?,
                                            environment: [String: String] = ProcessInfo.processInfo.environment) -> String {
        if let stateRoot {
            return URL(fileURLWithPath: stateRoot).standardizedFileURL.appendingPathComponent("state.json").path
        }
        let home = environment["GENESIS_TOOLS_HOME"].flatMap { $0.isEmpty ? nil : $0 } ?? NSHomeDirectory()
        return URL(fileURLWithPath: home).appendingPathComponent(".genesis-tools/hub/widget/state.json").path
    }

    private func watchSettingsState() {
        guard settingsWatcher == nil else { return }
        let file = URL(fileURLWithPath: Self.widgetStateFile(stateRoot: stateRoot)).resolvingSymlinksInPath().path
        settingsWatcher = DirectoryWatcher(
            paths: [(file as NSString).deletingLastPathComponent], latency: 0.2, accepts: { $0 == file }
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.refreshSettings() }
        }
    }

    /// What the widget says when its watch process ends by itself; the process's stderr is `errorDetail`.
    public static let connectionLostMessage = "Lost the connection to the hub. Reconnect to try again."

    public func start() {
        guard watcher == nil else { return }
        stopping = false
        do {
            try FileManager.default.createDirectory(at: journal, withIntermediateDirectories: true)
            snapshotDecoder.reset()
            let decoder = snapshotDecoder
            watcher = try ToolsLineStream(
                bridge: bridge, subcommand: "hub", args: widgetArgs + ["watch", "--stop-on-stdin"],
                onLines: { [weak self] lines in
                    // A snapshot is about 1 MB of JSON with ~1000 sessions: decoding it on the main thread
                    // stalled panel transitions. Decode on a queue, apply here.
                    decoder.decode(lines) { results in self?.receiveDecoded(results) }
                },
                onExit: { [weak self] exit in
                    guard let self, !self.stopping, !exit.stopped else { return }
                    self.watcher = nil
                    self.connectionLost = true
                    // One sentence on screen; the process's own words go behind Details (ux checklist, Errors).
                    self.fail(Self.connectionLostMessage, detail: String(exit.stderr.suffix(4000)))
                    PerfLog.mark("widget.connection lost status=\(exit.status) \(exit.stderr.suffix(600))")
                })
            // Cleared only once a watcher runs: a reconnect that cannot launch keeps Reconnect on screen.
            connectionLost = false
            drainJournal()
        } catch {
            connectionLost = true
            report(error)
        }
    }

    public func stop() {
        sendCloseRevision += 1
        peekTask?.cancel()
        preferenceTask?.cancel()
        flushPreferences()
        settingsTask?.cancel()
        settingsTask = nil
        settingsRefreshAgain = false
        settingsRefreshAfterWrites = false
        settingsWatcher?.stop()
        settingsWatcher = nil
        followedTranscript = nil
        stopping = true
        cancelHoverPrewarm()
        mediaPicker?.cancel(nil)
        mediaPicker = nil
        dialogOpen = false
        sessionChooserOpen = false
        hoverTask?.cancel()
        watcher?.stop()
        watcher = nil
        let recording = voice
        finishVoice()
        recording?.stop()
        voice = nil
        tail?.stop()
        tail = nil
        transcriptTask?.cancel()
        transcriptCache.cancelPending()
        speechTask?.cancel()
        quietTask?.cancel()
        for task in draftTasks.values { task.cancel() }
        for key in dirtyDrafts {
            if let draft = drafts[key] {
                defaults.set(draft.text, forKey: "widget.recovered-draft." + key)
            }
        }
    }

    func receive(_ lines: [String]) {
        for line in lines {
            do {
                apply(try JSONDecoder().decode(WidgetSnapshot.self, from: Data(line.utf8)))
            } catch { report(error) }
        }
    }

    private func receiveDecoded(_ results: [Result<WidgetSnapshot, Error>]) {
        guard !stopping else { return }
        for result in results {
            switch result {
            case .success(let snapshot): apply(snapshot)
            case .failure(let error): report(error)
            }
        }
    }

    private func apply(_ decoded: WidgetSnapshot) {
        do {
            lastReceived = decoded
            savedPreferences.removeAll { entry in entry.fence.map { decoded.state.revision >= $0 } ?? false }
            var next = decoded
            next.state.preferences = try overlaid(next.state.preferences)
            sessionCache.remember(next)
            snapshot = next
            if !draggingSide, let position = draggedSidePosition,
                abs((next.state.preferences.sidePosition ?? 0.5) - position) < 0.0001
            {
                draggedSidePosition = nil
            }
            for message in next.state.outgoing where ["failed", "cancelled"].contains(message.state) {
                if case .object(let fields) = message.payload,
                    case .string(let kind) = fields["kind"], case .string(let id) = fields["id"]
                {
                    submittedCards.remove(kind + ":" + id)
                }
            }
            for (key, value) in next.state.drafts where !dirtyDrafts.contains(key) {
                drafts[key] = value
            }
            for key in dirtyDrafts {
                if let incoming = next.state.drafts[key] {
                    drafts[key]?.assetIds = incoming.assetIds.filter { !submittedAssets.contains($0) }
                }
            }
            if let session = sessionIndex[selectedKey] {
                lastSelected = session
            }
            // A cold roster holds only the sessions synthesized from Decisions and forms; choosing
            // and persisting one of those would orphan the selection once the roster arrives.
            if selectedKey.isEmpty && next.rosterLoading != true {
                selectedKey = WidgetSelection.initial(
                    persisted: next.state.selectedKey, visibleKeys: next.sessions.filter(\.visible).map(\.key))
                selectedCardID = nil
                if !selectedKey.isEmpty && !settingsOnly {
                    pickOnWatch(selectedKey)
                    action(["action": "selection", "key": .string(selectedKey)])
                    resumeTranscript()
                }
            }
            if !selectedKey.isEmpty,
                let recovered = defaults.string(
                    forKey: "widget.recovered-draft." + selectedKey)
            {
                defaults.removeObject(forKey: "widget.recovered-draft." + selectedKey)
                setText(recovered)
            }
            resumeTranscript()
            acknowledgeOpenedInbox()
            scheduleQuietReduction()
            presentationChanged?()
        } catch { report(error) }
    }

    public var layout: WidgetLayoutConfiguration {
        snapshot?.state.preferences.layout ?? WidgetLayoutConfiguration()
    }

    public var sidePosition: Double { draggedSidePosition ?? layout.sidePosition }
    public var activeModuleID: String {
        let surface = WidgetSurfaceID(edge: expanded ?? side, group: expanded == .top ? 0 : activeSideGroup)
        return moduleSelections[surface.key] ?? "agents"
    }

    func resolveModules(_ ids: [String], on surface: WidgetSurfaceID) {
        let selected = moduleSelections[surface.key]
        let resolved = ids.first(where: { $0 == selected }) ?? ids.first
        guard selected != resolved else { return }
        moduleSelections[surface.key] = resolved
        defaults.set(moduleSelections, forKey: "widget.moduleSelections")
        resumeTranscript()
    }

    public func presentation(for surface: WidgetSurfaceID) -> WidgetModulePresentation {
        if expanded == surface.edge && (surface.edge == .top || activeSideGroup == surface.group) {
            return .expanded
        }
        return hoveredSurface == surface ? .preview : .compact
    }

    public func openModule(_ moduleID: String, on surface: WidgetSurfaceID) {
        // The user picked this module (also by clicking the peek itself): it stays after the peek. A pick on another
        // surface ends the peek here too, so the surface the peek switched gets its own module back first.
        if peekReplaced?.surface == surface {
            peekReplaced = nil
        } else {
            restorePeekModule()
        }
        moduleSelections[surface.key] = moduleID
        defaults.set(moduleSelections, forKey: "widget.moduleSelections")
        activeSideGroup = surface.group
        hoveredSurface = nil
        hoverTask?.cancel()
        peekTask?.cancel()
        peekItem = nil
        open(surface.edge)
    }

    public func hoverSession(_ key: String, on surface: WidgetSurfaceID, inside: Bool) {
        if !inside {
            if hoveredSession?.key == key, hoveredSession?.surface == surface {
                transcriptHoverTask?.cancel()
                transcriptHoverTask = nil
            }
            // Expanding the top preview moves its buttons under a stationary pointer. Keep the target
            // until the pointer leaves the whole surface, or reaches a different agent.
            return
        }
        guard layout.hoverPreviews, !dialogOpen, !draggingSide, expanded == nil else { return }
        // The panel's own hover fires only when the pointer crosses its edge. After a click collapsed the panel
        // under a resting pointer it never fired again, so the next bubble showed its tooltip and no preview
        // (Martin, 2026-10-23). A bubble the pointer reaches starts the panel's hover itself.
        if hoveredSurface != surface { hover(surface, inside: true) }
        cancelHoverPrewarm()
        hoveredSession = (key, surface)
        transcriptHoverTask = Task { [weak self] in
            do { try await Task.sleep(for: .milliseconds(160)) } catch { return }
            guard let self, self.expanded == nil, !self.dialogOpen,
                  self.hoveredSession?.key == key, self.hoveredSession?.surface == surface else { return }
            self.prewarmTranscript(on: surface)
        }
    }

    private func cancelHoverPrewarm() {
        transcriptHoverTask?.cancel()
        transcriptHoverTask = nil
        hoveredSession = nil
    }

    /// Whether `showPeek` would pop an item up in `surface` now: never while the user is in a panel, a window or a drag.
    func canPeek(on surface: WidgetSurfaceID) -> Bool {
        !stopping && expanded == nil && !dialogOpen && !draggingSide && pointerInside.isEmpty
            && (hoveredSurface == nil || hoveredSurface == surface)
    }

    /// Pops `item` up in `surface`'s preview for `seconds`, unless the user is in a panel, a window or a drag. With
    /// `module`, the surface shows that module for the peek and gets the user's own module back when the peek ends.
    func showPeek(_ item: WidgetInboxItem, on surface: WidgetSurfaceID, module: String? = nil, seconds: Double = 7) {
        guard canPeek(on: surface) else { return }
        if let module, moduleSelections[surface.key] != module {
            if let replaced = peekReplaced, replaced.surface != surface { restorePeekModule() }
            // A second alert during a peek keeps the module from before the first one.
            peekReplaced = peekReplaced ?? (surface, moduleSelections[surface.key], module)
            moduleSelections[surface.key] = module
        }
        hoverTask?.cancel()
        peekItem = item
        hoveredSurface = surface
        presentationChanged?()
        peekTask?.cancel()
        peekTask = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(seconds)) } catch { return }
            guard let self, self.peekItem == item, !self.pointerInside.contains(surface.key) else { return }
            self.endPeek()
        }
    }

    /// The popup's close button, Esc and VoiceOver's escape: the popup ends without opening anything.
    public func dismissPeek() {
        guard let item = peekItem else { return }
        PerfLog.mark("widget.peek dismissed id=\(item.id)")
        hoverTask?.cancel()
        endPeek()
        // The pointer is on the panel (it pressed ×): without this the hover list would open in the popup's place.
        if expanded == nil, let surface = hoveredSurface, presentation(for: surface) == .preview {
            hoveredSurface = nil
            presentationChanged?()
        }
    }

    private func endPeek() {
        peekTask?.cancel()
        peekTask = nil
        guard let item = peekItem else { return }
        peekItem = nil
        if expanded == nil, let surface = hoveredSurface, !pointerInside.contains(surface.key) {
            hoveredSurface = nil
        }
        // An open panel keeps the peek's module under the user; `collapse` restores it once the panel closes.
        if expanded == nil { restorePeekModule() }
        PerfLog.mark("widget.peek end id=\(item.id)")
        presentationChanged?()
    }

    /// Puts back the module a peek replaced, unless the user chose another one since. Not saved to the defaults:
    /// the peek's own switch never was either.
    private func restorePeekModule() {
        guard let replaced = peekReplaced else { return }
        peekReplaced = nil
        guard moduleSelections[replaced.surface.key] == replaced.shown else { return }
        moduleSelections[replaced.surface.key] = replaced.previous
    }

    public func hover(_ surface: WidgetSurfaceID, inside: Bool) {
        if inside { pointerInside.insert(surface.key) } else { pointerInside.remove(surface.key) }
        pointerChanged?(surface, inside)
        if !inside { scheduleQuietReduction() }
        if !inside, peekItem != nil, hoveredSurface == surface {
            // The user moved onto the popup and away again: it closes like a hover preview.
            hoverTask?.cancel()
            hoverTask = Task { [weak self] in
                do { try await Task.sleep(for: .milliseconds(220)) } catch { return }
                self?.endPeek()
            }
            return
        }
        guard layout.hoverPreviews, !dialogOpen else { return }
        if draggingSide {
            exitedDuringDrag = inside ? nil : surface
            return
        }
        hoverTask?.cancel()
        if inside {
            guard presentation(for: surface) != .expanded else { return }
            hoverTask = Task { [weak self] in
                do { try await Task.sleep(for: .milliseconds(160)) } catch { return }
                guard let self, !self.dialogOpen else { return }
                self.hoveredSurface = surface
                self.prewarmTranscript(on: surface)
                self.presentationChanged?()
            }
        } else {
            hoverTask = Task { [weak self] in
                do { try await Task.sleep(for: .milliseconds(220)) } catch { return }
                guard let self else { return }
                if self.hoveredSession?.surface == surface { self.cancelHoverPrewarm() }
                guard self.hoveredSurface == surface else { return }
                self.hoveredSurface = nil
                if self.expanded == nil { self.transcriptCache.cancelPending() }
                self.presentationChanged?()
            }
        }
    }

    public func moveSide(position: Double, finished: Bool) {
        let bounded = min(1, max(0, position))
        draggedSidePosition = bounded
        draggingSide = !finished
        cancelHoverPrewarm()
        // Keep the current rail height while dragging; shrinking a hovered panel changes its travel.
        hoverTask?.cancel()
        presentationChanged?()
        if finished, let exited = exitedDuringDrag {
            exitedDuringDrag = nil
            hover(exited, inside: false)
        }
        if finished {
            action(
                ["action": "preferences", "patch": ["sidePosition": .number(bounded)]],
                failed: { [weak self] in
                    guard let self, self.draggedSidePosition == bounded, !self.draggingSide else { return }
                    self.draggedSidePosition = nil
                    self.presentationChanged?()
                })
        }
    }

    public func open(_ edge: EdgePanelPlacement) {
        cancelHoverPrewarm()
        openedAt = ProcessInfo.processInfo.systemUptime
        expanded = edge
        prewarmTranscript()
        resumeTranscript()
        refreshContext()
        presentationChanged?()
        scheduleQuietReduction()
        if openingInbox == nil, let card, card.kind == "answer", !card.read {
            action(["action": "read", "id": .string(card.sourceId)])
        }
    }

    func updateInbox(_ value: WidgetInboxSummary) {
        var arrived = false
        var arrivedKeys: Set<String> = []
        var arrivals: [WidgetInboxItem] = []
        if !inboxObserved, value.complete { inboxStartedAt = Date().timeIntervalSince1970 * 1000 }
        for entry in value.sessions {
            for item in [entry.unreadItem, entry.pendingItem].compactMap({ $0 }) {
                // An incomplete snapshot cannot raise an arrival, so it must not move the watermark
                // either: the complete snapshot that follows would then see nothing new.
                guard item.at.isFinite, !inboxObserved || value.complete else { continue }
                let token = entry.key + "|" + (item.needsAnswer ? "pending" : "unread")
                let previous = inboxWatermarks[token]
                if previous == nil || item.at > previous!.at || (item.at == previous!.at && item.id > previous!.id) {
                    let isArrival = inboxObserved && value.complete && item.at > inboxStartedAt
                    if isArrival { arrived = true; arrivedKeys.insert(entry.key); arrivals.append(item) }
                    inboxWatermarks[token] = (item.at, item.id)
                    if isArrival, item.kind != "result", value.profile?.hostId == "local",
                        snapshot?.sessions.first(where: { $0.key == item.key })?.target.hostId == "local" {
                        let latency = Date().timeIntervalSince1970 * 1000 - item.at
                        if latency >= 0 { PerfLog.mark("widget.inbox receipt-to-snapshot-applied pid=\(ProcessInfo.processInfo.processIdentifier) id=\(item.id) ms=\(latency)") }
                    }
                }
            }
        }
        inboxObserved = inboxObserved || value.complete
        if arrived { inboxPulse += 1 }
        if arrivals.contains(where: \.needsAnswer) { waitingPulse += 1 }
        if !arrivals.isEmpty { inboxArrived?(arrivals) }
        for key in arrivedKeys { inboxSessionPulses[key, default: 0] += 1 }
        if inboxWatermarks.count > 4096 {
            let removed = inboxWatermarks.sorted { $0.value.at < $1.value.at }.prefix(inboxWatermarks.count - 3072)
            for (key, value) in removed {
                inboxStartedAt = max(inboxStartedAt, value.at)
                inboxWatermarks.removeValue(forKey: key)
            }
        }
        var activeReadTokens: Set<String> = []
        for entry in value.sessions {
            for item in [entry.pendingItem, entry.unreadItem].compactMap({ $0 }) {
                let token = item.key + "|" + item.id + "|" + String(item.at)
                activeReadTokens.insert(token)
            }
        }
        inboxReadRequests.formIntersection(activeReadTokens)
        let activeKeys = Set(value.sessions.map(\.key))
        inboxSessionPulses = inboxSessionPulses.filter { activeKeys.contains($0.key) }
        inbox = value
        inboxSessions = Dictionary(value.sessions.map { ($0.key, $0) }, uniquingKeysWith: { _, last in last })
        let railActive = railSessions.filter { session in
            let inbox = inboxSessions[session.key]
            return session.visualStatus == .working || (inbox?.unread ?? 0) + (inbox?.needsAnswer ?? 0) > 0
        }
        // The rail reads in the hover list's order, so a bubble and its row sit at the same place (Martin,
        // 2026-10-23: "the order should be the same in the right and the expanded list"); "stable" keeps places.
        railActivitySessions = snapshot?.state.preferences.railOrder == "stable"
            ? railActive : railActive.sorted(by: Self.previewOrder(inbox: inboxSessions, sort: previewSort))
        inboxOverviewItems = Self.overviewItems(value.sessions)
        reconcileStaged(value.staged ?? value.sessions.flatMap { $0.items ?? [] })
        if !inboxFilterPicked, let opening = snapshot?.state.preferences.inboxFilter, opening != inboxFilter {
            inboxFilter = opening
        }
        previewList = Self.previewRows(
            sessions: snapshot?.sessions ?? [], inbox: inboxSessions,
            filter: previewFilter, sort: previewSort)
    }

    public var previewFilter: String { snapshot?.state.preferences.previewFilter ?? "needs-you" }
    public var previewSort: String { snapshot?.state.preferences.previewSort ?? "attention" }

    /// The hover list. "Needs you": a session with an unanswered item, or a shown session that waits. With the
    /// "active" filter, shown top-level sessions that work or hold unread items join it. Orders: "attention" (waiting
    /// for you, then working, then newest), "recent" (newest activity) and "project" (by project, then newest).
    nonisolated static func previewRows(
        sessions: [WidgetSession], inbox: [String: WidgetInboxSession], filter: String, sort: String
    ) -> [WidgetSession] {
        let rows = sessions.filter { session in
            if needsYou(session, inbox: inbox) { return true }
            guard filter == "active", session.visible, session.parentKey == nil, session.agentId == nil else { return false }
            return session.status == "working" || (inbox[session.key]?.unread ?? 0) > 0
        }
        return rows.sorted(by: previewOrder(inbox: inbox, sort: sort))
    }

    nonisolated static func needsYou(_ session: WidgetSession, inbox: [String: WidgetInboxSession]) -> Bool {
        (inbox[session.key]?.needsAnswer ?? 0) > 0 || (session.visible && session.status == "waiting")
    }

    /// The hover list's order, which the rail's session bubbles share. Equal times fall back to the key, so the two
    /// lists never disagree on a tie.
    nonisolated static func previewOrder(
        inbox: [String: WidgetInboxSession], sort: String
    ) -> (WidgetSession, WidgetSession) -> Bool {
        func rank(_ session: WidgetSession) -> Int {
            needsYou(session, inbox: inbox) ? 0 : session.status == "working" ? 1 : 2
        }
        func newer(_ lhs: WidgetSession, _ rhs: WidgetSession) -> Bool {
            lhs.activityAt == rhs.activityAt ? lhs.key < rhs.key : lhs.activityAt > rhs.activityAt
        }
        return { lhs, rhs in
            switch sort {
            case "recent":
                return newer(lhs, rhs)
            case "project":
                let order = lhs.project.localizedCaseInsensitiveCompare(rhs.project)
                return order == .orderedSame ? newer(lhs, rhs) : order == .orderedAscending
            default:
                let (left, right) = (rank(lhs), rank(rhs))
                return left == right ? newer(lhs, rhs) : left < right
            }
        }
    }

    /// Stores the hover list's filter or order.
    public func setPreview(filter: String? = nil, sort: String? = nil) {
        var patch: [String: WidgetJSON] = [:]
        if let filter { patch["previewFilter"] = .string(filter) }
        if let sort { patch["previewSort"] = .string(sort) }
        guard !patch.isEmpty else { return }
        updatePreferences(patch)
    }

    public func inboxFor(_ key: String) -> WidgetInboxSession? { inboxSessions[key] }
    public func inboxPulseFor(_ key: String) -> Int { inboxSessionPulses[key] ?? 0 }

    /// The session an alert came from, flashed for `attentionSeconds` on its rail bubble, its hover row and its
    /// popup. The counter restarts a running flash (`AttentionPulse`).
    /// One counter per session, so flashing one session never changes another session's trigger.
    @Published public private(set) var attentionCounts: [String: Int] = [:]
    public private(set) var attentionSeconds: Double = 5

    public func flashAttention(_ key: String, seconds: Double) {
        guard seconds > 0 else { return }
        attentionSeconds = seconds
        attentionStarts[key] = Date()
        attentionCounts[key, default: 0] += 1
    }

    /// When each session's flash began, so a row built while it runs flashes for the rest (`AttentionPulse.since`).
    /// Not published: the counter already re-renders the views that flash.
    private var attentionStarts: [String: Date] = [:]

    /// The pulse trigger for one session: changes only when that session is flashed.
    public func attentionTrigger(_ key: String) -> Int { attentionCounts[key] ?? 0 }

    /// When the session's current flash began.
    public func attentionStart(_ key: String) -> Date? { attentionStarts[key] }

    /// The style every flash of a session that needs you uses.
    var attentionStyle: AttentionPulseStyle {
        var style = AttentionPulseStyle.borderFlash(color: .orange, cornerRadius: 12)
        style.duration = attentionSeconds
        style.period = 0.8
        style.fadeIn = 0.18
        style.fadeOut = 0.3
        return style
    }
    /// Every unread or waiting inbox item: what "Mark all read" acts on.
    public var inboxCount: Int { max(0, inbox.unread) + max(0, inbox.needsAnswer) }
    /// The rail badge: only the items that wait for the user's answer (open or drafted decisions and pending
    /// questions), the kind of item the hub's Inbox counts. Unread answers and results do not count: a badge of weeks
    /// of read-later items read as 99+ while the hub said 26 (ux catalogue R1).
    public var waitingCount: Int { max(0, inbox.needsAnswer) }

    /// Expands one inbox card in place. An unread answer or result counts as read once the user opens it, the same
    /// way opening it from a notification does.
    public func openCard(_ card: WidgetCard) {
        foldedCardIDs.remove(card.id)
        selectedCardID = card.id
        guard !stopping, !card.read, ["answer", "result"].contains(card.kind) else { return }
        let token = card.sessionKey + "|" + card.id + "|" + String(card.at)
        guard inboxReadRequests.insert(token).inserted else { return }
        action(["action": "inbox-read", "key": .string(card.sessionKey), "id": .string(card.id),
                "kind": .string(card.kind), "at": .number(card.at)], failed: { [weak self] in
            self?.inboxReadRequests.remove(token)
        })
    }

    /// Opens a decision's card by its id (`d_<n>_<session>`), in its own session when that is another one: the
    /// "Superseded by" link. The card arrives with that session's snapshot, so the selection is set after `select`.
    public func openDecision(id: String, sessionKey: String?) {
        guard let sessionKey else {
            notice = "That decision's session is not in the widget."
            return
        }
        if sessionKey != selectedKey { select(sessionKey) }
        section = "Inbox"
        foldedCardIDs.remove("decision:" + id)
        selectedCardID = "decision:" + id
    }

    /// "Mark all read": every answer up to now is read, and older questions, decisions and results stop counting in
    /// the badges. Nothing is deleted or answered; each item stays in its session's inbox.
    public func markAllRead() {
        guard !stopping else { return }
        let at = (Date().timeIntervalSince1970 * 1000).rounded(.down)
        action(["action": "inbox-clear", "at": .number(at)], completed: { [weak self] in
            self?.notice = "Inbox marked read. Every item stays in its session."
        })
    }

    public func openInboxNotification(on surface: WidgetSurfaceID, key: String? = nil, needsAnswer: Bool? = nil) {
        guard !stopping else { return }
        listOrigin = .overview
        let candidates: [WidgetInboxSession]
        if let key {
            candidates = inboxSessions[key].map { [$0] } ?? []
        } else {
            candidates = inbox.sessions
        }
        let item = candidates.compactMap { entry in
            needsAnswer == true ? entry.pendingItem : needsAnswer == false ? entry.unreadItem : entry.pendingItem ?? entry.unreadItem
        }.max { a, b in
            if needsAnswer == nil && a.needsAnswer != b.needsAnswer { return !a.needsAnswer }
            return a.at < b.at
        }
        guard let item else {
            if let key { select(key) }
            section = "Inbox"
            openModule("agents", on: surface)
            return
        }
        openingInbox = item
        select(item.key)
        selectedCardID = item.id
        section = "Inbox"
        openModule("agents", on: surface)
        acknowledgeOpenedInbox()
    }

    /// The overview's entries from every session: the waiting ones first, then newest first. A hub from before the
    /// per-session list gives each session's pending and unread item. Stored when the inbox changes: up to 512
    /// sessions × 8 entries, sorted, is too much to derive in a body that reads it several times per pass.
    public private(set) var inboxOverviewItems: [WidgetInboxItem] = []
    /// Every staged decision of every session (the decision log's unsent picks and notes), stored with the inbox.
    @Published var stagedRows: [WidgetInboxItem] = []
    /// The staged decisions that may be sent: `stagedRows` without a decision dismissed or completed while its Undo
    /// runs (`heldDecisionIDs`). Every send, the leave question and the Review list read this, so a close that sends
    /// can never deliver an answer the user just discarded.
    public var stagedItems: [WidgetInboxItem] { stagedRows.filter { !heldDecisionIDs.contains($0.sourceId) } }
    /// Picks staged or cleared here that the next snapshot has not shown yet, by decision id ("" is a cleared pick).
    @Published var pendingStage: [String: String] = [:]
    /// Decisions whose send runs now, so their Send now says Sending… and a second press cannot send them twice.
    @Published public var sendingDecisionIDs: Set<String> = []
    /// The question about staged decisions before the panel closes (`requestCollapse`).
    @Published public var stagedLeavePrompt = false
    /// The staged decisions view: nil closed, "session" for the selected session's, "all" for every session's.
    @Published public var stagedView: String?
    /// The staged decisions the user kept at the last leave; the prompt asks again only for a newly staged one.
    var keptStaged: Set<String> = []
    /// User edits and selections invalidate a send's pending automatic close, even if changed back afterwards.
    var sendCloseRevision = 0
    /// When this widget last saved a decision's draft, by card id, for the card's "Draft saved" line.
    @Published public var draftSavedAt: [String: Date] = [:]

    nonisolated static func overviewItems(_ sessions: [WidgetInboxSession]) -> [WidgetInboxItem] {
        sessions.flatMap { entry in entry.items ?? [entry.pendingItem, entry.unreadItem].compactMap { $0 } }
            .sorted { lhs, rhs in
                lhs.needsAnswer == rhs.needsAnswer ? (lhs.at == rhs.at ? lhs.id < rhs.id : lhs.at > rhs.at) : lhs.needsAnswer
            }
    }

    /// An overview entry's "Open in session": that session's inbox with the entry open.
    /// The list a session was opened from, which the first Esc goes back to (Martin, 2026-10-23: "it should first go
    /// to the list and the second escape should close the expansion entirely").
    public enum ListOrigin: Sendable { case overview, sessions }
    public var listOrigin: ListOrigin = .overview

    /// Esc in a session: back to the list it came from. False when a list (or no session) is on screen, so Esc then
    /// closes the panel.
    @discardableResult
    public func escapeToList() -> Bool {
        guard activeModuleID == "agents", selected != nil, !inboxOverview, section != "Sessions" else { return false }
        switch listOrigin {
        case .overview: inboxOverview = true
        case .sessions: section = "Sessions"
        }
        return true
    }

    /// Opens `item` in its session's inbox, unfolded; with `surface`, the panel opens there too.
    public func openInboxItem(_ item: WidgetInboxItem, on surface: WidgetSurfaceID? = nil) {
        guard !stopping else { return }
        listOrigin = .overview
        openingInbox = item
        select(item.key)
        selectedCardID = item.id
        foldedCardIDs.remove(item.id)
        section = "Inbox"
        if let surface { openModule("agents", on: surface) }
        acknowledgeOpenedInbox()
    }

    /// The alert card's header, Open and Write my own answer: the alert's own item opens in its session (not the
    /// session's newest one); with `ownAnswer` its own answer field takes the keyboard, holding a staged note.
    public func openAlert(_ item: WidgetInboxItem, on surface: WidgetSurfaceID, ownAnswer: Bool = false) {
        openInboxItem(item, on: surface)
        guard ownAnswer, !stopping else { return }
        ownAnswerCardID = item.id
        ownAnswerFocusRequest = item.id
        if draft.text.isEmpty, let note = item.draft, !note.isEmpty { setText(note) }
    }

    /// The inbox button: every session's entries in one list. A second click while that list is open hides the panel.
    public func toggleInboxOverview(on surface: WidgetSurfaceID) {
        guard !stopping else { return }
        if presentation(for: surface) == .expanded, activeModuleID == "agents", inboxOverview {
            requestCollapse()
            return
        }

        inboxOverview = true
        section = "Inbox"
        openModule("agents", on: surface)
    }

    /// A session button on the rail or the top strip: opens that session's inbox, or hides the panel when the same
    /// session is already open there (Martin, 2026-10-23: a second click did nothing).
    public func toggleSession(_ key: String, on surface: WidgetSurfaceID) {
        guard !stopping else { return }
        PerfLog.mark("widget.toggle-session surface=\(surface.key) presentation=\(presentation(for: surface)) module=\(activeModuleID) overview=\(inboxOverview) same=\(selectedKey == key) group=\(activeSideGroup)")
        if presentation(for: surface) == .expanded, activeModuleID == "agents", !inboxOverview, selectedKey == key {
            requestCollapse()
            return
        }

        openInboxNotification(on: surface, key: key)
    }

    private func acknowledgeOpenedInbox() {
        guard !stopping, let item = openingInbox, expanded != nil, activeModuleID == "agents", section == "Inbox",
            selectedKey == item.key, let displayed = cards.first(where: { $0.id == item.id }), displayed.at == item.at
        else { return }
        selectedCardID = item.id
        if !displayed.needsAnswer && displayed.read { openingInbox = nil; return }
        let token = item.key + "|" + item.id + "|" + String(item.at)
        guard inboxReadRequests.insert(token).inserted else { openingInbox = nil; return }
        openingInbox = nil
        action(["action": "inbox-read", "key": .string(item.key), "id": .string(item.id),
                "kind": .string(item.kind), "at": .number(item.at)], failed: { [weak self] in
            self?.inboxReadRequests.remove(token)
        })
    }

    /// Every fold logs its caller, so "the widget folded" is found in app-perf.log (18 fold paths logged nothing,
    /// 2026-10-25 hover hunt).
    public func collapse(file: StaticString = #fileID, line: UInt = #line) {
        if expanded != nil {
            PerfLog.mark("widget.collapse \(expanded?.rawValue ?? "") from \(file):\(line)")
        }
        noticeHovered(false)
        cancelHoverPrewarm()
        agentFitFloor = nil
        openingInbox = nil
        followedTranscript = nil
        hoveredSurface = nil
        hoverTask?.cancel()
        peekTask?.cancel()
        peekItem = nil
        restorePeekModule()
        voice?.finishInput()
        speechTask?.cancel()
        reading = false
        expanded = nil
        tail?.stop()
        tail = nil
        transcriptTask?.cancel()
        transcriptCache.cancelPending()
        quietTask?.cancel()
        presentationChanged?()
    }

    public func select(_ key: String, edge: EdgePanelPlacement? = nil) {
        if selectedKey != key { composerGeneration += 1 }
        sendCloseRevision += 1
        if openingInbox?.key != key { openingInbox = nil }
        inboxOverview = false
        selectedKey = key
        choiceFocus = nil
        lastSelected = snapshot?.sessions.first { $0.key == key }
        if expanded != nil { refreshContext() }
        selectedCardID = nil
        if inboxLoading {
            holdAgentFit()
            loadingFitHold = key
        }
        // How often a switch still has to wait: `loading=true` means no snapshot carried this session yet.
        PerfLog.mark("widget.select loading=\(inboxLoading) cards=\(cards.count) cached=\(sessionCache.count)")
        pickOnWatch(key)
        action(["action": "selection", "key": .string(key)])
        if let edge { open(edge) }
        if expanded != nil || hoveredSurface != nil { prewarmTranscript(on: expanded == nil ? hoveredSurface : nil) }
        resumeTranscript()
    }

    /// Tells the running watch at once, so its next snapshot names this session (about 0.1 s) instead of after the
    /// `selection` action reaches its state file (a process and a 180 ms debounce, about 0.5 s). The action still runs:
    /// it keeps the choice for the next launch.
    private func pickOnWatch(_ key: String) {
        guard let watcher, let data = try? JSONEncoder().encode(["select": key]),
              let line = String(data: data, encoding: .utf8) else { return }
        do { try watcher.sendInput(line + "\n") } catch { PerfLog.mark("widget.pick not sent: \(error.localizedDescription)") }
    }

    public func unpinSelected() {
        let old = selectedKey
        action(["action": "visibility", "key": .string(old), "pinned": false])
        if let next = sessions.first(where: { $0.key != old }) { select(next.key) } else { collapse() }
    }

    public func next(_ direction: Int = 1) {
        guard !sessions.isEmpty else { return }
        let index = sessions.firstIndex { $0.key == selectedKey } ?? 0
        select(sessions[(index + direction + sessions.count) % sessions.count].key)
    }

    // MARK: Up, Down and Return in the lists (ux catalogue R7)

    /// The last list key, for the view that draws the list on screen: the inbox of every session moves its own
    /// highlight with it, and a session's inbox and the session list scroll to the row it chose.
    @Published public private(set) var listKey: WidgetListKey?
    /// The session inbox's filter ("all", "inbox", "decisions"), so the keys walk the rows the user sees. The
    /// inbox's filter control writes it.
    @Published public var inboxFilter = "all"
    /// Set once the reader picks a filter; until then the filter follows the `inboxFilter` setting.
    public var inboxFilterPicked = false
    /// The option of the open decision card that Up and Down chose; nil while the card row itself is chosen. Kept
    /// with its card, because option ids ("a", "b") repeat across decisions.
    @Published public var choiceFocus: WidgetChoiceFocus?
    /// The session list's rows in the order it draws them (its search, pins and open groups applied), written by
    /// the list as it changes. Empty: the list has not said, and the keys leave it alone.
    public var sessionListOrder: [String] = []
    /// Whether the inbox of every session has a row the keys chose, written by that view. Without one, Return is not
    /// the list's and reaches the focused control (Mark all read).
    public var inboxOverviewHasFocus = false

    /// Whether the agents pane shows a list that takes Up, Down and Return: the inbox of every session, a session's
    /// inbox with entries, or the session list. Not the staged view, the leave question or the conversation.
    public var keyboardList: Bool {
        guard expanded != nil, activeModuleID == "agents", stagedView == nil, !stagedLeavePrompt else { return false }
        if inboxOverview { return !inboxOverviewItems.isEmpty }
        guard selected != nil else { return false }
        return (section == "Sessions" && !sessionListOrder.isEmpty) || (section == "Inbox" && !cards.isEmpty)
    }

    /// Up, Down or Return in the list on screen. True when the list took the key; false lets it through (the scroll
    /// view then scrolls). The ends of a list stop the move; they do not wrap.
    @discardableResult
    public func moveInList(_ kind: WidgetListKey.Kind, controlFocused: Bool = false) -> Bool {
        guard keyboardList else { return false }
        if kind == .open, controlFocused { return false }
        if inboxOverview, kind == .open, !inboxOverviewHasFocus { return false }
        listKey = WidgetListKey(kind: kind, serial: (listKey?.serial ?? 0) + 1)
        // The inbox of every session owns its filter, grouping and highlight (WidgetInboxOverview).
        if inboxOverview { return true }
        switch section {
        case "Inbox": return moveCard(kind)
        case "Sessions": return moveSession(kind)
        default: return false
        }
    }

    /// The row `step` rows from `current` in `count` rows, stopping at the ends; with no current row, the first row
    /// going down and the last going up.
    nonisolated static func listTarget(current: Int?, step: Int, count: Int) -> Int? {
        guard count > 0 else { return nil }
        guard let current else { return step < 0 ? count - 1 : 0 }
        return min(max(current + step, 0), count - 1)
    }

    /// Where Up or Down goes among an open decision's options: to an option, back to the card row (Up from the first
    /// option), or out of the card (Up from the card row, Down from the last option).
    enum OptionMove: Equatable { case option(Int), cardRow, leave }

    nonisolated static func optionMove(focused: Int?, step: Int, count: Int) -> OptionMove {
        guard count > 0 else { return .leave }
        guard let focused else { return step < 0 ? .leave : .option(0) }
        let target = focused + step
        if target < 0 { return .cardRow }
        return target < count ? .option(target) : .leave
    }

    /// A session's inbox, as drawn: the filter's rows, newest first. Up and Down open the row above or below (the
    /// inbox shows one open row) and, in an open decision, walk its options first; Return folds or opens the current
    /// row, or picks the chosen option the way a click does. No motion: the keys repeat.
    private func moveCard(_ kind: WidgetListKey.Kind) -> Bool {
        let shown = Array(LiveWidgetView.filtered(cards, by: inboxFilter).reversed())
        guard !shown.isEmpty else { return false }
        let current = card.flatMap { open in shown.firstIndex { $0.id == open.id } }
        // The open decision's options, when the row the keys stand on is that decision.
        let decision = current.flatMap { index in answerCard.flatMap { $0.id == shown[index].id ? $0 : nil } }
        let focused = decision.flatMap { open in
            choiceFocus?.cardID == open.id ? open.choices.firstIndex(where: { $0.id == choiceFocus?.choiceID }) : nil
        }
        releaseAgentFit()
        switch kind {
        case .open:
            guard let current else { return false }
            if let decision, let focused {
                guard decisionClickStages else {
                    // Return never sends (ux checklist, Keyboard); with "Send at once" the number key does.
                    postNote("Return does not send an answer. Press \(focused + 1) to send this one.")
                    return true
                }
                choose(decision, option: decision.choices[focused].id)
            } else if foldedCardIDs.contains(shown[current].id) {
                openCard(shown[current])
            } else {
                foldedCardIDs.insert(shown[current].id)
            }
        case .up, .down:
            let step = kind == .up ? -1 : 1
            if let decision {
                switch Self.optionMove(focused: focused, step: step, count: decision.choices.count) {
                case .option(let index):
                    choiceFocus = WidgetChoiceFocus(cardID: decision.id, choiceID: decision.choices[index].id)
                    return true
                case .cardRow:
                    choiceFocus = nil
                    return true
                case .leave:
                    break
                }
            }
            guard let target = Self.listTarget(current: current, step: step, count: shown.count),
                  target != current || foldedCardIDs.contains(shown[target].id) else { return true }
            choiceFocus = nil
            openCard(shown[target])
        }
        return true
    }

    /// The session list: Up and Down select the session above or below (its row shows the selection), Return opens
    /// its inbox, and Esc comes back to the list.
    private func moveSession(_ kind: WidgetListKey.Kind) -> Bool {
        let order = sessionListOrder
        guard !order.isEmpty else { return false }
        let current = order.firstIndex(of: selectedKey)
        switch kind {
        case .open:
            guard current != nil else { return false }
            listOrigin = .sessions
            section = "Inbox"
        case .up, .down:
            guard let target = Self.listTarget(current: current, step: kind == .up ? -1 : 1, count: order.count),
                  order[target] != selectedKey else { return true }
            select(order[target])
        }
        return true
    }


    /// A field keeps its session and generation, while a newly rendered composer accepts any text, even a repeat.
    func composerText(ownAnswer: String? = nil) -> Binding<String> {
        let key = selectedKey
        let generation = composerGeneration
        // An own answer field shows the draft only while its card holds it; closed, it is an empty field under the
        // options, and the reply composer's text stays out of it.
        return Binding(get: { [weak self] in
            guard let self, ownAnswer == nil || self.ownAnswerCardID == ownAnswer else { return "" }
            return self.drafts[key]?.text ?? ""
        }, set: { [weak self] text in
            guard let self, self.selectedKey == key, self.composerGeneration == generation,
                  ownAnswer == nil || self.ownAnswerCardID == ownAnswer else { return }
            self.setText(text)
        })
    }

    public func setText(_ text: String) {
        sendCloseRevision += 1
        let key = selectedKey
        guard !key.isEmpty else { return }

        var value = drafts[key] ?? WidgetDraft()
        value.text = String(text.prefix(Self.draftTextLimit))
        drafts[key] = value
        dirtyDrafts.insert(key)
        draftRevisions[key, default: 0] += 1
        let revision = draftRevisions[key, default: 0]
        draftTasks[key]?.cancel()
        let captured = value.text
        draftTasks[key] = Task { [weak self] in
            do { try await Task.sleep(for: .milliseconds(350)) } catch { return }
            guard let self, self.draftRevisions[key, default: 0] == revision else { return }
            self.action(["action": "draft-text", "key": .string(key), "text": .string(captured)], completed: {
                [weak self] in
                guard let self, self.draftRevisions[key, default: 0] == revision,
                    self.drafts[key]?.text == captured else { return }
                self.dirtyDrafts.remove(key)
            })
        }
        scheduleQuietReduction()
    }

    public func attachShelfItem(_ id: String, to key: String) async throws {
        let previous = mutationTask
        let operation = Task { [weak self] in
            await previous?.value
            try Task.checkCancellation()
            guard let self, !self.stopping else { throw CancellationError() }
            let response = try await self.call(["action": "shelf-attachment", "key": .string(key), "id": .string(id)])
            try Task.checkCancellation()
            guard !self.stopping else { throw CancellationError() }
            let attachment = try JSONDecoder().decode(WidgetShelfAttachment.self, from: JSONEncoder().encode(response))
            var latest = attachment.draft
            if self.dirtyDrafts.contains(key), let local = self.drafts[key] { latest.text = local.text }
            let merged = try attachment.merging(into: latest)
            self.draftTasks[key]?.cancel()
            self.draftRevisions[key, default: 0] += 1
            let revision = self.draftRevisions[key, default: 0]
            self.drafts[key] = merged
            self.dirtyDrafts.insert(key)
            if let assetId = attachment.assetId { self.submittedAssets.remove(assetId) }
            _ = try await self.call(["action": "draft", "key": .string(key), "draft": try .value(merged)])
            try Task.checkCancellation()
            guard !self.stopping else { throw CancellationError() }
            if self.draftRevisions[key, default: 0] == revision, self.drafts[key] == merged {
                self.dirtyDrafts.remove(key)
            }
        }
        // The queue tail waits for completion; the originating caller owns the throwing result.
        mutationTask = Task { _ = await operation.result }
        try await withTaskCancellationHandler {
            try await operation.value
        } onCancel: {
            operation.cancel()
        }
    }

    public func attachVoiceNote(_ note: WidgetVoiceNote, to key: String) async throws {
        guard !note.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw ToolsBridgeError.refused("The voice note has no text to attach.")
        }
        let previous = mutationTask
        let operation = Task { [weak self] in
            await previous?.value
            try Task.checkCancellation()
            guard let self, !self.stopping else { throw CancellationError() }
            let revisionBeforeAppend = self.draftRevisions[key, default: 0]
            // Refuse before any backend write; the check after the append still covers concurrent typing.
            let localText = self.drafts[key]?.text ?? ""
            let expectedLength = localText.isEmpty ? note.text.count : localText.count + 1 + note.text.count
            guard expectedLength <= Self.draftTextLimit else { throw Self.draftTooLong }
            if self.dirtyDrafts.contains(key), let local = self.drafts[key] {
                _ = try await self.call(["action": "draft-text", "key": .string(key), "text": .string(local.text)])
            }
            try Task.checkCancellation()
            let response = try await self.call(["action": "append-draft", "key": .string(key), "text": .string(note.text)])
            try Task.checkCancellation()
            guard !self.stopping else { throw CancellationError() }
            var merged = try JSONDecoder().decode(WidgetDraft.self, from: JSONEncoder().encode(response))
            if self.draftRevisions[key, default: 0] != revisionBeforeAppend, let local = self.drafts[key] {
                merged.text = [local.text, note.text].filter { !$0.isEmpty }.joined(separator: " ")
            }
            guard merged.text.count <= Self.draftTextLimit else { throw Self.draftTooLong }
            self.draftTasks[key]?.cancel()
            self.draftRevisions[key, default: 0] += 1
            let savedRevision = self.draftRevisions[key, default: 0]
            self.drafts[key] = merged
            self.dirtyDrafts.insert(key)
            _ = try await self.call(["action": "draft-text", "key": .string(key), "text": .string(merged.text)])
            try Task.checkCancellation()
            if self.draftRevisions[key, default: 0] == savedRevision, self.drafts[key]?.text == merged.text {
                self.dirtyDrafts.remove(key)
            }
        }
        mutationTask = Task { _ = await operation.result }
        try await withTaskCancellationHandler { try await operation.value } onCancel: { operation.cancel() }
    }

    /// `preferences` with the saved patches not yet seen in a snapshot, then the ones still to be written, on top.
    private func overlaid(_ preferences: WidgetPreferences) throws -> WidgetPreferences {
        var patch: [String: WidgetJSON] = [:]
        for entry in savedPreferences { patch.merge(entry.patch) { _, new in new } }
        patch.merge(pendingPreferences) { _, new in new }
        return try mergingPreferences(patch, into: preferences)
    }

    /// A write landed: its patch stays shown until a snapshot read at or after the revision it stored arrives.
    private func holdSaved(_ patch: [String: WidgetJSON]) {
        let id = UUID()
        savedPreferences.append((id, nil, patch))
        let file = Self.widgetStateFile(stateRoot: stateRoot)
        Task { [weak self] in
            let revision = await Task.detached(priority: .utility) { Self.storedRevision(file) }.value
            self?.fenceSaved(id, at: revision)
        }
    }

    private func fenceSaved(_ id: UUID, at revision: Int?) {
        guard let index = savedPreferences.firstIndex(where: { $0.id == id }) else { return }
        guard let revision else {
            // Unreadable: the patch is dropped as before, rather than shown over every later snapshot.
            savedPreferences.remove(at: index)
            return
        }

        savedPreferences[index].fence = revision
        // The snapshot on screen may already be that new; then it shows what is stored now.
        guard let last = lastReceived, last.state.revision >= revision, var current = snapshot else { return }
        savedPreferences.remove(at: index)
        do {
            current.state.preferences = try overlaid(last.state.preferences)
            snapshot = current
            presentationChanged?()
        } catch { report(error) }
    }

    /// state.json's revision (`hub widget` bumps it on every stored change); nil when it cannot be read.
    nonisolated static func storedRevision(_ path: String) -> Int? {
        struct Stored: Decodable { let revision: Int }
        do {
            return try JSONDecoder().decode(Stored.self, from: Data(contentsOf: URL(fileURLWithPath: path))).revision
        } catch {
            PerfLog.mark("widget.preferences revision unreadable: \(error.localizedDescription)")
            return nil
        }
    }

    private func mergingPreferences(
        _ patch: [String: WidgetJSON], into preferences: WidgetPreferences
    ) throws -> WidgetPreferences {
        guard case .object(var fields) = try WidgetJSON.value(preferences) else { return preferences }
        fields.merge(patch) { _, new in new }
        return try JSONDecoder().decode(WidgetPreferences.self, from: JSONEncoder().encode(WidgetJSON.object(fields)))
    }

    /// Shows `patch` at once and writes it after a short pause, merged with the patches that follow. `saved` or
    /// `failed` runs when the write that carries it ends, so a page can confirm only what was stored.
    public func updatePreferences(
        _ patch: [String: WidgetJSON], saved: (() -> Void)? = nil, failed: (() -> Void)? = nil
    ) {
        pendingPreferences.merge(patch) { _, new in new }
        if saved != nil || failed != nil {
            pendingPreferenceOutcomes.append((saved ?? {}, failed ?? {}))
        }
        if var current = snapshot {
            do {
                current.state.preferences = try mergingPreferences(patch, into: current.state.preferences)
                snapshot = current
                presentationChanged?()
            } catch { report(error) }
        }
        preferenceTask?.cancel()
        preferenceTask = Task { [weak self] in
            do { try await Task.sleep(for: .milliseconds(180)) } catch { return }
            self?.flushPreferences()
        }
    }

    private func flushPreferences() {
        let patch = pendingPreferences
        guard !patch.isEmpty else { return }
        let outcomes = pendingPreferenceOutcomes
        pendingPreferenceOutcomes = []
        preferenceWriteEpoch += 1
        preferenceWritesInFlight += 1
        /// True when it started the settings read a stale one put off.
        @discardableResult func acknowledge() -> Bool {
            preferenceWriteEpoch += 1
            preferenceWritesInFlight -= 1
            for (key, value) in patch where pendingPreferences[key] == value {
                pendingPreferences.removeValue(forKey: key)
            }
            guard preferenceWritesInFlight == 0, settingsRefreshAfterWrites, !stopping else { return false }
            settingsRefreshAfterWrites = false
            refreshSettings()
            return true
        }
        action(
            ["action": "preferences", "patch": .object(patch)],
            failed: { [weak self] in
                let reread = acknowledge()
                outcomes.forEach { $0.failed() }
                if !reread { self?.refreshSettings() }
            },
            completed: { [weak self] in
                self?.holdSaved(patch)
                acknowledge()
                outcomes.forEach { $0.saved() }
                self?.preferencesSaved?(patch)
            })
    }

    public func action(
        _ value: WidgetJSON, failed: (() -> Void)? = nil, completed: (() -> Void)? = nil
    ) {
        if completed == nil, failed == nil, case .object(let request) = value,
            request["action"] == .string("preferences"), case .object(let patch) = request["patch"]
        {
            updatePreferences(patch)
            return
        }
        let draftKey: String?
        if case .object(let fields) = value, fields["action"] == .string("draft-text"), case .string(let key) = fields["key"] {
            draftKey = key
        } else {
            draftKey = nil
        }
        let draftRevision = draftKey.map { draftRevisions[$0, default: 0] }
        let previous = mutationTask
        mutationTask = Task { [weak self] in
            await previous?.value
            guard let self else { return }
            if let draftKey, self.draftRevisions[draftKey, default: 0] != draftRevision { return }
            do {
                _ = try await self.call(value)
                completed?()
                if self.settingsOnly { self.refreshSettings() }
            } catch {
                failed?()
                self.report(error)
            }
        }
    }

    /// Runs `work` after every hub write queued before it, and holds the later ones until it is done.
    func afterMutations(_ work: @escaping @MainActor () async -> Void) {
        let previous = mutationTask
        mutationTask = Task {
            await previous?.value
            await work()
        }
    }

    @discardableResult
    func call(_ value: WidgetJSON, timeoutSeconds: Int = 120) async throws -> WidgetJSON {
        if let actionRunner { return try await actionRunner(value) }
        let file = journal.appendingPathComponent("action-" + UUID().uuidString + ".tmp")
        try JSONEncoder().encode(value).write(to: file, options: .atomic)
        defer {
            do { try FileManager.default.removeItem(at: file) } catch {
                PerfLog.mark("widget.action cleanup \(error.localizedDescription)")
            }
        }
        return try await runAction(file, timeoutSeconds: timeoutSeconds)
    }

    private func runAction(_ file: URL, timeoutSeconds: Int = 120) async throws -> WidgetJSON {
        let result = try await bridge.run(
            subcommand: "hub", args: widgetArgs + ["call", "--input", file.path], timeoutSeconds: timeoutSeconds)
        guard result.exitCode == 0 else {
            throw ToolsBridgeError.refused(String(result.stderr.suffix(1200)))
        }
        return try JSONDecoder().decode(WidgetJSON.self, from: Data(result.stdout.utf8))
    }

    /// Sends every saved submission to the hub in submission order. After one fails, the later submissions to the
    /// same conversation stay saved: sending them first would give them an earlier hub sequence and deliver them
    /// ahead of it. The next drain (a new submission or a restart) retries the failed one first.
    func drainJournal() {
        let previous = mutationTask
        mutationTask = Task { [weak self] in
            await previous?.value
            guard let self else { return }
            let files: [URL]
            do {
                files = try FileManager.default.contentsOfDirectory(at: self.journal, includingPropertiesForKeys: nil)
                    .filter { $0.pathExtension == "json" }
                    .sorted { $0.lastPathComponent < $1.lastPathComponent }
            } catch {
                self.report(error)
                return
            }
            var blocked = Set<String>()
            for file in files {
                let conversation = Self.journalConversation(file)
                guard !blocked.contains(conversation) else { continue }
                do {
                    _ = try await self.runAction(file)
                    try FileManager.default.removeItem(at: file)
                } catch {
                    blocked.insert(conversation)
                    self.error =
                        "Your message is saved locally. Reconnect to retry queuing it. "
                        + error.localizedDescription
                    PerfLog.mark("widget.enqueue retained journal \(error.localizedDescription)")
                }
            }
        }
    }

    /// The conversation a saved submission targets. An unreadable file is its own conversation, so it never holds
    /// back another one.
    private static func journalConversation(_ file: URL) -> String {
        do {
            let request = try JSONDecoder().decode(WidgetJSON.self, from: Data(contentsOf: file))
            guard case .object(let fields) = request, let target = fields["target"] else { return file.path }
            let decoded = try JSONDecoder().decode(WidgetTarget.self, from: JSONEncoder().encode(target))
            return [decoded.hostId, decoded.provider, decoded.sessionId, decoded.sourceHome].joined(separator: "\u{1F}")
        } catch {
            PerfLog.mark("widget.journal unreadable \(error.localizedDescription)")
            return file.path
        }
    }

    /// Send (Return): in a decision's own answer field it answers that decision; in the reply composer it is a
    /// follow-up to the session, as its "Reply to …" says. The reply composer used to answer the open decision too,
    /// which nothing on screen said, and the decision's own field is now under its options.
    public func send() {
        if ownAnswerCard != nil {
            submitOwnAnswer()
            return
        }
        submit()
    }

    /// Sends the draft (text and media) as the answer to `ownAnswerCard`, with no option picked.
    public func submitOwnAnswer() {
        guard let card = ownAnswerCard else { return }
        guard !draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !draft.assetIds.isEmpty else {
            postNote("Write your answer or attach media first.")
            return
        }
        submit(answering: true)
        if submittedCards.contains(card.id) { ownAnswerCardID = nil }
    }

    /// `withDraft`: the draft's text and media go with it and the draft empties. Without, an option goes alone and a
    /// reply being typed in the composer stays where it is.
    public func submit(choice: String? = nil, answering: Bool = false, withDraft: Bool = true) {
        guard let session = selected, importing == 0 else { return }
        let submitted = withDraft ? draft : WidgetDraft()
        do {
            var payload: WidgetJSON = ["kind": "followup", "text": .string(submitted.text)]
            if let card, answering || choice != nil {
                guard !submittedCards.contains(card.id) else {
                    error = "This answer is already in the outgoing queue."
                    return
                }
                if card.kind == "decision", card.needsAnswer {
                    payload = [
                        "kind": "decision", "id": .string(card.sourceId),
                        "number": .number(Double(card.number ?? 0)),
                        "expectedRevision": .number(Double(card.revision ?? 1)),
                        "text": .string(submitted.text),
                    ]
                    if case .object(var fields) = payload, let choice {
                        fields["option"] = .string(choice)
                        payload = .object(fields)
                    }
                } else if card.kind == "form", card.needsAnswer {
                    let answers = (card.formItems ?? []).map { item in
                        formAnswers[card.id]?[item.id] ?? WidgetFormAnswer(itemId: item.id)
                    }
                    // The composer text goes with the answers as their context (dispatch puts it on the first one).
                    payload = [
                        "kind": "form", "id": .string(card.sourceId), "text": .string(submitted.text),
                        "answers": try .value(answers),
                    ]
                }
            }
            if !answering && choice == nil
                && submitted.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                && submitted.assetIds.isEmpty
            {
                return
            }
            let request: WidgetJSON = [
                "action": "enqueue", "id": .string(UUID().uuidString.lowercased()),
                "target": try .value(session.target), "payload": payload,
                "assetIds": try .value(submitted.assetIds), "draftSnapshot": try .value(submitted),
            ]
            let file = journal.appendingPathComponent(
                String(Int64(Date().timeIntervalSince1970 * 1000)) + "-" + UUID().uuidString + ".json")
            try JSONEncoder().encode(request).write(to: file, options: .atomic)
            guard withDraft else {
                if let card, answering || choice != nil { submittedCards.insert(card.id) }
                drainJournal()
                return
            }
            draftTasks[selectedKey]?.cancel()
            dirtyDrafts.insert(selectedKey)
            drafts[selectedKey] = WidgetDraft()
            // A save of the typed text still on its way would land after the clear below and put the sent text back
            // on the hub; a new revision makes it skip itself.
            draftRevisions[selectedKey, default: 0] += 1
            composerGeneration += 1
            submittedAssets.formUnion(submitted.assetIds)
            if let card, answering || choice != nil { submittedCards.insert(card.id) }
            action(["action": "draft-text", "key": .string(selectedKey), "text": ""])
            drainJournal()
        } catch { report(error) }
    }

    /// `ownsFile`: the file is a staging copy this model wrote (a pasted image); the import copies it into
    /// the asset store, so the copy is removed once the import ends, whatever its outcome.
    public func importFile(_ url: URL, ownsFile: Bool = false) {
        importFile(url, to: selectedKey, ownsFile: ownsFile)
    }

    private func importFile(_ url: URL, to key: String, ownsFile: Bool = false) {
        guard !stopping, !key.isEmpty else {
            if ownsFile { removeStaging(url) }
            return
        }
        let type = UTType(filenameExtension: url.pathExtension)
        let kind =
            type?.conforms(to: .movie) == true || type?.conforms(to: .video) == true ? "video" : "image"
        importing += 1
        let previous = mutationTask
        mutationTask = Task { [weak self] in
            await previous?.value
            guard let self else { return }
            defer {
                self.importing -= 1
                if ownsFile { self.removeStaging(url) }
            }
            do {
                _ = try await self.call([
                    "action": "import", "key": .string(key), "input": .string(url.path),
                    "type": .string(kind),
                ])
            } catch { self.report(error) }
        }
    }

    public func chooseFiles() {
        guard !stopping, !selectedKey.isEmpty else { return }
        if let panel = mediaPicker {
            panel.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }
        let key = selectedKey
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.image, .movie, .video]
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        mediaPicker = panel
        dialogOpen = true
        panel.begin { [weak self] response in
            guard let self, self.mediaPicker === panel else { return }
            self.mediaPicker = nil
            self.dialogOpen = false
            if response == .OK, !self.stopping {
                panel.urls.forEach { self.importFile($0, to: key) }
            }
        }
        panel.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    public func pasteMedia() -> Bool {
        let pasteboard = NSPasteboard.general
        if let urls = pasteboard.readObjects(forClasses: [NSURL.self]) as? [URL] {
            let local = urls.filter(\.isFileURL)
            if !local.isEmpty {
                local.forEach { importFile($0) }
                return true
            }
        }
        guard let image = NSImage(pasteboard: pasteboard), let tiff = image.tiffRepresentation,
            let bitmap = NSBitmapImageRep(data: tiff),
            let png = bitmap.representation(using: .png, properties: [:])
        else { return false }
        do {
            let file = journal.appendingPathComponent("paste-" + UUID().uuidString + ".png")
            try png.write(to: file, options: .atomic)
            importFile(file, ownsFile: true)
            return true
        } catch {
            report(error)
            return false
        }
    }

    /// Runs behind every pending mutation. A draft save still waiting on its debounce is sent first, so it reaches
    /// the hub before the edit and can never overwrite the restored text afterwards.
    public func editOutgoing(_ message: WidgetOutgoing) {
        let key = snapshot?.sessions.first { $0.target.hasSameIdentity(as: message.target) }?.key ?? selectedKey
        // A draft save still waiting to run would reach the hub after the edit and overwrite the restored text,
        // so it goes first, on the same mutation chain.
        if draftTasks[key] != nil {
            draftTasks[key]?.cancel()
            draftTasks[key] = nil
            action(["action": "draft-text", "key": .string(key), "text": .string(drafts[key]?.text ?? "")])
        }
        let previous = mutationTask
        mutationTask = Task { [weak self] in
            await previous?.value
            guard let self, !self.stopping else { return }
            do {
                let current = self.drafts[key] ?? WidgetDraft()
                guard current.text.isEmpty, current.assetIds.isEmpty else {
                    throw ToolsBridgeError.refused("Save or clear your current draft before editing an earlier message.")
                }
                let revision = self.draftRevisions[key, default: 0]
                let answersBefore = self.formAnswers
                _ = try await self.call(["action": "edit", "id": .string(message.id)])
                guard !self.stopping else { return }
                var restored = WidgetDraft(assetIds: message.assetIds)
                if case .object(let fields) = message.payload, case .string(let text) = fields["text"] {
                    restored.text = text
                }
                var notice = "Message restored as a draft."
                if self.draftRevisions[key, default: 0] != revision {
                    // The hub now holds the restored text, and the typed save waiting behind this edit would
                    // replace it, so the restored text and the typing are joined and saved together.
                    let typed = self.drafts[key]?.text ?? ""
                    let joined = [restored.text, typed].filter { !$0.isEmpty }.joined(separator: " ")
                    restored.text = String(joined.prefix(Self.draftTextLimit))
                    if !typed.isEmpty {
                        notice = joined.count > Self.draftTextLimit
                            ? "Earlier message restored. Your newer typing did not fit in the draft and its end was cut. Review the draft before sending."
                            : "Earlier message restored; your newer typing was added after it. Review the draft before sending."
                    }
                    self.draftTasks[key]?.cancel()
                    self.draftTasks[key] = nil
                    self.draftRevisions[key, default: 0] += 1
                    self.dirtyDrafts.insert(key)
                    let saved = restored.text
                    self.action(["action": "draft-text", "key": .string(key), "text": .string(saved)]) { [weak self] in
                        guard let self, self.drafts[key]?.text == saved else { return }
                        self.dirtyDrafts.remove(key)
                    }
                } else {
                    self.dirtyDrafts.remove(key)
                }
                self.drafts[key] = restored
                self.submittedAssets.subtract(message.assetIds)
                if case .object(let fields) = message.payload, case .string(let id) = fields["id"] {
                    self.selectedCardID = (fields["kind"] == .string("form") ? "form:" : "decision:") + id
                    self.submittedCards.remove(self.selectedCardID ?? "")
                    if let answers = fields["answers"], self.formAnswers["form:" + id] == answersBefore["form:" + id] {
                        let decoded = try JSONDecoder().decode(
                            [WidgetFormAnswer].self, from: JSONEncoder().encode(answers))
                        self.formAnswers["form:" + id] = Dictionary(
                            uniqueKeysWithValues: decoded.map { ($0.itemId, $0) })
                    }
                }
                self.selectedKey = key
                self.notice = notice
            } catch { self.report(error) }
        }
    }

    public func ledger(_ card: WidgetCard, state: String) {
        guard let selected, let revision = card.revision else { return }
        var fields: [String: WidgetJSON] = [
            "action": "ledger", "id": .string(card.sourceId), "sessionId": .string(selected.target.sessionId),
            "expectedRevision": .number(Double(revision)), "state": .string(state),
        ]
        if state == "drafted" { fields["draft"] = .string(draft.text) }
        action(.object(fields))
    }

    public func destination(_ mode: String) {
        guard let selected else { return }
        if mode == "resume" {
            openDestination?(selected, mode, nil)
            return
        }
        let key = selected.key
        Task {
            do {
                let result = try await call(["action": "handoff", "key": .string(key)])
                guard case .object(let fields) = result, case .string(let file) = fields["path"] else {
                    throw ToolsBridgeError.refused("The handoff returned no file.")
                }
                if mode == "new" {
                    openDestination?(selected, mode, file)
                } else {
                    NSWorkspace.shared.open(URL(fileURLWithPath: file))
                    notice = "Handoff saved. It has not been sent."
                }
            } catch { report(error) }
        }
    }

    /// Screen Recording for the composer's screenshot: true when it may run, otherwise the permission dialog is up.
    var screenCaptureGate: @MainActor (PermissionNeed) async -> Bool = { await PermissionCenter.shared.ensure($0) }
    static let screenRecordingRefused = "macOS refused the screenshot: Screen Recording is off for this app. Turn it on "
        + "in System Settings → Privacy & Security → Screen & System Audio Recording, then try again."

    /// A screen recording for the reply box runs (from the picker until it ends): the video button shows Stop.
    @Published public var recordingVideo = false

    /// The recorder behind the video button: GenesisKit's generic target picker, floating controls and session.
    public private(set) lazy var screenRecorder = ScreenRecorder(bridge: bridge)
    private var screenRecorderActivity: AnyCancellable?

    /// The video button: lets the person pick a window, an app or a display, records it with floating controls next to
    /// it (pause, switch what is recorded, restart, "Stop and paste", stop and discard), and adds the movie to this
    /// session's draft as a video, with the frame review a pasted video gets (Martin, 2026-10-23: "it should let me
    /// pick what i want to record ... a widget somewhere around the recording panel"). A second press stops and pastes.
    public func toggleVideoCapture() {
        if recordingVideo {
            screenRecorder.stopAndUse()
            return
        }
        guard !stopping, !selectedKey.isEmpty else { return }
        let key = selectedKey
        let recorder = screenRecorder
        screenRecorderActivity = recorder.$isActive.removeDuplicates().sink { [weak self] active in
            self?.recordingVideo = active
        }
        recorder.begin(host: ScreenRecordingHost(
            useTitle: "Stop and paste",
            permissionReason: "The video button records the window, app or display you choose and adds the movie to this session's draft.",
            onUse: { [weak self] movie in
                guard let self, !self.stopping else { return }
                try await self.importRecording(movie, to: key)
            },
            onDiscard: { [weak self] in self?.notice = "Recording discarded. Nothing was added to the draft." },
            onError: { [weak self] message in self?.report(ToolsBridgeError.refused(message)) },
            onStart: { [weak self] in self?.collapse() }))
    }

    /// Imports a finished recording into the draft of `key` behind every pending mutation, and removes the recorder's
    /// file once the draft holds its copy. A failed import keeps the file and throws, so the recorder names where it is.
    func importRecording(_ movie: URL, to key: String) async throws {
        importing += 1
        defer { importing -= 1 }
        let previous = mutationTask
        let imported = Task { [weak self] in
            await previous?.value
            guard let self else { throw CancellationError() }
            _ = try await self.call([
                "action": "import", "key": .string(key), "input": .string(movie.path), "type": "video",
            ], timeoutSeconds: 300)
        }
        mutationTask = Task {
            do { try await imported.value } catch { PerfLog.mark("widget.recording import \(error.localizedDescription)") }
        }
        try await imported.value
        removeStaging(movie)
        notice = "The recording is in the draft. Review its frames before you send it."
    }

    /// The panel steps aside for the selection, then reopens with the new attachment in the draft. Escape returns
    /// `{cancelled: true, reason: "user"}`, which is not an error and reopens nothing. A missing Screen Recording grant
    /// (an error whose text starts with `WidgetCaptureError.screenRecordingDenied`) opens the permission dialog.
    public func capture() {
        let key = selectedKey
        let need = PermissionNeed(
            .screenRecording,
            reason: "The camera button takes a screenshot of the area you select and attaches it to this session's draft.",
            grantWorksInNewProcess: true,
            onGranted: { [weak self] in self?.capture() })
        let previous = mutationTask
        mutationTask = Task { [weak self] in
            await previous?.value
            // `stop()` neither cancels the chain nor drops what waits on it: a capture queued before teardown must
            // not collapse the face or open the selection afterwards. The gate can take seconds, so check again.
            guard let self, !self.stopping, !Task.isCancelled else { return }
            // The screenshot runs in a new process, which reads the grant again: the gate asks one first.
            guard await self.screenCaptureGate(need), !self.stopping, !Task.isCancelled else { return }
            let returnEdge = self.expanded
            self.collapse()
            do {
                let result = try await self.call(["action": "capture", "key": .string(key)])
                if case .object(let fields) = result, fields["cancelled"] == .bool(true) { return }
                if let returnEdge, self.expanded == nil { self.open(returnEdge) }
            } catch where WidgetCaptureError.isScreenRecordingDenied(error) {
                // The gate opens the dialog once a new process reads the grant as off. A grant this process still
                // reads as on opens nothing, so the refusal is said here rather than the button doing nothing.
                if await self.screenCaptureGate(need) {
                    self.report(ToolsBridgeError.refused(Self.screenRecordingRefused))
                }
            } catch {
                self.report(error)
            }
        }
    }

    /// The microphone key and a press without a menu: stops the dictation that runs, else starts the preferred mode.
    public func toggleVoice() {
        if voiceActive {
            if let voice {
                voice.finishInput()
            } else {
                // Stop while a voice note's clip path is still coming: no microphone runs yet, and none may start.
                voiceStart += 1
                finishVoice(fileClip: false)
            }
            return
        }
        startVoice(preferredVoiceMode)
    }

    /// Live dictation into the reply box: the words appear while the user talks, with the voice level as waves. In
    /// `.note` mode the audio is kept too and becomes a voice note with this session and decision when it stops.
    public func startVoice(_ mode: WidgetVoiceMode) {
        guard !voiceActive, let prefs = snapshot?.state.preferences, !selectedKey.isEmpty else { return }
        defaults.set(mode.rawValue, forKey: Self.lastVoiceModeKey)
        let card = ownAnswerCard
        let context = WidgetVoiceNoteContext(
            sessionKey: selectedKey, sessionTitle: selected?.title, decisionId: card?.sourceId,
            decisionNumber: card?.number, title: card?.title)
        voiceKey = selectedKey
        voiceFinals = []
        voiceText = ""
        voiceLevel = 0
        voiceActive = true
        voiceMode = mode
        voiceStart += 1
        let start = voiceStart
        var args = [
            "listen", "--provider", prefs.voiceProvider, "--language", prefs.voiceLanguage,
            "--input", "mic", "--json", "--stop-on-stdin",
        ]
        if let account = prefs.voiceAccount, !account.isEmpty { args += ["--account", account] }
        if let model = prefs.voiceModel, !model.isEmpty { args += ["--model", model] }
        let clipSource = mode == .note ? voiceNoteClip : nil
        Task { [weak self] in
            var args = args
            if let clipSource {
                do {
                    let clip = try await clipSource()
                    guard self?.voiceStart == start else { return }
                    args += ["--save-audio", clip]
                    self?.voiceNotePlan = (clip, context)
                } catch {
                    // The words still go into the reply box; only the recording is not kept.
                    self?.report(error)
                }
            }
            guard let self, self.voiceActive, self.voice == nil, self.voiceStart == start else { return }
            do {
                self.voice = try ToolsLineStream(
                    bridge: self.bridge, subcommand: "voice", args: args,
                    onLines: { [weak self] lines in self?.receiveVoice(lines) },
                    onExit: { [weak self] exit in
                        guard let self else { return }
                        // Only a clean exit proves the audio writer closed the clip.
                        self.finishVoice(fileClip: exit.status == 0)
                        if exit.status != 0 && !exit.stopped {
                            self.fail("Dictation stopped unexpectedly. Press the microphone to try again.",
                                      detail: String(exit.stderr.suffix(4000)))
                        }
                    })
            } catch {
                self.voiceActive = false
                self.voiceMode = nil
                self.voiceNotePlan = nil
                self.report(error)
            }
        }
    }

    private func receiveVoice(_ lines: [String]) {
        struct Event: Decodable {
            var kind: String
            var text: String?
            var rms: Double?
            var error: String?
        }
        for line in lines {
            do {
                let event = try JSONDecoder().decode(Event.self, from: Data(line.utf8))
                switch event.kind {
                case "level": voiceLevel = event.rms ?? 0
                case "partial": voiceText = event.text ?? ""
                case "final":
                    if let text = event.text {
                        voiceFinals.append(text)
                        voiceText = ""
                    }
                case "complete":
                    // The listener still flushes the audio after this line; the exit finishes the note.
                    if let text = event.text {
                        voiceFinals = [text]
                        voiceText = ""
                    }
                case "error": error = event.error ?? event.text
                default: break
                }
            } catch { report(error) }
        }
    }

    /// `fileClip` false: the recording may be incomplete, so it is removed instead of filed as a voice note.
    private func finishVoice(fileClip: Bool = true) {
        guard voiceActive else { return }
        voiceActive = false
        voiceMode = nil
        voice = nil
        let text = (voiceFinals + [voiceText]).filter { !$0.isEmpty }.joined(separator: " ")
        if let plan = voiceNotePlan {
            voiceNotePlan = nil
            if fileClip, !text.isEmpty, let fileVoiceNote {
                fileVoiceNote(plan.clip, text, plan.context)
            } else {
                do { try FileManager.default.removeItem(atPath: plan.clip) } catch {
                    PerfLog.mark("widget.voice clip cleanup \(error.localizedDescription)")
                }
            }
        }
        if let key = voiceKey, !text.isEmpty {
            let existing = drafts[key]?.text ?? ""
            drafts[key] = WidgetDraft(
                text: [existing, text].filter { !$0.isEmpty }.joined(separator: " "),
                assetIds: drafts[key]?.assetIds ?? [])
            dirtyDrafts.insert(key)
            // A typed save still waiting out its delay holds the text from before the dictation; it must not
            // land after this one and overwrite the merged draft.
            draftTasks[key]?.cancel()
            draftTasks[key] = nil
            if !stopping {
                let merged = drafts[key]?.text ?? ""
                action(["action": "draft-text", "key": .string(key), "text": .string(merged)]) { [weak self] in
                    guard let self, self.drafts[key]?.text == merged else { return }
                    self.dirtyDrafts.remove(key)
                }
            }
        }
        voiceKey = nil
        voiceText = ""
        voiceLevel = 0
    }

    public func toggleRead() {
        if reading {
            speechTask?.cancel()
            reading = false
            return
        }
        guard let card else { return }
        reading = true
        speechTask = Task { [weak self] in
            guard let self else { return }
            let file = self.journal.appendingPathComponent("speech-" + UUID().uuidString + ".txt")
            defer {
                self.reading = false
                do { try FileManager.default.removeItem(at: file) } catch {
                    PerfLog.mark("widget.read cleanup \(error.localizedDescription)")
                }
            }
            do {
                try (card.title + "\n" + card.body).write(to: file, atomically: true, encoding: .utf8)
                let result = try await self.bridge.run(
                    subcommand: "hub", args: self.widgetArgs + ["readback", "--input", file.path],
                    timeoutSeconds: 600)
                if result.exitCode != 0 { throw ToolsBridgeError.refused(result.stderr) }
            } catch { if !Task.isCancelled { self.report(error) } }
        }
    }

    /// The nearby messages last read for a card, however old: its section shows them at once while a fresh read runs,
    /// instead of "Loading nearby messages…" each time a session opens again.
    public func cachedReceiptContext(for card: WidgetCard) -> WidgetReceiptContext? {
        receiptContextCache[Self.receiptContextKey(card)]?.value
    }

    private static func receiptContextKey(_ card: WidgetCard) -> String {
        card.sessionKey + "|" + card.id + "|" + String(card.at)
    }

    public func receiptContext(for card: WidgetCard) async throws -> WidgetReceiptContext {
        let key = Self.receiptContextKey(card)
        if let cached = receiptContextCache[key], Date().timeIntervalSince(cached.at) < 15 {
            return cached.value
        }
        let result = try await bridge.run(
            subcommand: "hub",
            args: widgetArgs + ["context", card.id, "--key", card.sessionKey, "--json"],
            timeoutSeconds: 8)
        try Task.checkCancellation()
        guard result.exitCode == 0 else { throw ToolsBridgeError.refused(String(result.stderr.suffix(1000))) }
        let value = try JSONDecoder().decode(WidgetReceiptContext.self, from: Data(result.stdout.utf8))
        if receiptContextCache.count >= 48, let oldest = receiptContextCache.min(by: { $0.value.at < $1.value.at }) {
            receiptContextCache.removeValue(forKey: oldest.key)
        }
        receiptContextCache[key] = (Date(), value)
        return value
    }

    private func transcriptQuery(_ session: WidgetSession) -> SessionTranscriptCache.Query {
        SessionTranscriptCache.Query(identity: session.key, query: session.transcriptPath ?? session.target.sessionId,
                                     provider: session.target.provider)
    }

    /// Context size per session key, for the header (`WidgetSessionFacts`). Read from the transcript cache when a
    /// session opens: the conversation itself loads only on the Conversation tab, and the header shows on every tab.
    @Published public private(set) var contextTokens: [String: Int] = [:]
    private var contextTask: Task<Void, Never>?

    private func refreshContext() {
        guard let session = selected, session.target.provider != "unknown" else { return }
        let key = session.key
        let query = transcriptQuery(session)
        contextTask?.cancel()
        contextTask = Task { [weak self] in
            guard let self, let envelope = try? await self.transcriptCache.value(for: query), !Task.isCancelled,
                  let tokens = Self.contextTokens(envelope.turns) else { return }
            if self.contextTokens[key] != tokens { self.contextTokens[key] = tokens }
        }
    }

    /// The context the session's last model call carried: its fresh input plus its cache reads. nil when the turns
    /// have no call with usage (a provider that reports none, or nothing loaded yet).
    nonisolated static func contextTokens(_ turns: [TranscriptTurn]) -> Int? {
        guard let usage = turns.last(where: { $0.role == "assistant" && $0.usage != nil })?.usage else { return nil }
        let total = (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0)
        return total > 0 ? total : nil
    }

    private func prewarmTranscript(on surface: WidgetSurfaceID? = nil) {
        let module = surface.map { moduleSelections[$0.key] ?? "agents" } ?? activeModuleID
        let hovered = surface.flatMap { surface in
            hoveredSession?.surface == surface
                ? snapshot?.sessions.first { $0.key == hoveredSession?.key } : nil
        }
        guard module == "agents", let session = hovered ?? selected, session.target.provider != "unknown" else { return }
        transcriptCache.prefetch(transcriptQuery(session))
    }

    private func resumeTranscript() {
        let wanted = expanded != nil && activeModuleID == "agents" && section == "Conversation" ? selected : nil
        let identity = wanted.map { $0.key + "|" + ($0.transcriptPath ?? $0.target.sessionId) }
        guard followedTranscript != identity else { return }
        followedTranscript = identity
        tail?.stop()
        tail = nil
        transcriptTask?.cancel()
        transcript = []
        transcriptError = nil
        transcriptLoading = false
        guard let session = wanted else { return }
        guard session.target.provider != "unknown" else {
            transcriptError =
                "This source has no live transcript. Its questions, answers and attachments remain in this timeline."
            return
        }
        let key = session.key
        transcriptLoading = true
        transcriptTask = Task { [weak self] in
            guard let self else { return }
            defer {
                if self.followedTranscript == identity { self.transcriptLoading = false }
            }
            do {
                let envelope = try await self.transcriptCache.value(for: self.transcriptQuery(session))
                guard !Task.isCancelled, self.selectedKey == key, self.expanded != nil else { return }
                self.transcript = envelope.turns
                self.tail = TranscriptLiveTail(
                    query: envelope.filePath, offset: envelope.liveFollowOffset,
                    provider: envelope.provider, bridge: self.bridge,
                    onBatch: { [weak self] batch in
                        guard let self, self.selectedKey == key else { return }
                        for turn in batch.turns {
                            if let index = self.transcript.firstIndex(where: { $0.id == turn.id }) {
                                self.transcript[index] = turn
                            } else {
                                self.transcript.append(turn)
                            }
                        }
                        self.transcript = Array(self.transcript.suffix(60))
                    })
            } catch { if !Task.isCancelled { self.transcriptError = error.localizedDescription } }
        }
    }

    private func scheduleQuietReduction() {
        let signature =
            "\(hasActivity)|\(expanded?.rawValue ?? "")|\(activeModuleID)|\(selectedKey)|\(draft.text)|\(draft.assetIds)|\(voiceActive)|\(dialogOpen)"
        guard signature != quietSignature else { return }
        quietSignature = signature
        quietTask?.cancel()
        guard expanded != nil, activeModuleID == "agents", !hasActivity, draft.text.isEmpty, draft.assetIds.isEmpty,
            !voiceActive,
            !dialogOpen
        else { return }
        let delay = max(5, snapshot?.state.preferences.quietSeconds ?? 15)
        quietTask = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(delay)) } catch { return }
            guard let self else { return }
            // A pointer over the panel, or a decision waiting in it, is someone reading: the quiet timer folded a
            // session with open decisions under the reader's pointer (Martin, 2026-10-25). It tries again later.
            // `pointerInside` and not `hoveredSurface`: opening a module clears the hover, not the pointer.
            let waiting = self.inboxOverview ? self.inbox.needsAnswer > 0 : self.cards.contains(where: \.needsAnswer)
            if !self.pointerInside.isEmpty || waiting {
                PerfLog.mark("widget.quiet-collapse skipped: "
                    + (!self.pointerInside.isEmpty ? "pointer over the panel" : "a decision waits"))
                self.quietSignature = ""
                return
            }
            PerfLog.mark("widget.quiet-collapse after \(delay)s quiet in \(self.selectedKey)")
            // With staged decisions this asks first and the panel stays open (Martin, 2026-10-23).
            self.requestCollapse()
        }
    }

    private func removeStaging(_ file: URL) {
        do { try FileManager.default.removeItem(at: file) } catch {
            PerfLog.mark("widget.paste cleanup \(error.localizedDescription)")
        }
    }

    func report(_ error: Error) {
        self.error = error.localizedDescription
        PerfLog.mark("widget.error \(error.localizedDescription)")
    }
}

/// Presentation-only projection. Snapshot updates refresh it; body and geometry reads reuse it.
struct WidgetSessionRoster {
    private var source: [WidgetSession] = []
    private(set) var visible: [WidgetSession] = []
    private(set) var rail: [WidgetSession] = []
    private var railOrder = StickyOrder<String>()
    private(set) var preview: [WidgetSession] = []
    private(set) var waiting = 0
    private(set) var active = 0

    @discardableResult
    mutating func update(_ sessions: [WidgetSession]) -> Bool {
        guard sessions != source else { return false }
        source = sessions
        visible = sessions.filter(\.visible)
        let byKey = Dictionary(visible.map { ($0.key, $0) }, uniquingKeysWith: { first, _ in first })
        let ids = railOrder.update(visible.map {
            .init(id: $0.key, active: $0.status == "working" || $0.status == "waiting",
                  lastAt: Date(timeIntervalSince1970: $0.activityAt / 1000))
        }, hold: true)
        rail = ids.compactMap { byKey[$0] }
        let rank = ["waiting": 0, "working": 1, "finished": 2, "recent": 3]
        preview = Array(visible.sorted {
            let lhs = rank[$0.status] ?? 4
            let rhs = rank[$1.status] ?? 4
            return lhs == rhs ? $0.activityAt > $1.activityAt : lhs < rhs
        }.prefix(4))
        waiting = visible.reduce(0) { $0 + ($1.status == "waiting" ? 1 : 0) }
        active = visible.reduce(0) { count, session in
            count + (session.parentKey == nil && session.agentId == nil
                && (session.status == "working" || session.status == "waiting") ? 1 : 0)
        }
        return true
    }
}

/// Decodes watch lines on its own queue, in order. A line equal to the previous one is the same snapshot and is
/// dropped before decoding, so an unchanged hub costs neither a decode nor a SwiftUI update.
final class WidgetSnapshotDecoder: @unchecked Sendable {
    private let queue = DispatchQueue(label: "genesis.widget.snapshot-decode", qos: .userInitiated)
    /// Confined to `queue`.
    private var last: String?
    /// The watch stream the lines belong to; main actor only. `reset()` starts a new one, and results an older stream
    /// queued before it are dropped, so a restarted watch never applies a snapshot of the stopped one.
    @MainActor private var generation = 0

    @MainActor func reset() {
        generation &+= 1
        queue.async { self.last = nil }
    }

    @MainActor func decode(_ lines: [String], deliver: @escaping @MainActor ([Result<WidgetSnapshot, Error>]) -> Void) {
        let stream = generation
        queue.async {
            var results: [Result<WidgetSnapshot, Error>] = []
            for line in lines where line != self.last {
                self.last = line
                let started = CACurrentMediaTime()
                results.append(Result { try JSONDecoder().decode(WidgetSnapshot.self, from: Data(line.utf8)) })
                let elapsed = (CACurrentMediaTime() - started) * 1000
                if elapsed >= 16 {
                    PerfLog.mark(String(format: "widget.snapshot decode off-main bytes=%d ms=%.1f", line.utf8.count, elapsed))
                }
            }
            guard !results.isEmpty else { return }
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    guard self.generation == stream else { return }
                    deliver(results)
                }
            }
        }
    }
}

/// The reply box microphone's two live modes. The raw values are the `composerVoice` setting's.
public enum WidgetVoiceMode: String, Sendable {
    /// Words into the reply box only.
    case dictate = "live"
    /// Words into the reply box, and the audio kept as a voice note with its session and decision.
    case note
}

/// A key the user pressed in the widget's list on screen (Up, Down, Return). `serial` makes two presses of the same
/// key two changes, so a view can react to each.
public struct WidgetListKey: Equatable, Sendable {
    public enum Kind: Equatable, Sendable { case up, down, open }
    public let kind: Kind
    public let serial: Int
}

/// Which session's cmux popover a row's accessibility action asked for, and in which list.
public struct WidgetCmuxRequest: Equatable, Sendable {
    public let key: String
    public let scope: String?
}

/// The option of a decision card that the arrow keys chose (`WidgetModel.choiceFocus`).
public struct WidgetChoiceFocus: Equatable, Sendable {
    public let cardID: String
    public let choiceID: String
}
