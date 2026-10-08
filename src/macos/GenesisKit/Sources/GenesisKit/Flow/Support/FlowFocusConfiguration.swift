import Darwin
import Foundation

/// The existing client.json contract. Only app keys belonging to Flow/Focus are merged.
/// Genesis can supply its live configuration reader; standalone hosts use the same file.
@MainActor
public final class FlowFocusConfiguration {
    public static var shared = FlowFocusConfiguration()
    public var readApp: (() -> [String: Any])?
    public var forwardPatch: (([String: Any]) -> Void)?
    public var onFailure: ((String) -> Void)?
    public var allowsWrites = false
    public let directory: URL
    private var cachedApp: [String: Any]
    private let writes = DispatchQueue(label: "dev.genesis.flow-focus.configuration", qos: .utility)

    public init(directory: URL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".genesis")) {
        self.directory = directory
        cachedApp = Self.readRaw(directory: directory)["app"] as? [String: Any] ?? [:]
    }

    public var app: [String: Any] { readApp?() ?? cachedApp }
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
        cachedApp = Self.readRaw(directory: directory)["app"] as? [String: Any] ?? [:]
    }

    public func setAppValue(_ value: Any, forKey key: String) {
        applyPatch([key: value])
    }

    func updateFocus(settings: FocusSettings, plan: PomodoroPlan) {
        applyPatch(["focus": [
            "captureEnabled": settings.captureEnabled,
            "titleMode": settings.titleMode.rawValue,
            "urlMode": settings.urlMode.rawValue,
            "idleThresholdSec": settings.idleThresholdSec,
            "interruptionThresholdSec": settings.interruptionThresholdSec,
            "retentionDays": settings.retentionDays,
            "menuBarStyle": settings.menuBarStyle,
            "pauseWhileScreenShared": settings.pauseWhileScreenShared,
            "timer": [
                "flowSec": plan.flowSec, "shortBreakSec": plan.shortBreakSec,
                "longBreakSec": plan.longBreakSec, "cycleLength": plan.cycleLength,
                "autoStartBreaks": plan.autoStartBreaks, "autoStartFlows": plan.autoStartFlows,
                "allowOverrun": plan.allowOverrun, "dndWhileFlowing": plan.dndWhileFlowing,
                "sound": plan.sound, "idlePauseSec": plan.idlePauseSec,
                "resumeOnActivity": plan.resumeOnActivity, "nudgeEverySec": plan.nudgeEverySec,
            ],
        ]])
    }

    func applyPatch(_ patch: [String: Any]) {
        if let forwardPatch {
            forwardPatch(patch)
            return
        }
        guard allowsWrites else {
            onFailure?("Flow and Focus are waiting for their runtime owner.")
            return
        }
        cachedApp = Self.merge(cachedApp, patch)
        do {
            let data = try JSONSerialization.data(withJSONObject: patch)
            let directory = self.directory
            writes.async { [weak self] in
                do {
                    try Self.persist(data, directory: directory)
                } catch {
                    FlowFocusLog.focus.error("configuration write failed: \(error.localizedDescription)")
                    Task { @MainActor in self?.onFailure?(error.localizedDescription) }
                }
            }
        } catch {
            onFailure?(error.localizedDescription)
        }
    }

    public func flush() async {
        await withCheckedContinuation { continuation in
            writes.async { continuation.resume() }
        }
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

    /// Matches ConfigStore and the CLI's O_EXCL protocol. Runs off the main thread and never
    /// falls back to an unlocked write when another writer has not released its lock.
    nonisolated static func persist(_ data: Data, directory: URL, lockTimeout: TimeInterval = 5) throws {
        let patch = try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        let lock = directory.appendingPathComponent("client.json.lock")
        let deadline = Date().addingTimeInterval(max(0.1, lockTimeout))
        while true {
            let descriptor = open(lock.path, O_CREAT | O_EXCL | O_WRONLY | O_CLOEXEC, 0o600)
            if descriptor >= 0 {
                close(descriptor)
                break
            }
            guard errno == EEXIST else {
                throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
            }
            guard Date() < deadline else {
                throw NSError(domain: "FlowFocusConfiguration", code: 1,
                              userInfo: [NSLocalizedDescriptionKey: "Timed out waiting for client.json.lock"])
            }
            Thread.sleep(forTimeInterval: min(0.1, max(0, deadline.timeIntervalSinceNow)))
        }
        defer {
            do { try FileManager.default.removeItem(at: lock) }
            catch { FlowFocusLog.focus.warning("configuration lock cleanup failed: \(error.localizedDescription)") }
        }
        var raw = try readForWrite(directory: directory)
        raw["app"] = merge(raw["app"] as? [String: Any] ?? [:], patch)
        let encoded = try JSONSerialization.data(withJSONObject: raw, options: [.prettyPrinted, .sortedKeys])
        let destination = directory.appendingPathComponent("client.json")
        try encoded.write(to: destination, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: destination.path)
    }
}
