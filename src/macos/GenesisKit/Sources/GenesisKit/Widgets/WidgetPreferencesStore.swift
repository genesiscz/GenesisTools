import Foundation

/// The widget's preference writes, in one place. A write names fields (`write { $0.inboxFilter = "all" }`): the store
/// applies the change to a copy of the preferences on screen, encodes both, and sends only the keys that differ, so a
/// misspelled key cannot compile. It shows a write at once, sends it after a short pause merged with the writes that
/// follow, and keeps it shown over every snapshot read before the hub stored it. `WidgetModel` hands it each snapshot's
/// preferences (`received`) and puts on screen what it returns.
@MainActor
public final class WidgetPreferencesStore {
    /// What the store needs from the model that shows the preferences.
    struct Wiring {
        /// The preferences on screen now; nil before the first snapshot.
        var shown: () -> WidgetPreferences?
        /// Puts preferences on screen. `whole`: the snapshot is published again as a whole (a write of this process,
        /// a fence that cleared); otherwise only what the preferences decide is computed again.
        var show: (_ preferences: WidgetPreferences, _ whole: Bool) -> Void
        /// Sends one patch to `hub widget` (`{"action": "preferences", "patch": …}`).
        var send: (_ patch: [String: WidgetJSON], _ failed: @escaping () -> Void, _ completed: @escaping () -> Void) -> Void
        /// Reads the stored settings again (the settings face's `refreshSettings`).
        var readAgain: () -> Void
        var report: (Error) -> Void
        var stopping: () -> Bool
    }

    /// A snapshot whose preferences did not decode; reported once until a good one arrives.
    struct Unreadable: LocalizedError {
        let detail: String
        var errorDescription: String? { "The widget settings in the hub's answer could not be read: \(detail)" }
    }

    private let wiring: Wiring
    /// `state.json`, whose revision fences a saved write (`storedRevision`).
    private let stateFile: String

    /// Bumped when a write starts and when it lands. A settings snapshot read across either holds the preferences from
    /// before the write; applied, it undid the optimistic change, and the next toggle built its patch on that stale
    /// layout, so two quick module toggles lost one (settings V2 pass, 2026-10-10).
    private(set) var writeEpoch = 0
    private(set) var writesInFlight = 0
    /// A settings read came back stale while a write was in flight; the last write to land reads again.
    private var readAfterWrites = false
    private var writeTask: Task<Void, Never>?
    private var pending: [String: WidgetJSON] = [:]
    /// The generation of the newest change to each pending key, and the generation last handed to the hub. A patch is
    /// sent for the keys changed since their last send, and its acknowledgement retires a key only when no newer change
    /// came meanwhile, whatever value that change has (a toggle off and on again equals the value in flight).
    private var generation = 0
    private var generations: [String: Int] = [:]
    private var sent: [String: Int] = [:]
    /// What the callers of `write` asked to hear about the write that carries their change.
    private var pendingOutcomes: [(saved: () -> Void, failed: () -> Void)] = []
    /// Saved patches, still shown over every snapshot until one read at or after their write arrives (`fence`:
    /// state.json's revision once the write landed; nil while that is read). The watch builds a snapshot from state it
    /// read earlier, so one read before the write can arrive after it; applied bare, it undid the saved preference.
    private var saved: [(id: UUID, fence: Int?, patch: [String: WidgetJSON])] = []
    /// Patches another process (the settings window) changed a moment ago, shown at once until its write has had time
    /// to reach a snapshot (`liveSeconds`), so a setting applies while it is changed (Martin, 2026-10-28: "all settings
    /// which affect the ui should be realtime").
    private var live: [(at: Date, patch: [String: WidgetJSON])] = []
    nonisolated static let liveSeconds: TimeInterval = 8
    /// `liveSeconds`, shorter in tests.
    var liveWindow: TimeInterval = WidgetPreferencesStore.liveSeconds
    private var liveExpiry: Task<Void, Never>?
    /// Live notes not yet applied, merged (`showLive`).
    private var liveApplyPending: [String: WidgetJSON] = [:]
    private var liveAppliedAt = Date.distantPast
    private var liveApplyTask: Task<Void, Never>?
    /// The shortest time between two live applies: 30 per second keeps a slider smooth.
    var liveApplyInterval: TimeInterval = 1.0 / 30
    /// The last snapshot's preferences as they arrived, before any overlay, and its revision.
    private var received: (preferences: WidgetPreferences, revision: Int)?
    private var unreadableReported = false
    /// Called with each patch once the hub has stored it.
    var onSaved: (([String: WidgetJSON]) -> Void)?

    init(stateFile: String, wiring: Wiring) {
        self.stateFile = stateFile
        self.wiring = wiring
    }

