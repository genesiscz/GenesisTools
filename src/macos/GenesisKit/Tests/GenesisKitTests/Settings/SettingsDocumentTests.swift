import Foundation
import XCTest
@testable import GenesisKit

private struct FixtureSettings: Codable, Equatable, Sendable {
    var floorGB: Int = 10
    var enabled: Bool = true
    var slots: [String: Int] = [:]
}

/// A backend in memory that records every save and where it ran.
private final class MemoryBackend: KitSettingsBackend, @unchecked Sendable {
    private let lock = NSLock()
    private var stored: [String: Data] = [:]
    private var handlers: [@Sendable () -> Void] = []
    private var _saves: [Data?] = []
    private var _savesOnMain = 0
    private var _gate: CheckedContinuation<Void, Never>?
    private var _gated = false
    private var _stale = false
    private var _staleGate: CheckedContinuation<Void, Never>?
    /// Loads that snapshot the bytes at entry and wait. Released one at a time, newest or oldest.
    private var _orderLoads = false
    private var _orderedLoads: [CheckedContinuation<Void, Never>] = []
    private var _holdSaves = false
    private var _saveWaiters: [CheckedContinuation<Void, Never>] = []
    var failSaves = false

    var saves: [Data?] { lock.lock(); defer { lock.unlock() }; return _saves }
    var savesOnMain: Int { lock.lock(); defer { lock.unlock() }; return _savesOnMain }

    init(_ initial: [String: Data] = [:], gated: Bool = false) {
        stored = initial
        _gated = gated
    }

    func loadData(forKey key: String) async throws -> Data? {
        if takeOrdered() {
            let snapshot = storedData(forKey: key)
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                lock.lock()
                if _orderLoads {
                    _orderedLoads.append(continuation)
                    lock.unlock()
                } else {
                    lock.unlock()
                    continuation.resume()
                }
            }
            return snapshot
        }
        if takeStale() {
            let snapshot = storedData(forKey: key)
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                lock.lock()
                _staleGate = continuation
                lock.unlock()
            }
            return snapshot
        }
        if lockedGated() {
            await withCheckedContinuation { continuation in
                lock.lock()
                _gate = continuation
                lock.unlock()
            }
        }
        lock.lock()
        defer { lock.unlock() }
        return stored[key]
    }

    private func lockedGated() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return _gated
    }

    func openGate() {
        lock.lock()
        _gated = false
        _stale = false
        let gate = _gate
        let stale = _staleGate
        _gate = nil
        _staleGate = nil
        lock.unlock()
        gate?.resume()
        stale?.resume()
    }

    var isWaitingAtGate: Bool {
        lock.lock()
        defer { lock.unlock() }
        return _gate != nil || _staleGate != nil
    }

    func storedData(forKey key: String) -> Data? {
        lock.lock()
        defer { lock.unlock() }
        return stored[key]
    }

    /// The next loads snapshot the bytes now, then wait, then return that snapshot. A save that lands
    /// while they wait is not what they return.
    func holdStaleLoads() {
        lock.lock()
        _stale = true
        lock.unlock()
    }

    private func takeStale() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return _stale
    }

    private func takeOrdered() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return _orderLoads
    }

    /// The next loads each keep the bytes they see at entry, then wait until released.
    func holdOrderedLoads() {
        lock.lock()
        _orderLoads = true
        lock.unlock()
    }

    var orderedLoadsWaiting: Int {
        lock.lock()
        defer { lock.unlock() }
        return _orderedLoads.count
    }

    func releaseNewestOrderedLoad() {
        lock.lock()
        let newest = _orderedLoads.popLast()
        lock.unlock()
        newest?.resume()
    }

    func releaseOldestOrderedLoad() {
        lock.lock()
        let oldest = _orderedLoads.isEmpty ? nil : _orderedLoads.removeFirst()
        lock.unlock()
        oldest?.resume()
    }

    func releaseOrderedLoads() {
        lock.lock()
        _orderLoads = false
        let waiting = _orderedLoads
        _orderedLoads = []
        lock.unlock()
        for waiter in waiting { waiter.resume() }
    }

    /// Replaces the stored bytes without telling observers, so a held load keeps the snapshot it already took.
    func replaceStored(_ data: Data, forKey key: String) {
        lock.lock()
        stored[key] = data
        lock.unlock()
    }

    func holdSaves() {
        lock.lock()
        _holdSaves = true
        lock.unlock()
    }

    var savesWaiting: Int {
        lock.lock()
        defer { lock.unlock() }
        return _saveWaiters.count
    }

    func releaseSaves() {
        lock.lock()
        _holdSaves = false
        let waiters = _saveWaiters
        _saveWaiters = []
        lock.unlock()
        for waiter in waiters { waiter.resume() }
    }

    func saveData(_ data: Data?, forKey key: String) async throws {
        let hold: Bool
        lock.lock()
        hold = _holdSaves
        lock.unlock()
        if hold {
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                lock.lock()
                if _holdSaves {
                    _saveWaiters.append(continuation)
                    lock.unlock()
                } else {
                    lock.unlock()
                    continuation.resume()
                }
            }
        }
        lock.lock()
        _saves.append(data)
        if Thread.isMainThread { _savesOnMain += 1 }
        let fail = failSaves
        if !fail { stored[key] = data }
        lock.unlock()
        if fail { throw NSError(domain: "fixture", code: 9, userInfo: [NSLocalizedDescriptionKey: "disk refused"]) }
    }

    func observeChanges(forKey key: String, _ onChange: @escaping @Sendable () -> Void) -> SettingsObservation? {
        lock.lock()
        handlers.append(onChange)
        lock.unlock()
        return SettingsObservation {}
    }

    func externalWrite(_ data: Data, forKey key: String) {
        lock.lock()
        stored[key] = data
        let all = handlers
        lock.unlock()
        for handler in all { handler() }
    }
}

