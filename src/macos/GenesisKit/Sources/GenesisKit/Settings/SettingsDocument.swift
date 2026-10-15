import Combine
import Foundation
import SwiftUI

/// One feature's settings as a Codable value, kept in a `KitSettingsBackend` under one key. A change applies in
/// memory on the main actor at once; the save waits `debounce` after the last change and then runs off the main
/// actor, so a slider drag or a burst of toggles costs one write and the UI never waits for a lock or the disk.
///
/// - The first load starts in `init` and runs off the main actor. Until it lands `state` is `.loading`, and an
///   edit made meanwhile is replayed on top of the stored value once it arrives.
/// - A stored value that cannot be read or decoded puts the document in `.unreadable`: edits stay in memory and
///   nothing is saved, so the original bytes survive until the user repairs them or `overwriteUnreadableValue()`
///   replaces them on purpose.
/// - A change made outside (another process, the CLI) is read back after the backend reports it. A pending local
///   edit wins: the read waits until that edit is saved, and a read whose value equals the current one publishes
///   nothing.
/// - A failed save (a full disk, a lock held past its timeout) keeps the edit pending: it is retried after 5, 15,
///   30, 60 and 60 s, then on the next edit or `flush()`, and a queued external read waits for it.
/// - Call `flush()` when a window closes, and at quit: `applicationWillTerminate` cannot await, so return
///   `.terminateLater` from `applicationShouldTerminate`, await `flush()` with a bounded wait (5 s), then call
///   `NSApp.reply(toApplicationShouldTerminate: true)`.
/// - The value is stored as a whole. A build that does not know a field drops it on its next save, so two builds
///   writing the same key (an installed app and a worktree build) remove each other's newer fields.
@MainActor
public final class SettingsDocument<Value: Codable & Equatable & Sendable>: ObservableObject {
    public enum State: Equatable, Sendable {
        case loading
        case ready
        /// The stored value could not be read or decoded; the text says why. Nothing is saved in this state.
        case unreadable(String)
    }

    @Published public private(set) var value: Value
    @Published public private(set) var state: State = .loading
    /// The last load or save failure; nil after the next success.
    @Published public private(set) var lastError: String?

    public let key: String
    public let defaultValue: Value
    private let backend: KitSettingsBackend
    private let debounce: Duration
    private var observation: SettingsObservation?
    private var loadTask: Task<Void, Never>?
    private var debounceTask: Task<Void, Never>?
    private var lastSave: Task<Void, Never>?
    private var preloadChanges: [(inout Value) -> Void] = []
    /// A change not yet handed to the backend.
    private var dirty = false
    private var savesInFlight = 0
    /// Failed saves in a row; the automatic retries stop after `retryDelays`.
    private var failedSaves = 0
    private static var retryDelays: [Duration] { [.seconds(5), .seconds(15), .seconds(30), .seconds(60), .seconds(60)] }
    private var loadInFlight = false
    private var reloadWanted = false
    /// What the backend holds as far as this document knows; nil when nothing is stored.
    private var lastStored: Value?

    public init(key: String, backend: KitSettingsBackend, defaultValue: Value,
                debounce: Duration = .milliseconds(400), observesExternalChanges: Bool = true) {
        self.key = key
        self.backend = backend
        self.defaultValue = defaultValue
        self.debounce = debounce
        self.value = defaultValue
        loadTask = Task { [weak self] in await self?.performLoad() }
        if observesExternalChanges {
            observation = backend.observeChanges(forKey: key) { [weak self] in
                Task { @MainActor [weak self] in self?.externalChange() }
            }
        }
    }

    /// True while an edit has not reached the backend yet.
    public var hasPendingChanges: Bool { dirty || savesInFlight > 0 }

    /// Waits for the first load (started in `init`).
    public func load() async {
        await loadTask?.value
    }

    /// Changes the value now and saves it after the debounce.
    public func update(_ change: @escaping (inout Value) -> Void) {
        var next = value
        change(&next)
        if state == .loading { preloadChanges.append(change) }
        guard next != value else { return }
        value = next
        scheduleSave()
    }

    /// Replaces the whole value now and saves it after the debounce.
    public func set(_ newValue: Value) {
        update { $0 = newValue }
    }

    /// A binding to one field, for a settings control.
    public func binding<Field>(_ keyPath: WritableKeyPath<Value, Field>) -> Binding<Field> {
        Binding(get: { self.value[keyPath: keyPath] },
                set: { newValue in self.update { $0[keyPath: keyPath] = newValue } })
    }

    /// Saves a debounced edit now and waits for every save made before this call. Returns false when the document
    /// is unreadable or a save failed (`lastError` says why).
    @discardableResult
    public func flush() async -> Bool {
        await loadTask?.value
        saveNow()
        await lastSave?.value
        return state == .ready && lastError == nil && !dirty
    }