    // MARK: - Reading

    /// The preferences to show for a snapshot's `state`: its own, or the last good ones when they did not decode, with
    /// the saved, pending and live writes on top.
    func received(_ state: WidgetState) throws -> WidgetPreferences {
        var preferences = state.preferences
        if let detail = state.preferencesUnreadable {
            if let last = received { preferences = last.preferences }
            PerfLog.mark("widget.preferences unreadable in a snapshot, showing the last good ones: \(detail)")
            if !unreadableReported {
                unreadableReported = true
                wiring.report(Unreadable(detail: detail))
            }
            // The last good ones are not what this snapshot stored: its revision confirms no saved write, so the
            // saved patches stay shown and `received` keeps the revision of the last snapshot that decoded.
            return try overlaid(preferences)
        }

        unreadableReported = false
        received = (preferences, state.revision)
        saved.removeAll { entry in entry.fence.map { state.revision >= $0 } ?? false }
        return try overlaid(preferences)
    }

    // MARK: - Writing

    /// Changes fields of the preferences on screen: shown at once, sent after a short pause with the changes that
    /// follow. Only the keys whose encoded value changed are sent; a change that changes nothing sends nothing and
    /// counts as saved. `saved` or `failed` runs when the write that carries it ends, so a page confirms only what was
    /// stored.
    public func write(
        _ change: (inout WidgetPreferences) -> Void, saved: (() -> Void)? = nil, failed: (() -> Void)? = nil
    ) {
        let patch = self.patch(change)
        guard !patch.isEmpty else {
            saved?()
            return
        }
        update(patch, saved: saved, failed: failed)
    }

    /// The patch `change` makes to the preferences on screen (the hub's defaults before the first snapshot), for a
    /// caller that sends it on its own path.
    public func patch(_ change: (inout WidgetPreferences) -> Void) -> [String: WidgetJSON] {
        let base = wiring.shown() ?? .hubDefaults
        var next = base
        change(&next)
        do {
            return try Self.changes(from: base, to: next)
        } catch {
            wiring.report(error)
            return [:]
        }
    }

    /// A patch by key, for a request that arrives as JSON (`WidgetModel.action` with a preferences request). Code that
    /// knows the field writes it with `write`.
    func update(_ patch: [String: WidgetJSON], saved: (() -> Void)? = nil, failed: (() -> Void)? = nil) {
        pending.merge(patch) { _, new in new }
        generation += 1
        for key in patch.keys { generations[key] = generation }
        WidgetLiveSettings.postPreferences(patch)
        if saved != nil || failed != nil {
            pendingOutcomes.append((saved ?? {}, failed ?? {}))
        }
        if let current = wiring.shown() {
            do { wiring.show(try Self.merging(patch, into: current), true) } catch { wiring.report(error) }
        }
        writeTask?.cancel()
        writeTask = Task { [weak self] in
            do { try await Task.sleep(for: .milliseconds(180)) } catch { return }
            self?.flush()
        }
    }

    /// Sends the pending writes now.
    func flush() {
        // Only the keys changed since their last send: one still in flight is not sent again.
        let patch = pending.filter { sent[$0.key] != generations[$0.key] }
        guard !patch.isEmpty else { return }
        let stamp = generations.filter { patch[$0.key] != nil }
        for (key, value) in stamp { sent[key] = value }
        let outcomes = pendingOutcomes
        pendingOutcomes = []
        writeEpoch += 1
        writesInFlight += 1
        /// True when it started the settings read a stale one put off.
        @discardableResult func acknowledge() -> Bool {
            writeEpoch += 1
            writesInFlight -= 1
            for (key, value) in stamp where generations[key] == value {
                pending.removeValue(forKey: key)
                generations.removeValue(forKey: key)
                sent.removeValue(forKey: key)
            }
            guard writesInFlight == 0, readAfterWrites, !wiring.stopping() else { return false }
            readAfterWrites = false
            wiring.readAgain()
            return true
        }
        wiring.send(
            patch,
            { [weak self] in
                let reread = acknowledge()
                outcomes.forEach { $0.failed() }
                if !reread { self?.wiring.readAgain() }
            },
            { [weak self] in
                self?.holdSaved(patch)
                acknowledge()
                outcomes.forEach { $0.saved() }
                self?.onSaved?(patch)
            })
    }

    /// A settings read came back stale while a write was in flight: the last write to land reads again.
    func readAgainAfterWrites() {
        readAfterWrites = true
    }

    /// Ends the pause and sends what is pending; nothing is read again afterwards.
    func stop() {
        writeTask?.cancel()
        flush()
        readAfterWrites = false
    }

    // MARK: - Live settings of another process

