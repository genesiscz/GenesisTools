// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground/Genesis/apps/Genesis/Sources/Genesis/Flow/FlowSession.swift at 2026-10-08T05:04:08+02:00 at commit hash 7bd89a24c79510fb90ab0c2a0701c1d085f2023e
import AppKit
import Combine
import Foundation
import SwiftUI

/// The dictation loop.
///
/// One turn: hotkey down → capture the focus target → start the recogniser →
/// hotkey up → trailing grace → finalise → dictionary + snippets → inject →
/// record. Nothing here talks to eve; Flow is a voice *keyboard*, not the
/// companion's voice *assistant*.
@MainActor
public final class FlowSession: ObservableObject {

    public static let shared = FlowSession()

    // MARK: - Published state

    @Published public private(set) var phase: FlowPhase = .idle {
        didSet {
            guard phase != oldValue else { return }
            syncPill()
        }
    }
    @Published public private(set) var lastError: String?
    /// Set for a few seconds after a turn so the pill can confirm what landed.
    @Published public private(set) var lastInjected: String?
    /// Settings → Labs → Dictation (`app.labs.dictation`, default on). Off =
    /// no hotkey, and the menu bar and palette entries hide.
    @Published public private(set) var labEnabled = true
    /// Whether the dictation chord is live; the menu item shows it.
    @Published public private(set) var hotkeyStatus: GlobalHotkeyStatus = .off

    @Published public var config: FlowConfig {
        didSet {
            guard config != oldValue else { return }   // @Published has no value-skip
            guard !applyingRemoteState else { return }
            if let remoteCommand {
                do {
                    let before = try JSONSerialization.jsonObject(with: JSONEncoder().encode(oldValue)) as? [String: Any] ?? [:]
                    let after = try JSONSerialization.jsonObject(with: JSONEncoder().encode(config)) as? [String: Any] ?? [:]
                    let patch = after.filter { key, value in
                        !NSDictionary(dictionary: [key: value]).isEqual(to: [key: before[key] ?? NSNull()])
                    }
                    remoteCommand("flow.config", try JSONSerialization.data(withJSONObject: patch))
                } catch { reportFailure(error.localizedDescription) }
                return
            }
            do {
                try store.persistConfig(config)
                applyHotkeyBinding()
                applyPreRoll()
            } catch {
                applyingRemoteState = true
                config = oldValue
                applyingRemoteState = false
                reportFailure(error.localizedDescription)
            }
        }
    }

    @Published public private(set) var history: [FlowEntry] = []
    @Published public private(set) var stats: FlowStats = FlowStats()
    @Published public private(set) var suggestions: [FlowSuggestion] = []
    @Published public var dictionary: [FlowDictionaryRule] = []
    @Published public var snippets: [FlowSnippet] = []
    @Published public var transforms: [FlowTransform] = []

    /// The recogniser is exposed so the pill can observe `partialText` and
    /// `micLevel` directly. Those change at speech rate; routing them through
    /// this object would invalidate every Flow view on each audio buffer.
    public let recognizer = CompanionSpeechRecognizer()

    // MARK: - Private

    private var store: FlowStore
    private var started = false
    private var applyingRemoteState = false
    var remoteCommand: ((String, Data) -> Void)?
    var configuration = FlowFocusConfiguration.shared
    private var hotKey: CompanionHotKey?
    private var startedAt: Date?
    private var target: FlowFocusTarget?
    /// Lowercase tokens the user dismissed, so the learner stops proposing them.
    private var dismissedTokens: Set<String> = []
    private var wordStats: [String: FlowDictionary.WordStats] = [:]
    private var finishTask: Task<Void, Never>?
    private var pillHideTask: Task<Void, Never>?
    private let preRoll = FlowPreRoll()

    /// Built lazily on first use so an app launch that never dictates pays
    /// nothing for it.
    private lazy var pill: FlowPillWindowController = {
        FlowPillWindowController { [weak self] in
            guard let self else { return AnyView(EmptyView()) }
            return AnyView(FlowPillView(session: self, recognizer: self.recognizer))
        }
    }()

