import Combine
import Darwin
import Foundation

/// The existing client.json contract. Only app keys belonging to Flow/Focus are merged.
/// Genesis can supply its live configuration reader; standalone hosts use the same file.
@MainActor
public final class FlowFocusConfiguration: ObservableObject {
    public static var shared = FlowFocusConfiguration()
    public var readApp: (() -> [String: Any])?
    public var forwardPatch: (([String: Any]) -> Void)?
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
        revision &+= 1
        onFailure?(message)
    }

    public func setAppValue(_ value: Any, forKey key: String) {
        applyPatch([key: value])
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
            forwardPatch(patch)
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

    private func finishedWrite(_ id: UUID, error: String?) {
        pendingWrites.removeAll { $0.id == id }
        if let error {
            reportFailure(error)
        } else {
            didPersist?()
            reload()
        }
    }

    /// Waits until every write made before this call has reached disk (or failed).
    public func flush() async {
        await lastWrite?.value
    }

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

    nonisolated private static func readRaw(directory: URL) -> [String: Any] {
        for name in ["client.json", "config.json"] {
            if let data = try? Data(contentsOf: directory.appendingPathComponent(name)),
               let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                return name == "config.json" ? clientKeys(fromLegacy: raw) : raw
            }
        }
        return [:]
    }

    /// Reads under the writer lock. Only a missing file permits fallback. A malformed or
    /// unreadable client.json must remain byte-for-byte intact until the user repairs it.
    nonisolated private static func readForWrite(directory: URL) throws -> [String: Any] {
        for name in ["client.json", "config.json"] {
            let data: Data
            do {
                data = try Data(contentsOf: directory.appendingPathComponent(name))
            } catch {
                let cocoa = error as NSError
                if cocoa.domain == NSCocoaErrorDomain && cocoa.code == NSFileReadNoSuchFileError {
                    continue
                }
                throw error
            }
            guard let raw = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                throw NSError(domain: "FlowFocusConfiguration", code: 2,
                              userInfo: [NSLocalizedDescriptionKey: "\(name) must contain a JSON object; it was left unchanged."])
            }
            return name == "config.json" ? clientKeys(fromLegacy: raw) : raw
        }
        return [:]
    }

    nonisolated static func clientKeys(fromLegacy legacy: [String: Any]) -> [String: Any] {
        var result: [String: Any] = [:]
        for key in ["app", "obsidian", "server"] {
            if let value = legacy[key] { result[key] = value }
        }
        if let auth = legacy["auth"] as? [String: Any], let session = auth["sessionToken"] {
            result["auth"] = ["sessionToken": session]
        }
        return result
    }

    nonisolated static let lockMarkerPrefix = "genesis-kit pid="

    /// A lock this code wrote whose pid no longer runs is removed: the process died between creating it and its
    /// `defer`. A lock in any other format (ConfigStore, the CLI) or of a live pid is never touched, and age alone
    /// never counts. A reused pid only keeps the lock in place, never removes a live one. The content is read again
    /// just before the removal, so a lock another writer reclaimed and re-created in between is left alone.
    nonisolated static func reclaimIfOwnerDied(_ lock: URL) -> Bool {
        guard let first = try? Data(contentsOf: lock), let text = String(data: first, encoding: .utf8),
              text.hasPrefix(lockMarkerPrefix),
              let pid = pid_t(text.dropFirst(lockMarkerPrefix.count).trimmingCharacters(in: .whitespacesAndNewlines)),
              pid > 0, pid != getpid()
        else { return false }
        guard kill(pid, 0) == -1, errno == ESRCH else { return false }
        guard (try? Data(contentsOf: lock)) == first else { return false }
        do {
            try FileManager.default.removeItem(at: lock)
            FlowFocusLog.focus.warning("configuration lock of dead pid \(pid) removed")
            return true
        } catch {
            FlowFocusLog.focus.error("configuration lock of dead pid \(pid) not removed: \(error.localizedDescription)")
            return false
        }
    }

    /// Matches ConfigStore and the CLI's O_EXCL protocol. Runs off the main thread and never
    /// falls back to an unlocked write when another writer has not released its lock. While another writer holds
    /// the lock it suspends (no thread is held) and retries every 100 ms until `lockTimeout`, then throws.
    nonisolated static func persist(_ data: Data, directory: URL, lockTimeout: TimeInterval = 5) async throws {
        let patch = try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        let lock = directory.appendingPathComponent("client.json.lock")
        let deadline = Date().addingTimeInterval(max(0.1, lockTimeout))
        let marker = Data("\(lockMarkerPrefix)\(getpid())\n".utf8)
        while true {
            let descriptor = open(lock.path, O_CREAT | O_EXCL | O_WRONLY | O_CLOEXEC, 0o600)
            if descriptor >= 0 {
                // The owner's pid, so a later writer can prove this lock is stale if this process dies holding it.
                _ = marker.withUnsafeBytes { write(descriptor, $0.baseAddress, $0.count) }
                close(descriptor)
                break
            }
            guard errno == EEXIST else {
                throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
            }
            if reclaimIfOwnerDied(lock) { continue }
            guard Date() < deadline else {
                throw NSError(domain: "FlowFocusConfiguration", code: 1,
                              userInfo: [NSLocalizedDescriptionKey: "Timed out waiting for client.json.lock"])
            }
            let pause = min(0.1, max(0, deadline.timeIntervalSinceNow))
            try await Task.sleep(nanoseconds: UInt64(pause * 1_000_000_000))
        }
        defer {
            do { try FileManager.default.removeItem(at: lock) }
            catch { FlowFocusLog.focus.warning("configuration lock cleanup failed: \(error.localizedDescription)") }
        }
        var raw = try readForWrite(directory: directory)
        raw["app"] = merge(raw["app"] as? [String: Any] ?? [:], patch)
        let encoded = try JSONSerialization.data(withJSONObject: raw, options: [.prettyPrinted, .sortedKeys])
        let destination = directory.appendingPathComponent("client.json")
        // Owner-only before it becomes visible: a temporary file is chmodded and then renamed over client.json,
        // so the file never exists under the process umask.
        let temporary = directory.appendingPathComponent(".client.json.\(UUID().uuidString).tmp")
        do {
            try encoded.write(to: temporary)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: temporary.path)
            guard rename(temporary.path, destination.path) == 0 else {
                throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
            }
        } catch {
            if FileManager.default.fileExists(atPath: temporary.path) {
                do { try FileManager.default.removeItem(at: temporary) }
                catch let cleanup { FlowFocusLog.focus.warning("client.json temporary not removed: \(cleanup.localizedDescription)") }
            }
            throw error
        }
    }
}