@MainActor
final class SettingsDocumentTests: XCTestCase {
    private func encoded(_ value: FixtureSettings) -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return try! encoder.encode(value)
    }

    private func waitUntil(_ message: String = "", timeout: TimeInterval = 3,
                           file: StaticString = #filePath, line: UInt = #line,
                           _ condition: () -> Bool) async {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() {
            if Date() > deadline {
                XCTFail("timed out: \(message)", file: file, line: line)
                return
            }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
    }

    func testLoadsTheStoredValueAndAMissingOneIsTheDefaultWithoutAWrite() async {
        let backend = MemoryBackend(["disk": encoded(FixtureSettings(floorGB: 4))])
        let document = SettingsDocument(key: "disk", backend: backend, defaultValue: FixtureSettings())
        XCTAssertEqual(document.state, .loading)
        await document.load()
        XCTAssertEqual(document.state, .ready)
        XCTAssertEqual(document.value.floorGB, 4)

        let empty = MemoryBackend()
        let fresh = SettingsDocument(key: "disk", backend: empty, defaultValue: FixtureSettings())
        await fresh.load()
        XCTAssertEqual(fresh.value, FixtureSettings())
        XCTAssertTrue(empty.saves.isEmpty, "loading never writes")
    }

    func testABurstOfEditsIsOneDebouncedSaveOffTheMainThread() async throws {
        let backend = MemoryBackend()
        let document = SettingsDocument(key: "disk", backend: backend, defaultValue: FixtureSettings(),
                                        debounce: .milliseconds(150))
        await document.load()
        for floor in 1 ... 5 { document.update { $0.floorGB = floor } }
        XCTAssertEqual(document.value.floorGB, 5, "applied in memory at once")
        XCTAssertTrue(document.hasPendingChanges)
        try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertTrue(backend.saves.isEmpty, "nothing written inside the debounce window")
        await waitUntil { backend.saves.count == 1 && !document.hasPendingChanges }
        XCTAssertEqual(backend.saves.first??.isEmpty, false)
        XCTAssertEqual(try JSONDecoder().decode(FixtureSettings.self, from: XCTUnwrap(backend.saves.first ?? nil)).floorGB, 5)
        XCTAssertEqual(backend.savesOnMain, 0, "the backend never runs on the main thread")
        try await Task.sleep(nanoseconds: 250_000_000)
        XCTAssertEqual(backend.saves.count, 1, "no second write")
    }

    func testFlushSavesAtOnceAndAnEditBackToTheStoredValueWritesNothing() async {
        let backend = MemoryBackend(["disk": encoded(FixtureSettings())])
        let document = SettingsDocument(key: "disk", backend: backend, defaultValue: FixtureSettings(),
                                        debounce: .seconds(30))
        await document.load()
        document.update { $0.enabled = false }
        let ok = await document.flush()
        XCTAssertTrue(ok)
        XCTAssertEqual(backend.saves.count, 1)
        document.update { $0.enabled = true }
        document.update { $0.enabled = false }
        await document.flush()
        XCTAssertEqual(backend.saves.count, 1, "the value equals what is stored, so nothing is written")
    }

    func testAnUnreadableValueIsNeverOverwrittenUntilTheUserChoosesTo() async throws {
        let original = Data(#"{"floorGB":"not a number"}"#.utf8)
        let backend = MemoryBackend(["disk": original])
        let document = SettingsDocument(key: "disk", backend: backend, defaultValue: FixtureSettings(),
                                        debounce: .milliseconds(10))
        await document.load()
        guard case .unreadable = document.state else { return XCTFail("expected unreadable, got \(document.state)") }
        XCTAssertNotNil(document.lastError)
        document.update { $0.floorGB = 2 }
        let flushed = await document.flush()
        XCTAssertFalse(flushed)
        XCTAssertTrue(backend.saves.isEmpty, "the stored bytes survive")
        let kept = try await backend.loadData(forKey: "disk")
        XCTAssertEqual(kept, original)

        document.overwriteUnreadableValue()
        await document.flush()
        XCTAssertEqual(document.state, .ready)
        XCTAssertEqual(backend.saves.count, 1)
    }

    func testAnExternalChangeIsReadBackAndAPendingLocalEditWins() async throws {
        let backend = MemoryBackend(["disk": encoded(FixtureSettings())])
        let document = SettingsDocument(key: "disk", backend: backend, defaultValue: FixtureSettings(),
                                        debounce: .milliseconds(200))
        await document.load()
        backend.externalWrite(encoded(FixtureSettings(floorGB: 7)), forKey: "disk")
        await waitUntil("external value") { document.value.floorGB == 7 }

        document.update { $0.enabled = false }
        backend.externalWrite(encoded(FixtureSettings(floorGB: 8, enabled: true)), forKey: "disk")
        try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(document.value.enabled, false, "the local edit is not undone by an older read")
        await waitUntil("saved and read back") { !document.hasPendingChanges }
        await waitUntil("settled") { document.value.enabled == false && document.value.floorGB == 7 }
        let final = try await backend.loadData(forKey: "disk")
        XCTAssertEqual(try JSONDecoder().decode(FixtureSettings.self, from: XCTUnwrap(final)),
                       FixtureSettings(floorGB: 7, enabled: false), "the whole local value was saved over the external one")
    }

    func testASaveFailureIsReportedAndTheValueStays() async {
        let backend = MemoryBackend()
        backend.failSaves = true
        let document = SettingsDocument(key: "disk", backend: backend, defaultValue: FixtureSettings(),
                                        debounce: .milliseconds(10))
        await document.load()
        document.update { $0.floorGB = 3 }
        let ok = await document.flush()
        XCTAssertFalse(ok)
        XCTAssertEqual(document.lastError, "disk refused")
        XCTAssertEqual(document.value.floorGB, 3)
    }

    func testAnEditBeforeTheLoadLandsIsReplayedOnTopOfTheStoredValue() async {
        let backend = MemoryBackend(["disk": encoded(FixtureSettings(floorGB: 4, slots: ["home": 1]))], gated: true)
        let document = SettingsDocument(key: "disk", backend: backend, defaultValue: FixtureSettings(),
                                        debounce: .milliseconds(10))
        await waitUntil("load started") { backend.isWaitingAtGate }
        document.update { $0.enabled = false }
        backend.openGate()
        await document.load()
        XCTAssertEqual(document.value, FixtureSettings(floorGB: 4, enabled: false, slots: ["home": 1]))
        await document.flush()
        XCTAssertEqual(backend.saves.count, 1)
    }

    func testABindingWritesThroughTheDocument() async {
        let backend = MemoryBackend()
        let document = SettingsDocument(key: "disk", backend: backend, defaultValue: FixtureSettings(),
                                        debounce: .milliseconds(10))
        await document.load()
        let binding = document.binding(\.floorGB)
        binding.wrappedValue = 12
        XCTAssertEqual(document.value.floorGB, 12)
        XCTAssertEqual(binding.wrappedValue, 12)
    }

    func testClientConfigBackendRoundTripsAndSeesAnotherWriter() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("settings-doc-\(UUID())")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = ClientConfigFile(directory: directory)
        let document = SettingsDocument(key: "disk", backend: ClientConfigBackend(file: file, coalesce: 0.05),
                                        defaultValue: FixtureSettings(), debounce: .milliseconds(10))
        await document.load()
        document.update { $0.slots = ["home": 1, "office": 2] }
        await document.flush()
        document.update { $0.slots = ["home": 1] }
        await document.flush()
        let disk = try XCTUnwrap(file.readAppValue("disk") as? [String: Any])
        XCTAssertEqual(disk["slots"] as? [String: Int], ["home": 1], "a removed slot is removed on disk")

        // Another process writes the same key.
        try await file.replaceAppValue(["floorGB": 2, "enabled": true, "slots": [:] as [String: Int]], forKey: "disk")
        await waitUntil("folder event") { document.value.floorGB == 2 }
        XCTAssertEqual(document.value.slots, [:])
    }

    func testUserDefaultsBackendRoundTrips() async throws {
        let suite = "dev.genesis.settingsdocument.test.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let backend = UserDefaultsSettingsBackend(defaults: defaults)
        let document = SettingsDocument(key: "postureSettings", backend: backend, defaultValue: FixtureSettings(),
                                        debounce: .milliseconds(10))
        await document.load()
        document.update { $0.floorGB = 6 }
        await document.flush()
        let reread = SettingsDocument(key: "postureSettings", backend: backend, defaultValue: FixtureSettings())
        await reread.load()
        XCTAssertEqual(reread.value.floorGB, 6)
        try await backend.saveData(nil, forKey: "postureSettings")
        XCTAssertNil(defaults.data(forKey: "postureSettings"))
        XCTAssertNil(backend.observeChanges(forKey: "has.dots") { }, "KVO cannot observe a dotted key")
    }
}