    public init(store: FlowStore? = nil) {
        let store = store ?? .shared
        self.store = store
        let loaded = store.loadConfig()
        let migrated = loaded.migratingLegacyChord()
        if migrated != loaded {
            // Property observers do not run in init, so save here.
            store.saveConfig(migrated)
            FlowFocusLog.flow.info("dictation chord moved off ⌃⌥D (Magnet/Rectangle own it) to \(FlowKeyNames.describe(keyCode: migrated.keyCode, modifiers: migrated.modifiers))")
        }
        config = migrated
        history = store.loadHistory()
        stats = store.loadStats()
        dictionary = store.loadDictionary()
        snippets = store.loadSnippets()
        transforms = store.loadTransforms()
        suggestions = store.loadSuggestions()
    }

    // MARK: - Lifecycle

    /// Register the global hotkey. Safe to call more than once.
    public func start() {
        guard store.writesEnabled, remoteCommand == nil else { return }
        started = true
        labEnabled = configuration.dictationEnabled
        activate()
    }

    private func activate() {
        guard isOn else {
            FlowFocusLog.flow.info("dictation off (labs: \(self.labEnabled), enabled: \(self.config.enabled))")
            return
        }
        applyHotkeyBinding()
        if config.showPill { pill.prewarm() }
        recognizer.preRollProvider = { [weak self] in self?.preRoll.drain() ?? [] }
        applyPreRoll()
    }

    /// Labs switch. Off drops the hotkey and any turn in flight.
    public func setLabEnabled(_ on: Bool) {
        if forward("flow.lab", on) { return }
        guard labEnabled != on else { return }
        labEnabled = on
        FlowFocusLog.flow.info("dictation lab \(on ? "on" : "off")")
        if on {
            activate()
        } else {
            cancelTurn()
            applyHotkeyBinding()
            applyPreRoll()
        }
    }

    /// Both switches: Labs and Flow's own "Enabled".
    private var isOn: Bool { labEnabled && config.enabled }

    /// Why dictation cannot start, or nil when both switches are on. The one sentence the panel's
    /// hotkey hint and a refused turn both show.
    public nonisolated static func offReason(labEnabled: Bool, enabled: Bool) -> String? {
        if !labEnabled {
            return "Dictation is off in Settings → Labs."
        }

        if !enabled {
            return "Dictation is off in Dictation → Settings."
        }

        return nil
    }

    public enum TurnStart: Equatable {
        case begin
        /// A turn is already in progress; the press changes nothing.
        case busy
        /// A switch is off: say why instead of opening the microphone.
        case off(String)
    }

    /// Whether a press may start a turn. Pure, so the tests hold every entry point to it.
    public nonisolated static func turnStart(phase: FlowPhase, labEnabled: Bool, enabled: Bool) -> TurnStart {
        guard phase == .idle || phase == .error else { return .busy }
        if let reason = offReason(labEnabled: labEnabled, enabled: enabled) {
            return .off(reason)
        }

        return .begin
    }

    /// Menu bar / palette: start a turn, or end the one in progress. Works
    /// without the chord, so dictation stays reachable when it is taken.
    public func toggleFromMenu() {
        guard labEnabled else { return }
        if phase == .listening {
            endTurn()
        } else {
            beginTurn()
        }
    }

    /// Start or stop the rolling capture to match the setting.
    private func applyPreRoll() {
        guard started, remoteCommand == nil, isOn, config.preRoll else {
            preRoll.stop()
            return
        }
        preRoll.start()
    }