    /// A preference another process changed (the settings window posts each change): shown at once, written by that
    /// process. Nothing is written here.
    func showLive(_ patch: [String: WidgetJSON]) {
        guard !patch.isEmpty, wiring.shown() != nil else { return }
        live.append((Date(), patch))
        // A slider posts up to 60 notes a second, and each new snapshot rebuilds the inbox and re-renders the panels
        // (about 8 ms of main thread per note, measured 2026-10-28). Notes are merged and applied at most once per
        // `liveApplyInterval`, the first at once and the last always.
        liveApplyPending.merge(patch) { _, new in new }
        let wait = liveApplyInterval - Date().timeIntervalSince(liveAppliedAt)
        if wait <= 0 {
            applyLive()
        } else if liveApplyTask == nil {
            liveApplyTask = Task { [weak self] in
                do { try await Task.sleep(for: .seconds(wait)) } catch { return }
                self?.liveApplyTask = nil
                self?.applyLive()
            }
        }
        scheduleLiveExpiry()
    }

    private func scheduleLiveExpiry() {
        guard liveExpiry == nil, let earliest = live.first?.at else { return }
        let delay = max(0, earliest.addingTimeInterval(liveWindow).timeIntervalSinceNow) + 0.1
        liveExpiry = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(delay)) } catch { return }
            guard let self else { return }
            self.liveExpiry = nil
            self.dropExpiredLive()
            self.scheduleLiveExpiry()
        }
    }

    private func applyLive() {
        let patch = liveApplyPending
        liveApplyPending = [:]
        liveAppliedAt = Date()
        guard !patch.isEmpty, let current = wiring.shown() else { return }
        // The same value again (a slider held still, a repeated note) publishes nothing.
        do { wiring.show(try Self.merging(patch, into: current), false) } catch { wiring.report(error) }
    }

    private func dropExpiredLive() {
        guard let last = received else { return }
        do { wiring.show(try overlaid(last.preferences), false) } catch { wiring.report(error) }
    }

    // MARK: - Overlay

    /// `preferences` with the saved patches not yet seen in a snapshot, then the ones still to be written, on top.
    private func overlaid(_ preferences: WidgetPreferences) throws -> WidgetPreferences {
        var patch: [String: WidgetJSON] = [:]
        let now = Date()
        live.removeAll { now.timeIntervalSince($0.at) > liveWindow }
        for entry in live { patch.merge(entry.patch) { _, new in new } }
        for entry in saved { patch.merge(entry.patch) { _, new in new } }
        patch.merge(pending) { _, new in new }
        return try Self.merging(patch, into: preferences)
    }

    /// A write landed: its patch stays shown until a snapshot read at or after the revision it stored arrives.
    private func holdSaved(_ patch: [String: WidgetJSON]) {
        let id = UUID()
        saved.append((id, nil, patch))
        let file = stateFile
        Task { [weak self] in
            let revision = await Task.detached(priority: .utility) { Self.storedRevision(file) }.value
            self?.fenceSaved(id, at: revision)
        }
    }

    private func fenceSaved(_ id: UUID, at revision: Int?) {
        guard let index = saved.firstIndex(where: { $0.id == id }) else { return }
        guard let revision else {
            // Unreadable: the patch is dropped as before, rather than shown over every later snapshot.
            saved.remove(at: index)
            return
        }

        saved[index].fence = revision
        // The snapshot on screen may already be that new; then it shows what is stored now.
        guard let last = received, last.revision >= revision, wiring.shown() != nil else { return }
        saved.remove(at: index)
        do { wiring.show(try overlaid(last.preferences), true) } catch { wiring.report(error) }
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

    // MARK: - Encoding

    nonisolated static func merging(
        _ patch: [String: WidgetJSON], into preferences: WidgetPreferences
    ) throws -> WidgetPreferences {
        guard !patch.isEmpty else { return preferences }
        guard case .object(var fields) = try WidgetJSON.value(preferences) else { return preferences }
        fields.merge(patch) { _, new in new }
        return try JSONDecoder().decode(WidgetPreferences.self, from: JSONEncoder().encode(WidgetJSON.object(fields)))
    }

    /// The keys whose encoded value differs between `old` and `new`, with the new value; a key `new` no longer has
    /// (an optional set to nil) is sent as null, which the hub's patch schema takes for those keys.
    nonisolated static func changes(from old: WidgetPreferences, to new: WidgetPreferences) throws -> [String: WidgetJSON] {
        guard case .object(let before) = try WidgetJSON.value(old), case .object(let after) = try WidgetJSON.value(new)
        else { return [:] }
        var patch: [String: WidgetJSON] = [:]
        for key in Set(before.keys).union(after.keys) where before[key] != after[key] {
            patch[key] = after[key] ?? .null
        }
        return patch
    }
}