extension SettingsDocumentTests {
    /// M1 and M2: a failed save stays pending, a queued outside read waits for it, and `flush()` retries it.
    func testAFailedSaveStaysPendingAndFlushRetriesItOnceTheDiskRecovers() async throws {
        let backend = MemoryBackend(["disk": encoded(FixtureSettings())])
        backend.failSaves = true
        let document = SettingsDocument(key: "disk", backend: backend, defaultValue: FixtureSettings(),
                                        debounce: .milliseconds(10))
        await document.load()
        document.update { $0.floorGB = 3 }
        let failed = await document.flush()
        XCTAssertFalse(failed)
        XCTAssertTrue(document.hasPendingChanges, "the edit is still pending after a failed save")

        backend.externalWrite(encoded(FixtureSettings(floorGB: 9)), forKey: "disk")
        try await Task.sleep(nanoseconds: 150_000_000)
        XCTAssertEqual(document.value.floorGB, 3, "a queued read does not undo the unsaved edit")
        XCTAssertEqual(document.lastError, "disk refused", "nor hide the error")

        backend.failSaves = false
        let saved = await document.flush()
        XCTAssertTrue(saved)
        XCTAssertNil(document.lastError)
        let stored = try await backend.loadData(forKey: "disk")
        XCTAssertEqual(try JSONDecoder().decode(FixtureSettings.self, from: XCTUnwrap(stored)).floorGB, 3)
    }

