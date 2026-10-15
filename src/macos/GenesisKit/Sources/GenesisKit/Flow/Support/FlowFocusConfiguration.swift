import Combine
import Darwin
import Foundation

/// The existing client.json contract. Only app keys belonging to Flow/Focus are merged.
/// Genesis can supply its live configuration reader; standalone hosts use the same file.
@MainActor
public final class FlowFocusConfiguration: ObservableObject {
    public static var shared = FlowFocusConfiguration()
    public var readApp: (() -> [String: Any])?
    /// A runtime client hands each patch to its owner. The task ends once the owner stored it, and throws when the
    /// owner refused it or its write failed.
    public var forwardPatch: (([String: Any]) throws -> Task<Void, Error>)?
    public var onFailure: ((String) -> Void)?
    public var didPersist: (() -> Void)?
    @Published public private(set) var revision: UInt64 = 0
    @Published public private(set) var lastError: String?
    private var pendingWrites: [(id: UUID, patch: [String: Any])] = []
    public var allowsWrites = false
    public let directory: URL
    private var cachedApp: [String: Any]
    /// Writes run one after another, in the order they were made, off the main actor. The last one is kept so the
    /// next write and `flush()` can wait for it; waiting for the cross-process lock suspends instead of sleeping a thread.
    private var lastWrite: Task<Void, Never>?
    /// A client's patches the owner has not answered yet, in order, for `flush()`.
    private var lastForward: Task<Void, Never>?

