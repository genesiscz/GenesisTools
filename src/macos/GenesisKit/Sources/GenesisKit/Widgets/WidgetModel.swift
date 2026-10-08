import AppKit
import Combine
import SwiftUI
import UniformTypeIdentifiers

@MainActor
public final class WidgetModel: ObservableObject {
    @Published public private(set) var snapshot: WidgetSnapshot?
    @Published public var selectedKey = ""
    @Published public var selectedCardID: String? { didSet { presentationChanged?() } }
    @Published public var section = "Inbox" { didSet { presentationChanged?() } }
    @Published public var expanded: EdgePanelPlacement?
    @Published public var activeSideGroup = 0
    @Published public var hoveredSurface: WidgetSurfaceID?
    @Published public var moduleSelections: [String: String] = [:]
    @Published public var draggedSidePosition: Double?
    @Published public var draggingSide = false
    public var sideClusterHeight: CGFloat = 300
    private var followedTranscript: String?
    private var hoverTask: Task<Void, Never>?
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
    public var presentationChanged: (() -> Void)?
    public var showSettings: (() -> Void)?
    public var showMedia: ((WidgetMediaSelection) -> Void)?
    public var openHub: ((WidgetSession?) -> Void)?
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
    private let stateRoot: String?
    private let journal: URL
    private var watcher: ToolsLineStream?
    private var voice: ToolsLineStream?
    private var tail: TranscriptLiveTail?
    private var transcriptTask: Task<Void, Never>?
    private var speechTask: Task<Void, Never>?
    private var mutationTask: Task<Void, Never>?
    private var preferenceTask: Task<Void, Never>?
    private var pendingPreferences: [String: WidgetJSON] = [:]
    private var draftTasks: [String: Task<Void, Never>] = [:]
    private var dirtyDrafts: Set<String> = []
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
        appearance: NativeSettingsAppearance? = nil
    ) {
        self.defaults = defaults
        self.appearance = appearance ?? .shared
        bridge = ToolsBridge(binaryPath: binaryPath)
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

    public var sessions: [WidgetSession] { snapshot?.sessions.filter(\.visible) ?? [] }
    public var previewSessions: [WidgetSession] {
        let rank = ["waiting": 0, "working": 1, "finished": 2, "recent": 3]
        return Array(
            sessions.sorted {
                let lhs = rank[$0.status] ?? 4
                let rhs = rank[$1.status] ?? 4
                return lhs == rhs ? $0.activityAt > $1.activityAt : lhs < rhs
            }.prefix(4))
    }
    public var previewHeight: CGFloat { previewSessions.isEmpty ? 180 : 100 + CGFloat(previewSessions.count) * 54 }

    public var selected: WidgetSession? {
        snapshot?.sessions.first { $0.key == selectedKey }
            ?? (lastSelected?.key == selectedKey ? lastSelected : nil)
    }
    public var cards: [WidgetCard] { snapshot?.cards.filter { $0.sessionKey == selectedKey } ?? [] }
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

    public func startSettings() {
        settingsOnly = true
        do {
            try FileManager.default.createDirectory(at: journal, withIntermediateDirectories: true)
            refreshSettings()
        } catch { report(error) }
    }

    public func refreshSettings() {
        settingsTask?.cancel()
        settingsTask = Task { [weak self] in
            guard let self else { return }
            do {
                let result = try await self.bridge.run(
                    subcommand: "hub", args: self.widgetArgs + ["snapshot", "--json"], timeoutSeconds: 30)
                guard result.exitCode == 0 else { throw ToolsBridgeError.refused(result.stderr) }
                guard !Task.isCancelled else { return }
                self.receive([result.stdout])
            } catch {
                if !Task.isCancelled { self.report(error) }
            }
        }
    }

    public func start() {
        guard watcher == nil else { return }
        stopping = false
        connectionLost = false
        do {
            try FileManager.default.createDirectory(at: journal, withIntermediateDirectories: true)
            watcher = try ToolsLineStream(
                bridge: bridge, subcommand: "hub", args: widgetArgs + ["watch", "--stop-on-stdin"],
                onLines: { [weak self] lines in self?.receive(lines) },
                onExit: { [weak self] exit in
                    guard let self, !self.stopping, !exit.stopped else { return }
                    self.watcher = nil
                    self.connectionLost = true
                    self.error = "Widget connection stopped. " + exit.stderr.suffix(600)
                })
            drainJournal()
        } catch { report(error) }
    }

    public func stop() {
        preferenceTask?.cancel()
        flushPreferences()
        settingsTask?.cancel()
        followedTranscript = nil
        stopping = true
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
        speechTask?.cancel()
        quietTask?.cancel()
        for task in draftTasks.values { task.cancel() }
        for key in dirtyDrafts {
            if let draft = drafts[key] {
                defaults.set(draft.text, forKey: "widget.recovered-draft." + key)
            }
        }
    }

    private func receive(_ lines: [String]) {
        for line in lines {
            do {
                var next = try JSONDecoder().decode(WidgetSnapshot.self, from: Data(line.utf8))
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
                if let session = next.sessions.first(where: { $0.key == selectedKey }) {
                    lastSelected = session
                }
                if selectedKey.isEmpty {
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
                scheduleQuietReduction()
                presentationChanged?()
            } catch { report(error) }
        }
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

    public func hover(_ surface: WidgetSurfaceID, inside: Bool) {
        guard layout.hoverPreviews, !dialogOpen, !draggingSide else { return }
        hoverTask?.cancel()
        if inside {
            guard presentation(for: surface) != .expanded else { return }
            hoverTask = Task { [weak self] in
                do { try await Task.sleep(for: .milliseconds(160)) } catch { return }
                guard let self, !self.dialogOpen else { return }
                self.hoveredSurface = surface
                self.presentationChanged?()
            }
        } else {
            hoverTask = Task { [weak self] in
                do { try await Task.sleep(for: .milliseconds(220)) } catch { return }
                guard let self, self.hoveredSurface == surface else { return }
                self.hoveredSurface = nil
                self.presentationChanged?()
            }
        }
    }

    public func moveSide(position: Double, finished: Bool) {
        let bounded = min(1, max(0, position))
        draggedSidePosition = bounded
        draggingSide = !finished
        hoveredSurface = nil
        hoverTask?.cancel()
        presentationChanged?()
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
        openedAt = ProcessInfo.processInfo.systemUptime
        expanded = edge
        resumeTranscript()
        presentationChanged?()
        scheduleQuietReduction()
        if let card, card.kind == "answer", !card.read {
            action(["action": "read", "id": .string(card.sourceId)])
        }
    }

    public func collapse() {
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
        quietTask?.cancel()
        presentationChanged?()
    }

    public func select(_ key: String, edge: EdgePanelPlacement? = nil) {
        selectedKey = key
        lastSelected = snapshot?.sessions.first { $0.key == key }
        selectedCardID = nil
        action(["action": "selection", "key": .string(key)])
        if let edge { open(edge) }
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
        value.text = String(text.prefix(64_000))
        drafts[key] = value
        dirtyDrafts.insert(key)
        draftTasks[key]?.cancel()
        let captured = value.text
        draftTasks[key] = Task { [weak self] in
            do { try await Task.sleep(for: .milliseconds(350)) } catch { return }
            guard let self else { return }
            self.action(["action": "draft-text", "key": .string(key), "text": .string(captured)]) {
                [weak self] in
                guard let self, self.drafts[key]?.text == captured else { return }
                self.dirtyDrafts.remove(key)
            }
        }
        scheduleQuietReduction()
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
        func acknowledge() {
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
        let previous = mutationTask
        mutationTask = Task { [weak self] in
            await previous?.value
            guard let self else { return }
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
        guard !selectedKey.isEmpty else {
            if ownsFile { removeStaging(url) }
            return
        }
        let key = selectedKey
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
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.image, .movie, .video]
        panel.allowsMultipleSelection = true
        dialogOpen = true
        panel.begin { [weak self] response in
            guard let self else { return }
            self.dialogOpen = false
            if response == .OK { panel.urls.forEach { self.importFile($0) } }
        }
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
        if draftTasks[key] != nil {
            draftTasks[key]?.cancel()
            draftTasks[key] = nil
            action(["action": "draft-text", "key": .string(key), "text": .string(drafts[key]?.text ?? "")])
        }
        let previous = mutationTask
        mutationTask = Task { [weak self] in
            await previous?.value
            guard let self else { return }
            do {
                _ = try await self.call(["action": "edit", "id": .string(message.id)])
                var restored = WidgetDraft(assetIds: message.assetIds)
                if case .object(let fields) = message.payload, case .string(let text) = fields["text"] {
                    restored.text = text
                }
                self.drafts[key] = restored
                self.dirtyDrafts.remove(key)
                self.submittedAssets.subtract(message.assetIds)
                if case .object(let fields) = message.payload, case .string(let id) = fields["id"] {
                    self.selectedCardID = (fields["kind"] == .string("form") ? "form:" : "decision:") + id
                    self.submittedCards.remove(self.selectedCardID ?? "")
                    if let answers = fields["answers"] {
                        let decoded = try JSONDecoder().decode(
                            [WidgetFormAnswer].self, from: JSONEncoder().encode(answers))
                        self.formAnswers["form:" + id] = Dictionary(
                            uniqueKeysWithValues: decoded.map { ($0.itemId, $0) })
                    }
                }
                self.selectedKey = key
                self.notice = "Message restored as a draft."
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

    public func capture() {
        collapse()
        action(["action": "capture", "key": .string(selectedKey)])
    }

    public func toggleVoice() {
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

    private func resumeTranscript() {
        let wanted = expanded != nil && activeModuleID == "agents" ? selected : nil
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
                let result = try await self.bridge.run(
                    subcommand: "ai",
                    args: SessionTranscriptClient.arguments(
                        sessionId: session.transcriptPath ?? session.target.sessionId, limit: 30)
                        + ["--provider", session.target.provider], timeoutSeconds: 30)
                guard result.exitCode == 0 else { throw ToolsBridgeError.refused(result.stderr) }
                let envelope = try SessionTranscriptClient.decode(Data(result.stdout.utf8))
                guard !Task.isCancelled, self.selectedKey == key, self.expanded != nil else { return }
                self.transcript = envelope.turns
                self.tail = TranscriptLiveTail(
                    query: envelope.filePath, offset: envelope.nextOffset,
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