    /// Show/hide the pill to match the phase.
    ///
    /// The pill lingers briefly after a turn so the user sees the confirmation
    /// rather than a panel that vanishes the instant the text lands.
    private func syncPill() {
        guard started, remoteCommand == nil, config.showPill else { return }
        pillHideTask?.cancel()
        pillHideTask = nil

        switch phase {
        case .listening, .transcribing, .injecting:
            pill.show()
        case .error:
            pill.show()
            pillHideTask = Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: 2_600_000_000)
                guard !Task.isCancelled else { return }
                self?.pill.hide()
            }
        case .idle:
            pillHideTask = Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: 700_000_000)
                guard !Task.isCancelled else { return }
                self?.pill.hide()
            }
        }
    }

    public func stop() {
        started = false
        remoteCommand = nil
        preRoll.stop()
        pillHideTask?.cancel()
        pillHideTask = nil
        pill.hide()
        hotKey?.stop()
        hotKey = nil
        hotkeyStatus = .off
        cancelTurn()
    }

    private func applyHotkeyBinding() {
        guard started, remoteCommand == nil, isOn else {
            hotKey?.stop()
            hotKey = nil
            hotkeyStatus = .off
            return
        }

        let chord = FlowKeyNames.describe(keyCode: config.keyCode, modifiers: config.modifiers)
        if let hotKey {
            let ok = hotKey.rebind(keyCode: config.keyCode, modifiers: config.modifiers)
            hotkeyStatus = ok ? .registered(chord: chord) : .unavailable(chord: chord)
            if !ok {
                FlowFocusLog.flow.error("dictation hotkey \(chord) rebind refused by Carbon")
            }
            return
        }

        let key = CompanionHotKey(
            keyCode: config.keyCode,
            modifiers: config.modifiers,
            signature: CompanionHotKey.flowSignature,
            hotKeyId: 1
        )
        key.onKeyDown = { [weak self] _ in
            Task { @MainActor in self?.handleKeyDown() }
        }
        key.onKeyUp = { [weak self] _ in
            Task { @MainActor in self?.handleKeyUp() }
        }
        // Carbon's status (e.g. -9878 eventHotKeyExistsErr) is logged by
        // CompanionHotKey. A chord another APP holds still registers here.
        if key.start() {
            hotKey = key
            hotkeyStatus = .registered(chord: chord)
            FlowFocusLog.flow.info("dictation hotkey \(chord) registered keyCode=\(self.config.keyCode) modifiers=\(self.config.modifiers)")
        } else {
            hotkeyStatus = .unavailable(chord: chord)
            lastError = "Could not register the dictation hotkey \(chord). Start dictation from the menu bar instead."
            FlowFocusLog.flow.error("dictation hotkey \(chord) registration refused by Carbon")
        }
    }

    // MARK: - Hotkey handling

    private func handleKeyDown() {
        switch config.activation {
        case .pushToTalk:
            beginTurn()
        case .toggle:
            if phase == .listening { endTurn() } else { beginTurn() }
        }
    }

    private func handleKeyUp() {
        guard config.activation == .pushToTalk else { return }
        endTurn()
    }

    // MARK: - Turn

    /// Start capturing. The focus target is grabbed FIRST, before any Flow UI
    /// can appear — see `FlowFocusTarget` for why that ordering is the whole
    /// trick.
    public func beginTurn(target capturedTarget: FlowFocusTarget? = nil, captureCurrentTarget: Bool = true) {
        if let remoteCommand {
            let destination = captureCurrentTarget ? FlowFocusTarget.capture() : capturedTarget
            do { remoteCommand("flow.begin", try JSONEncoder().encode(destination)) }
            catch { reportFailure(error.localizedDescription) }
            return
        }
        guard started, store.writesEnabled else {
            reportFailure("Flow is waiting for its active owner.")
            return
        }
        switch Self.turnStart(phase: phase, labEnabled: labEnabled, enabled: config.enabled) {
        case .busy:
            return
        case .off(let reason):
            // The hotkey is bound only while dictation is on, but the menu bar, the palette and the
            // panel reach this too; none of them may open the microphone past a switch that is off.
            lastError = reason
            phase = .error
            FlowFocusLog.flow.info("turn refused: \(reason)")
            return
        case .begin:
            break
        }

        finishTask?.cancel()
        finishTask = nil

        target = captureCurrentTarget ? FlowFocusTarget.capture() : capturedTarget
        startedAt = Date()
        lastError = nil
        lastInjected = nil

        // Release the device before the recogniser claims it. The ring survives
        // `stop()`, so the history is still handed over — two engines fighting
        // over one input node would buy nothing.
        preRoll.stop()

        do {
            let locale = config.localeIdentifier.isEmpty
                ? Locale.current
                : Locale(identifier: config.localeIdentifier)
            try recognizer.start(locale: locale, forceServer: config.forceServerRecognition)
            phase = .listening
            FlowFocusLog.flow.info("turn begin target=\(self.target?.bundleIdentifier ?? "none")")
        } catch {
            phase = .error
            lastError = error.localizedDescription
            FlowFocusLog.flow.error("turn begin failed: \(error.localizedDescription)")
        }
    }

    /// Stop capturing and run the rest of the pipeline.
    public func endTurn() {
        if forward("flow.end") { return }
        guard phase == .listening else { return }
        phase = .transcribing

        let grace = max(0, config.trailingGraceMs)
        finishTask = Task { @MainActor [weak self] in
            guard let self else { return }
            // Trailing grace: releasing the key cuts the audio mid-syllable
            // otherwise. BridgeVoice keeps a `RELEASE_TAIL_PENDING` flag for
            // exactly this.
            if grace > 0 {
                try? await Task.sleep(nanoseconds: UInt64(grace) * 1_000_000)
            }
            guard !Task.isCancelled else { return }
            let raw = await self.recognizer.finish()
            guard !Task.isCancelled else { return }
            await self.completeTurn(raw: raw)
        }
    }

    /// Abandon the turn without injecting anything.
    public func cancelTurn() {
        if forward("flow.cancel") { return }
        finishTask?.cancel()
        finishTask = nil
        recognizer.cancel()
        phase = .idle
        target = nil
        startedAt = nil
    }

    private func completeTurn(raw: String) async {
        let duration = startedAt.map { Date().timeIntervalSince($0) } ?? 0
        startedAt = nil

        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            phase = .idle
            target = nil
            FlowFocusLog.flow.info("turn produced no text")
            return
        }

        // Rewrite: dictionary first (fixes what the recogniser misheard), then
        // snippets (expands what the user asked for). Doing it the other way
        // round would let a dictionary rule chew up an expanded snippet body.
        var text = FlowDictionary.apply(dictionary, to: trimmed)
        text = FlowDictionary.expand(snippets, in: text)

        phase = .injecting
        let outcome = FlowInjector.inject(
            text,
            into: target,
            usePaste: config.injectViaPaste,
            restoreClipboard: config.restoreClipboard
        )

        switch outcome {
        case .notPermitted:
            lastError = "Text copied — grant Accessibility to paste automatically."
        case .targetLost:
            lastError = "The target app closed — text copied to the clipboard."
        case .copiedOnly:
            lastError = nil
        case .injected, .empty:
            lastError = nil
        }

        record(
            raw: trimmed,
            final: text,
            duration: duration,
            injected: outcome == .injected
        )

        lastInjected = text
        target = nil
        phase = .idle
        applyPreRoll()   // reclaim the mic for the next turn's history
        FlowFocusLog.flow.info("turn done words=\(text.split(separator: " ").count) outcome=\(String(describing: outcome))")
    }

    var liveSnapshot: FlowLiveSnapshot {
        FlowLiveSnapshot(phase: phase, lastError: lastError, lastInjected: lastInjected,
                         labEnabled: labEnabled, hotkeyStatus: hotkeyStatus,
                         partialText: recognizer.partialText, micLevel: recognizer.micLevel)
    }

    func applyRemote(_ snapshot: FlowLiveSnapshot) {
        guard remoteCommand != nil else { return }
        if phase != snapshot.phase { phase = snapshot.phase }
        if lastError != snapshot.lastError { lastError = snapshot.lastError }
        if lastInjected != snapshot.lastInjected { lastInjected = snapshot.lastInjected }
        if labEnabled != snapshot.labEnabled { labEnabled = snapshot.labEnabled }
        if hotkeyStatus != snapshot.hotkeyStatus { hotkeyStatus = snapshot.hotkeyStatus }
        recognizer.applyRemote(partialText: snapshot.partialText, micLevel: snapshot.micLevel)
    }

    func persistConfiguration(_ value: FlowConfig) throws {
        try store.persistConfig(value)
        applyingRemoteState = true
        config = value
        applyingRemoteState = false
        applyHotkeyBinding()
        applyPreRoll()
    }

    func configure(store: FlowStore) {
        self.store = store
        reloadStoredState()
        store.onFailure = { [weak self] message in
            self?.reloadStoredState(preserveConfiguration: true)
            self?.reportFailure(message)
        }
    }

    func reloadStoredState(preserveConfiguration: Bool = false) {
        applyingRemoteState = true
        defer { applyingRemoteState = false }
        if !preserveConfiguration {
            let next = store.loadConfig().migratingLegacyChord()
            if config != next { config = next }
        }
        let entries = store.loadHistory()
        if history != entries { history = entries }
        let nextStats = store.loadStats()
        if stats != nextStats { stats = nextStats }
        let rules = store.loadDictionary()
        if dictionary != rules { dictionary = rules }
        let nextSnippets = store.loadSnippets()
        if snippets != nextSnippets { snippets = nextSnippets }
        let nextTransforms = store.loadTransforms()
        if transforms != nextTransforms { transforms = nextTransforms }
        let nextSuggestions = store.loadSuggestions()
        if suggestions != nextSuggestions { suggestions = nextSuggestions }
    }

    func reportFailure(_ message: String) {
        lastError = message
    }

    private func forward<T: Encodable>(_ action: String, _ payload: T) -> Bool {
        guard let remoteCommand else { return false }
        do { remoteCommand(action, try JSONEncoder().encode(payload)) }
        catch { reportFailure(error.localizedDescription) }
        return true
    }

    private func forward(_ action: String) -> Bool {
        guard let remoteCommand else { return false }
        remoteCommand(action, Data())
        return true
    }

    // MARK: - Persistence

    private func record(raw: String, final: String, duration: Double, injected: Bool) {
        let words = final.split(whereSeparator: { $0.isWhitespace || $0.isNewline }).count
        let entry = FlowEntry(
            text: final,
            rawText: raw,
            targetBundleId: target?.bundleIdentifier,
            targetAppName: target?.localizedName,
            durationSeconds: duration,
            injected: injected,
            wordCount: words
        )

        history.insert(entry, at: 0)
        if history.count > config.historyLimit {
            history.removeLast(history.count - config.historyLimit)
        }
        store.saveHistory(history)
        FlowEvents.publish(entry)

        stats.totalWords += words
        stats.totalSeconds += duration
        stats.sessionCount += 1
        stats.dayStreak = Self.streak(endingAt: entry.createdAt, previous: stats.lastDictationAt, current: stats.dayStreak)
        stats.lastDictationAt = entry.createdAt
        store.saveStats(stats)

        guard config.dictionaryLearning else { return }
        let raised = FlowDictionary.learn(
            from: raw,
            stats: &wordStats,
            existingRules: dictionary,
            dismissed: dismissedTokens
        )
        guard !raised.isEmpty else { return }
        for suggestion in raised where !suggestions.contains(where: { $0.heard == suggestion.heard }) {
            suggestions.append(suggestion)
        }
        store.saveSuggestions(suggestions)
    }

    /// Consecutive-day counter.
    ///
    /// Same day → unchanged. Next day → +1. Any bigger gap → back to 1.
    public nonisolated static func streak(endingAt now: Date, previous: Date?, current: Int) -> Int {
        guard let previous else { return 1 }
        let calendar = Calendar.current
        if calendar.isDate(now, inSameDayAs: previous) { return max(current, 1) }
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: previous), to: calendar.startOfDay(for: now)).day ?? 0
        return days == 1 ? current + 1 : 1
    }

    // MARK: - Mutations from the UI

    public func addRule(from: String, to: String) {
        if forward("flow.rule.add", [from, to]) { return }
        let rule = FlowDictionaryRule(from: from, to: to)
        dictionary.append(rule)
        store.saveDictionary(dictionary)
    }

    public func removeRule(_ id: UUID) {
        if forward("flow.rule.remove", id) { return }
        dictionary.removeAll { $0.id == id }
        store.saveDictionary(dictionary)
    }

    public func acceptSuggestion(_ suggestion: FlowSuggestion, replacement: String) {
        if forward("flow.suggestion.accept", FlowSuggestionAcceptance(suggestion: suggestion, replacement: replacement)) { return }
        dictionary.append(
            FlowDictionaryRule(from: suggestion.heard, to: replacement, learned: true)
        )
        suggestions.removeAll { $0.id == suggestion.id }
        store.saveDictionary(dictionary)
        store.saveSuggestions(suggestions)
    }

    public func dismissSuggestion(_ suggestion: FlowSuggestion) {
        if forward("flow.suggestion.dismiss", suggestion) { return }
        dismissedTokens.insert(suggestion.heard.lowercased())
        suggestions.removeAll { $0.id == suggestion.id }
        store.saveSuggestions(suggestions)
    }

    public func addSnippet(trigger: String, body: String) {
        if forward("flow.snippet.add", [trigger, body]) { return }
        snippets.append(FlowSnippet(trigger: trigger, body: body))
        store.saveSnippets(snippets)
    }

    public func removeSnippet(_ id: UUID) {
        if forward("flow.snippet.remove", id) { return }
        snippets.removeAll { $0.id == id }
        store.saveSnippets(snippets)
    }

    public func deleteEntry(_ id: UUID) {
        if forward("flow.history.delete", id) { return }
        history.removeAll { $0.id == id }
        store.saveHistory(history)
    }

    public func clearHistory() {
        if forward("flow.history.clear") { return }
        history.removeAll()
        store.saveHistory(history)
    }

    public func copyEntry(_ entry: FlowEntry) {
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setString(entry.text, forType: .string)
    }
}