    public init(directory: URL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".genesis")) {
        self.directory = directory
        cachedApp = Self.readRaw(directory: directory)["app"] as? [String: Any] ?? [:]
    }

    public var app: [String: Any] {
        pendingWrites.reduce(readApp?() ?? cachedApp) { Self.merge($0, $1.patch) }
    }
    public var dictationEnabled: Bool { (app["labs"] as? [String: Any])?["dictation"] as? Bool ?? true }

    public var transformConfiguration: FlowTransformConfiguration {
        Self.resolveTransformConfiguration(app: app)
    }

    nonisolated static func resolveTransformConfiguration(app: [String: Any]) -> FlowTransformConfiguration {
        let companion = app["companion"] as? [String: Any] ?? [:]
        let backend = companion["aiBackend"] as? [String: Any] ?? [:]
        let ai = app["ai"] as? [String: Any] ?? [:]
        let features = ai["features"] as? [String: Any] ?? [:]
        let feature = features["flow"] as? [String: Any] ?? [:]
        let raw = (backend["baseURL"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let kind = backend["kind"] as? String ?? "aiProxy"
        let fallback: String
        switch kind {
        case "custom": fallback = ""
        case "openRouter": fallback = "https://openrouter.ai/api/v1"
        default: fallback = "http://127.0.0.1:8317/v1"
        }
        let components = URLComponents(string: raw)
        let valid = !raw.contains(where: \.isWhitespace)
            && ["http", "https"].contains(components?.scheme?.lowercased() ?? "")
            && !(components?.host ?? "").isEmpty
        let base = valid ? raw : fallback
        let featureModel = (feature["model"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        return FlowTransformConfiguration(
            baseURL: base.hasSuffix("/") ? String(base.dropLast()) : base,
            model: featureModel ?? backend["model"] as? String ?? "",
            token: backend["token"] as? String ?? "")
    }

    public func reload() {
        do {
            cachedApp = try Self.readForWrite(directory: directory)["app"] as? [String: Any] ?? [:]
            revision &+= 1
        } catch { reportFailure(error.localizedDescription) }
    }

    public func dismissError() { lastError = nil }

    func reportFailure(_ message: String) {
        lastError = message
        failures &+= 1
        revision &+= 1
        onFailure?(message)
    }

    /// Counts every reported failure, so a caller can tell whether its own write failed while it waited.
    private var failures: UInt64 = 0

    public func setAppValue(_ value: Any, forKey key: String) {
        applyPatch([key: value])
    }

    /// `setAppValue`, then waits for the write: false when it was refused or failed (`lastError` says why), true once
    /// client.json holds it. A runtime client waits for its owner's answer, which comes after the owner's write.
    public func saveAppValue(_ value: Any, forKey key: String) async -> Bool {
        let before = failures
        applyPatch([key: value])
        await flush()
        return failures == before
    }

    /// Writes every Focus setting the Settings page shows, under the same `app.focus` keys `FocusSettings.from` and
    /// `PomodoroPlan.from` read: the switches, the exclusion lists, the project rules and the timer.
    func updateFocus(settings: FocusSettings, plan: PomodoroPlan) {
        var focus = settings.storedFields
        focus["timer"] = [
            "flowSec": plan.flowSec, "shortBreakSec": plan.shortBreakSec,
            "longBreakSec": plan.longBreakSec, "cycleLength": plan.cycleLength,
            "autoStartBreaks": plan.autoStartBreaks, "autoStartFlows": plan.autoStartFlows,
            "allowOverrun": plan.allowOverrun, "dndWhileFlowing": plan.dndWhileFlowing,
            "sound": plan.sound, "idlePauseSec": plan.idlePauseSec,
            "resumeOnActivity": plan.resumeOnActivity, "nudgeEverySec": plan.nudgeEverySec,
        ] as [String: Any]
        applyPatch(["focus": focus])
    }

    func applyPatch(_ patch: [String: Any]) {
        // JSONSerialization raises an Objective-C exception (a crash, not a Swift error) for a value such as a
        // Date or a URL; setAppValue is public, so check first. A client's forwarder serializes the patch too.
        guard JSONSerialization.isValidJSONObject(patch) else {
            reportFailure("The setting value cannot be stored as JSON.")
            return
        }
        if let forwardPatch {
            do {
                let sent = try forwardPatch(patch)
                // Shown at once, like a local write, so the next edit builds on it; it goes once the owner answered
                // (its reload then holds the stored value) or refused.
                let id = UUID()
                pendingWrites.append((id, patch))
                lastError = nil
                revision &+= 1
                let previous = lastForward
                lastForward = Task { [weak self] in
                    await previous?.value
                    do {
                        try await sent.value
                        self?.finishedForward(id)
                    } catch is CancellationError {
                        // The runtime stopped before the owner answered: not stored, and nothing to tell the user.
                        self?.failures &+= 1
                        self?.finishedForward(id)
                    } catch {
                        self?.finishedForward(id)
                        self?.reportFailure(error.localizedDescription)
                    }
                }
            } catch { reportFailure(error.localizedDescription) }
            return
        }
        guard allowsWrites else {
            reportFailure("Flow and Focus are waiting for their runtime owner.")
            return
        }
        do {
            let data = try JSONSerialization.data(withJSONObject: patch)
            let id = UUID()
            pendingWrites.append((id, patch))
            lastError = nil
            revision &+= 1
            let directory = self.directory
            let previous = lastWrite
            lastWrite = Task.detached(priority: .utility) { [weak self] in
                await previous?.value
                let failure: String?
                do {
                    try await Self.persist(data, directory: directory)
                    failure = nil
                } catch {
                    FlowFocusLog.focus.error("configuration write failed: \(error.localizedDescription)")
                    failure = error.localizedDescription
                }
                await self?.finishedWrite(id, error: failure)
            }
        } catch { reportFailure(error.localizedDescription) }
    }

    private func finishedForward(_ id: UUID) {
        pendingWrites.removeAll { $0.id == id }
        revision &+= 1
    }

    private func finishedWrite(_ id: UUID, error: String?) {
        pendingWrites.removeAll { $0.id == id }
        if let error {
            reportFailure(error)
        } else {
            didPersist?()
            reload()
        }
    }

    /// Waits until every write made before this call has reached disk (or failed), and for a runtime client until the
    /// owner answered every patch.
    public func flush() async {
        await lastWrite?.value
        await lastForward?.value
    }

    /// Counts every reported failure; the owner compares it around a client's patch.
    var failureCount: UInt64 { failures }

    nonisolated static func merge(_ original: [String: Any], _ patch: [String: Any]) -> [String: Any] {
        var result = original
        for (key, value) in patch {
            if let nested = value as? [String: Any] {
                result[key] = merge(result[key] as? [String: Any] ?? [:], nested)
            } else {
                result[key] = value
            }
        }
        return result
    }

    /// The file this configuration reads and writes. A lock in another writer's format is never removed by its age
    /// here (`staleLockAge: nil`), and failures keep this type's error domain and log category.
    nonisolated static func configFile(directory: URL, lockTimeout: TimeInterval = 5) -> ClientConfigFile {
        ClientConfigFile(directory: directory, lockTimeout: lockTimeout, staleLockAge: nil,
                         errorDomain: "FlowFocusConfiguration", log: FlowFocusLog.focus)
    }

    nonisolated private static func readRaw(directory: URL) -> [String: Any] {
        configFile(directory: directory).read()
    }

    /// Reads under the writer lock. Only a missing file permits fallback. A malformed or
    /// unreadable client.json must remain byte-for-byte intact until the user repairs it.
    nonisolated private static func readForWrite(directory: URL) throws -> [String: Any] {
        try configFile(directory: directory).readForWrite()
    }

    nonisolated static func clientKeys(fromLegacy legacy: [String: Any]) -> [String: Any] {
        ClientConfigFile.clientKeys(fromLegacy: legacy)
    }

    nonisolated static let lockMarkerPrefix = ClientConfigFile.lockMarkerPrefix

    /// Matches ConfigStore and the CLI's O_EXCL protocol through `ClientConfigFile`. Runs off the main thread and
    /// never falls back to an unlocked write when another writer has not released its lock. While another writer
    /// holds the lock it suspends (no thread is held) and retries every 100 ms until `lockTimeout`, then throws. The
    /// patch is deep-merged into `app`, and the file is rewritten even when the merge changed nothing.
    nonisolated static func persist(_ data: Data, directory: URL, lockTimeout: TimeInterval = 5) async throws {
        let patch = try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
        try await configFile(directory: directory, lockTimeout: lockTimeout).mutate(alwaysWrite: true) { raw in
            raw["app"] = merge(raw["app"] as? [String: Any] ?? [:], patch)
        }
    }
}