    /// Reads the stored value again. A pending edit is saved first.
    public func reload() async {
        await loadTask?.value
        if hasPendingChanges {
            saveNow()
            await lastSave?.value
        }
        await performLoad()
    }

    /// Leaves `.unreadable` and saves the current in-memory value over the stored one. Call it only when the user
    /// chose to replace what could not be read. It replaces an undecodable value under this key; when the backend's
    /// whole store is unreadable (a malformed `client.json`), the save fails with the same error and `lastError`
    /// says so: the file needs a repair first.
    public func overwriteUnreadableValue() {
        guard case .unreadable = state else { return }
        state = .ready
        dirty = true
        lastStored = nil
        saveNow()
    }

    // MARK: - Load

    private func performLoad() async {
        loadInFlight = true
        let backend = self.backend
        let key = self.key
        let result: Result<Value?, Error> = await Task.detached(priority: .utility) {
            do {
                guard let data = try await backend.loadData(forKey: key) else { return .success(nil) }
                return .success(try JSONDecoder().decode(Value.self, from: data))
            } catch {
                return .failure(error)
            }
        }.value
        loadInFlight = false
        apply(result)
        if reloadWanted, !hasPendingChanges {
            reloadWanted = false
            Task { [weak self] in await self?.performLoad() }
        }
    }

    private func apply(_ result: Result<Value?, Error>) {
        switch result {
        case .success(let stored):
            if state == .ready, hasPendingChanges {
                // An edit made while this read ran is newer; read again once it is saved.
                reloadWanted = true
                return
            }
            if case .unreadable = state {
                // Edits made while the stored value was unreadable were made on top of the defaults; the
                // repaired value replaces them.
                dirty = false
            }
            lastStored = stored
            var next = stored ?? defaultValue
            let replayed = !preloadChanges.isEmpty
            for change in preloadChanges { change(&next) }
            preloadChanges = []
            if value != next { value = next }
            if state != .ready { state = .ready }
            if lastError != nil { lastError = nil }
            if replayed, next != stored { scheduleSave() }
        case .failure(let error):
            preloadChanges = []
            let reason = Self.describe(error)
            if state == .ready, hasPendingChanges {
                reloadWanted = true
                return
            }
            let unreadable = State.unreadable(reason)
            if state != unreadable { state = unreadable }
            if lastError != reason { lastError = reason }
        }
    }

    private func externalChange() {
        guard !loadInFlight, state != .loading, !(state == .ready && hasPendingChanges) else {
            reloadWanted = true
            return
        }
        Task { [weak self] in await self?.performLoad() }
    }

    // MARK: - Save

    private func scheduleSave(after delay: Duration? = nil) {
        dirty = true
        debounceTask?.cancel()
        let delay = delay ?? debounce
        debounceTask = Task { [weak self] in
            do { try await Task.sleep(for: delay) } catch { return }
            self?.saveNow()
        }
    }

    private func saveNow() {
        debounceTask?.cancel()
        debounceTask = nil
        guard state == .ready, dirty else { return }
        dirty = false
        let snapshot = value
        guard snapshot != lastStored else { return }
        let data: Data
        do {
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.sortedKeys]
            data = try encoder.encode(snapshot)
        } catch {
            let reason = Self.describe(error)
            if lastError != reason { lastError = reason }
            return
        }
        savesInFlight += 1
        let previous = lastSave
        let backend = self.backend
        let key = self.key
        lastSave = Task.detached(priority: .utility) { [weak self] in
            await previous?.value
            let failure: String?
            do {
                try await backend.saveData(data, forKey: key)
                failure = nil
            } catch {
                failure = Self.describe(error)
            }
            await self?.finishedSave(snapshot, failure: failure)
        }
    }

    private func finishedSave(_ saved: Value, failure: String?) {
        savesInFlight -= 1
        if let failure {
            if lastError != failure { lastError = failure }
            if value != lastStored {
                // Still pending: `flush()` and the next edit retry it, and a queued read waits for it.
                dirty = true
                if failedSaves < Self.retryDelays.count, savesInFlight == 0 {
                    scheduleSave(after: Self.retryDelays[failedSaves])
                }
                failedSaves += 1
            }
        } else {
            lastStored = saved
            failedSaves = 0
            if lastError != nil { lastError = nil }
        }
        if reloadWanted, !hasPendingChanges, !loadInFlight {
            reloadWanted = false
            Task { [weak self] in await self?.performLoad() }
        }
    }

    nonisolated private static func describe(_ error: Error) -> String {
        if let decoding = error as? DecodingError { return MonitorJSON.describe(decoding) }
        return error.localizedDescription
    }
}