    /// Low 4: writes of other files in the folder do not make every document re-read client.json.
    func testClientConfigBackendIgnoresOtherFilesInTheFolder() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("settings-watch-\(UUID())")
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = ClientConfigFile(directory: directory)
        final class Count: @unchecked Sendable {
            private let lock = NSLock()
            private var value = 0
            func add() { lock.lock(); value += 1; lock.unlock() }
            var current: Int { lock.lock(); defer { lock.unlock() }; return value }
        }
        let count = Count()
        let observation = ClientConfigBackend(file: file, coalesce: 0.05).observeChanges(forKey: "disk") { count.add() }
        XCTAssertNotNil(observation, "a missing folder is created so the watch starts")
        try Data("{}".utf8).write(to: directory.appendingPathComponent("monitor-session-alerts.json"))
        try await Task.sleep(nanoseconds: 400_000_000)
        XCTAssertEqual(count.current, 0)
        try await file.replaceAppValue(["floorGB": 1], forKey: "disk")
        await waitUntil("client.json changed") { count.current > 0 }
        withExtendedLifetime(observation) {}
    }

    /// An encode that throws used to clear the pending edit first, so the next external read replaced it.
    func testAnEncodeFailureKeepsTheEditPending() async throws {
        let backend = MemoryBackend(["disk": encodedFragile(1)])
        let document = SettingsDocument(key: "disk", backend: backend, defaultValue: FragileSettings(n: 0),
                                        debounce: .zero)
        await document.load()
        document.set(FragileSettings(n: -1))
        let flushed = await document.flush()
        XCTAssertFalse(flushed)
        XCTAssertTrue(document.hasPendingChanges)
        XCTAssertTrue(backend.saves.isEmpty)
        XCTAssertNotNil(document.lastError)
        backend.externalWrite(encodedFragile(4), forKey: "disk")
        try await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertEqual(document.value.n, -1, "the external value does not replace an edit that could not be saved")
        document.set(FragileSettings(n: 2))
        let saved = await document.flush()
        XCTAssertTrue(saved)
        XCTAssertEqual(try JSONDecoder().decode(FragileSettings.self, from: XCTUnwrap(backend.storedData(forKey: "disk"))).n, 2)
    }

    /// Reverting to the stored value while an earlier save is still in flight must be what lands.
    func testARevertWhileASaveIsInFlightIsWhatLands() async throws {
        let backend = MemoryBackend(["disk": encoded(FixtureSettings(floorGB: 1))])
        let document = SettingsDocument(key: "disk", backend: backend, defaultValue: FixtureSettings(),
                                        debounce: .zero)
        await document.load()
        backend.holdSaves()
        defer { backend.releaseSaves() }
        document.set(FixtureSettings(floorGB: 2))
        await waitUntil("the first save is in flight") { backend.savesWaiting == 1 }
        guard backend.savesWaiting == 1 else { return }
        document.set(FixtureSettings(floorGB: 1))
        async let flushed = document.flush()
        try? await Task.sleep(nanoseconds: 50_000_000)
        backend.releaseSaves()
        let saved = await flushed
        XCTAssertTrue(saved)
        let stored = try JSONDecoder().decode(FixtureSettings.self, from: XCTUnwrap(backend.storedData(forKey: "disk")))
        XCTAssertEqual(stored.floorGB, 1)
    }

    /// A load that read the old bytes can return after the local save has finished. It must not write them back.
    func testAStaleLoadCannotReplaceASavedEdit() async throws {
        let backend = MemoryBackend(["disk": encoded(FixtureSettings(floorGB: 1))])
        let document = SettingsDocument(key: "disk", backend: backend, defaultValue: FixtureSettings(),
                                        debounce: .zero)
        await document.load()
        backend.holdStaleLoads()
        defer { backend.openGate() }
        async let reloaded: Void = document.reload()
        await waitUntil("the reload is inside the backend") { backend.isWaitingAtGate }
        guard backend.isWaitingAtGate else { return }
        document.set(FixtureSettings(floorGB: 2))
        let saved = await document.flush()
        XCTAssertTrue(saved)
        backend.openGate()
        await reloaded
        XCTAssertEqual(document.value.floorGB, 2)
        let stored = try JSONDecoder().decode(FixtureSettings.self, from: XCTUnwrap(backend.storedData(forKey: "disk")))
        XCTAssertEqual(stored.floorGB, 2)
    }

    /// Two reloads can read different stored values. The one that started first can finish last, and it must not win.
    func testAnOlderReloadCannotReplaceANewerRead() async throws {
        let backend = MemoryBackend(["disk": encoded(FixtureSettings(floorGB: 1))])
        let document = SettingsDocument(key: "disk", backend: backend, defaultValue: FixtureSettings(),
                                        debounce: .zero)
        await document.load()
        backend.holdOrderedLoads()
        defer { backend.releaseOrderedLoads() }
        async let first: Void = document.reload()
        await waitUntil("the first reload is inside the backend") { backend.orderedLoadsWaiting == 1 }
        guard backend.orderedLoadsWaiting == 1 else { return }
        backend.replaceStored(encoded(FixtureSettings(floorGB: 2)), forKey: "disk")
        async let second: Void = document.reload()
        await waitUntil("the second reload is inside the backend") { backend.orderedLoadsWaiting == 2 }
        guard backend.orderedLoadsWaiting == 2 else { return }
        backend.releaseNewestOrderedLoad()
        await second
        XCTAssertEqual(document.value.floorGB, 2)
        backend.releaseOldestOrderedLoad()
        await first
        XCTAssertEqual(document.value.floorGB, 2)
    }
}

private struct FragileSettings: Codable, Equatable, Sendable {
    var n: Int

    func encode(to encoder: Encoder) throws {
        if n < 0 {
            throw EncodingError.invalidValue(n, EncodingError.Context(codingPath: [], debugDescription: "negative"))
        }
        var container = encoder.singleValueContainer()
        try container.encode(n)
    }

    init(n: Int) { self.n = n }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        n = try container.decode(Int.self)
    }
}

extension SettingsDocumentTests {
    fileprivate func encodedFragile(_ n: Int) -> Data {
        try! JSONEncoder().encode(FragileSettings(n: n))
    }
}
