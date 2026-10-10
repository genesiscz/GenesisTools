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
    public var railSessions: [WidgetSession] { sessionRoster.rail }
    /// Rail sessions that are working or hold unread items. Stored, because every layout pass of every edge panel reads
    /// it: filtering ~1000 sessions there cost a quarter of the main thread while panels animated.
    public private(set) var railActivitySessions: [WidgetSession] = []
    @Published public private(set) var inbox = WidgetInboxSummary.empty
    @Published public private(set) var inboxPulse = 0
    private var inboxSessions: [String: WidgetInboxSession] = [:]
    private var inboxObserved = false
    private var inboxStartedAt = 0.0
    private var inboxSessionPulses: [String: Int] = [:]
    private var inboxWatermarks: [String: (at: Double, id: String)] = [:]
    private var openingInbox: WidgetInboxItem?
    private var inboxReadRequests: Set<String> = []
    @Published public var selectedKey = ""
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
    @Published public var error: String?
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
    @Published public var dialogOpen = false
    private var mediaPicker: NSOpenPanel?
    public var presentationChanged: (() -> Void)?
    /// The pointer entered or left an edge panel, before any hover delay.
    public var pointerChanged: ((WidgetSurfaceID, Bool) -> Void)?
    public var showSettings: (() -> Void)?
    public var showMedia: ((WidgetMediaSelection) -> Void)?
    public var openHub: ((WidgetSession?) -> Void)?
    public var recordVoiceNote: ((String) -> Void)?
    public var voiceActionLabel: String {
        voiceActive ? "Stop dictation" : (recordVoiceNote == nil ? "Dictate" : "Record voice note")
    }
    public var openDestination: ((WidgetSession, String, String?) -> Void)?
    /// Called with each preference patch once the hub has stored it.
    public var preferencesSaved: (([String: WidgetJSON]) -> Void)?
    @Published public var notice: String?
    public private(set) var openedAt: TimeInterval = 0
    public let bridge: ToolsBridge
    public let appearance: NativeSettingsAppearance
    private let defaults: UserDefaults
    private var appearanceSubscription: AnyCancellable?
    private var settingsOnly = false
    private var settingsTask: Task<Void, Never>?
    private var settingsRefreshAgain = false
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
    private var draftTasks: [String: Task<Void, Never>] = [:]
    private var dirtyDrafts: Set<String> = []
    private var draftRevisions: [String: Int] = [:]
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
            } catch { PerfLog.mark("widget.form draft restore \(error.localizedDescription)") }
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
    public var previewHeight: CGFloat {
        if let previewFitHeight { return previewFitHeight }
        return sessionRoster.preview.isEmpty ? 180 : 112 + CGFloat(sessionRoster.preview.count) * 56
    }

    /// Whole points and a 2 pt hysteresis, as `reportAgentFit`, so the measurement cannot chase its own resize.
    func reportPreviewFit(_ height: CGFloat) {
        let rounded = ceil(height)
        if let current = previewFitHeight, abs(rounded - current) < 2 { return }
        previewFitHeight = rounded
        presentationChanged?()
    }

    public var selected: WidgetSession? {
        sessionIndex[selectedKey] ?? (lastSelected?.key == selectedKey ? lastSelected : nil)
    }

    /// Whole points, and only a change of 2 pt or more, so a measurement cannot chase its own resize.
    func reportAgentFit(_ height: CGFloat?) {
        let rounded = height.map { ceil($0) }
        if let rounded, let current = agentFitHeight, abs(rounded - current) < 2 { return }
        guard rounded != agentFitHeight else { return }
        agentFitHeight = rounded
        presentationChanged?()
    }
    public var cards: [WidgetCard] { snapshot?.cards.filter { $0.sessionKey == selectedKey } ?? [] }
    public var inboxLoading: Bool {
        !selectedKey.isEmpty && snapshot?.selectedKey != selectedKey && cards.isEmpty && error == nil
    }
    public var card: WidgetCard? {
        cards.first { $0.id == selectedCardID } ?? cards.last(where: \.needsAnswer) ?? cards.last
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
                    self.settingsRefreshAgain = true
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
                    self.error = "Widget connection stopped. " + exit.stderr.suffix(600)
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
        preferenceTask?.cancel()
        flushPreferences()
        settingsTask?.cancel()
        settingsTask = nil
        settingsRefreshAgain = false
        settingsWatcher?.stop()
        settingsWatcher = nil
        followedTranscript = nil
        stopping = true
        cancelHoverPrewarm()
        mediaPicker?.cancel(nil)
        mediaPicker = nil
        dialogOpen = false
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
            var next = decoded
            next.state.preferences = try mergingPreferences(pendingPreferences, into: next.state.preferences)
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
        moduleSelections[surface.key] = moduleID
        defaults.set(moduleSelections, forKey: "widget.moduleSelections")
        activeSideGroup = surface.group
        hoveredSurface = nil
        hoverTask?.cancel()
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

    public func hover(_ surface: WidgetSurfaceID, inside: Bool) {
        pointerChanged?(surface, inside)
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
        presentationChanged?()
        scheduleQuietReduction()
        if openingInbox == nil, let card, card.kind == "answer", !card.read {
            action(["action": "read", "id": .string(card.sourceId)])
        }
    }

    func updateInbox(_ value: WidgetInboxSummary) {
        var arrived = false
        var arrivedKeys: Set<String> = []
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
                    if isArrival { arrived = true; arrivedKeys.insert(entry.key) }
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
        railActivitySessions = railSessions.filter { session in
            let inbox = inboxSessions[session.key]
            return session.visualStatus == .working || (inbox?.unread ?? 0) + (inbox?.needsAnswer ?? 0) > 0
        }
    }

    public func inboxFor(_ key: String) -> WidgetInboxSession? { inboxSessions[key] }
    public func inboxPulseFor(_ key: String) -> Int { inboxSessionPulses[key] ?? 0 }
    public var inboxCount: Int { max(0, inbox.unread) + max(0, inbox.needsAnswer) }

    /// Expands one inbox card in place. An unread answer or result counts as read once the user opens it, the same
    /// way opening it from a notification does.
    public func openCard(_ card: WidgetCard) {
        selectedCardID = card.id
        guard !stopping, !card.read, ["answer", "result"].contains(card.kind) else { return }
        let token = card.sessionKey + "|" + card.id + "|" + String(card.at)
        guard inboxReadRequests.insert(token).inserted else { return }
        action(["action": "inbox-read", "key": .string(card.sessionKey), "id": .string(card.id),
                "kind": .string(card.kind), "at": .number(card.at)], failed: { [weak self] in
            self?.inboxReadRequests.remove(token)
        })
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

    public func collapse() {
        cancelHoverPrewarm()
        openingInbox = nil
        followedTranscript = nil
        hoveredSurface = nil
        hoverTask?.cancel()
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
        if openingInbox?.key != key { openingInbox = nil }
        selectedKey = key
        lastSelected = snapshot?.sessions.first { $0.key == key }
        selectedCardID = nil
        action(["action": "selection", "key": .string(key)])
        if let edge { open(edge) }
        if expanded != nil || hoveredSurface != nil { prewarmTranscript(on: expanded == nil ? hoveredSurface : nil) }
        resumeTranscript()
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

    public func setText(_ text: String) {
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

    private func mergingPreferences(
        _ patch: [String: WidgetJSON], into preferences: WidgetPreferences
    ) throws -> WidgetPreferences {
        guard case .object(var fields) = try WidgetJSON.value(preferences) else { return preferences }
        fields.merge(patch) { _, new in new }
        return try JSONDecoder().decode(WidgetPreferences.self, from: JSONEncoder().encode(WidgetJSON.object(fields)))
    }

    public func updatePreferences(_ patch: [String: WidgetJSON]) {
        pendingPreferences.merge(patch) { _, new in new }
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
        preferenceWriteEpoch += 1
        preferenceWritesInFlight += 1
        func acknowledge() {
            preferenceWriteEpoch += 1
            preferenceWritesInFlight -= 1
            for (key, value) in patch where pendingPreferences[key] == value {
                pendingPreferences.removeValue(forKey: key)
            }
        }
        action(
            ["action": "preferences", "patch": .object(patch)],
            failed: { [weak self] in
                acknowledge()
                self?.refreshSettings()
            },
            completed: { [weak self] in
                acknowledge()
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

    @discardableResult
    private func call(_ value: WidgetJSON) async throws -> WidgetJSON {
        if let actionRunner { return try await actionRunner(value) }
        let file = journal.appendingPathComponent("action-" + UUID().uuidString + ".tmp")
        try JSONEncoder().encode(value).write(to: file, options: .atomic)
        defer {
            do { try FileManager.default.removeItem(at: file) } catch {
                PerfLog.mark("widget.action cleanup \(error.localizedDescription)")
            }
        }
        return try await runAction(file)
    }

    private func runAction(_ file: URL) async throws -> WidgetJSON {
        let result = try await bridge.run(
            subcommand: "hub", args: widgetArgs + ["call", "--input", file.path], timeoutSeconds: 120)
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

    public func submit(choice: String? = nil, answering: Bool = false) {
        guard let session = selected, importing == 0 else { return }
        let submitted = draft
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
            draftTasks[selectedKey]?.cancel()
            dirtyDrafts.insert(selectedKey)
            drafts[selectedKey] = WidgetDraft()
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
                let newerTyping = self.draftRevisions[key, default: 0] != revision
                if !newerTyping {
                    var restored = WidgetDraft(assetIds: message.assetIds)
                    if case .object(let fields) = message.payload, case .string(let text) = fields["text"] {
                        restored.text = text
                    }
                    self.drafts[key] = restored
                    self.dirtyDrafts.remove(key)
                }
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
                self.notice = newerTyping
                    ? "Earlier message restored; your newer typing was kept. Review the draft before sending."
                    : "Message restored as a draft."
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
            guard let self else { return }
            // The screenshot runs in a new process, which reads the grant again: the gate asks one first.
            guard await self.screenCaptureGate(need) else { return }
            let returnEdge = self.expanded
            self.collapse()
            do {
                let result = try await self.call(["action": "capture", "key": .string(key)])
                if case .object(let fields) = result, fields["cancelled"] == .bool(true) { return }
                if let returnEdge, self.expanded == nil { self.open(returnEdge) }
            } catch where WidgetCaptureError.isScreenRecordingDenied(error) {
                PermissionCenter.shared.require(need)
            } catch {
                self.report(error)
            }
        }
    }

    public func toggleVoice() {
        if let recordVoiceNote {
            guard !selectedKey.isEmpty else { return }
            recordVoiceNote(selectedKey)
            return
        }
        if voiceActive {
            voice?.finishInput()
            return
        }
        guard let prefs = snapshot?.state.preferences, !selectedKey.isEmpty else { return }
        voiceKey = selectedKey
        voiceFinals = []
        voiceText = ""
        voiceActive = true
        var args = [
            "listen", "--provider", prefs.voiceProvider, "--language", prefs.voiceLanguage,
            "--input", "mic", "--json", "--stop-on-stdin",
        ]
        if let account = prefs.voiceAccount, !account.isEmpty { args += ["--account", account] }
        if let model = prefs.voiceModel, !model.isEmpty { args += ["--model", model] }
        do {
            voice = try ToolsLineStream(
                bridge: bridge, subcommand: "voice", args: args,
                onLines: { [weak self] lines in self?.receiveVoice(lines) },
                onExit: { [weak self] exit in
                    guard let self else { return }
                    self.finishVoice()
                    if exit.status != 0 && !exit.stopped { self.error = String(exit.stderr.suffix(600)) }
                })
        } catch {
            voiceActive = false
            report(error)
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
                    if let text = event.text {
                        voiceFinals = [text]
                        voiceText = ""
                    }
                    finishVoice()
                case "error": error = event.error ?? event.text
                default: break
                }
            } catch { report(error) }
        }
    }

    private func finishVoice() {
        guard voiceActive else { return }
        voiceActive = false
        voice = nil
        let text = (voiceFinals + [voiceText]).filter { !$0.isEmpty }.joined(separator: " ")
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

    public func receiptContext(for card: WidgetCard) async throws -> WidgetReceiptContext {
        let key = card.sessionKey + "|" + card.id + "|" + String(card.at)
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
        if receiptContextCache.count >= 12, let oldest = receiptContextCache.min(by: { $0.value.at < $1.value.at }) {
            receiptContextCache.removeValue(forKey: oldest.key)
        }
        receiptContextCache[key] = (Date(), value)
        return value
    }

    private func transcriptQuery(_ session: WidgetSession) -> SessionTranscriptCache.Query {
        SessionTranscriptCache.Query(identity: session.key, query: session.transcriptPath ?? session.target.sessionId,
                                     provider: session.target.provider)
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
            self?.collapse()
        }
    }

    private func removeStaging(_ file: URL) {
        do { try FileManager.default.removeItem(at: file) } catch {
            PerfLog.mark("widget.paste cleanup \(error.localizedDescription)")
        }
    }

    private func report(_ error: Error) {
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

    func reset() {
        queue.async { self.last = nil }
    }

    func decode(_ lines: [String], deliver: @escaping @MainActor ([Result<WidgetSnapshot, Error>]) -> Void) {
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
                MainActor.assumeIsolated { deliver(results) }
            }
        }
    }
}
