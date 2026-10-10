import AppKit
import ApplicationServices
import AVFoundation
import Contacts
import CoreGraphics
import EventKit
import Foundation
import IOKit.hid
import Speech

/// Where grants are read and requested. `SystemPermissions` talks to macOS; tests pass a fake.
public protocol PermissionSystem: Sendable {
    /// Reads the grant. Never prompts.
    func status(_ kind: PermissionKind) -> PermissionStatus
    /// Asks macOS in place where it allows it (`PermissionRequestStyle`), then reads the grant again.
    func request(_ kind: PermissionKind) async -> PermissionStatus
    /// Opens the kind's pane in System Settings.
    @MainActor func openSettings(_ kind: PermissionKind) -> Bool
}

public extension PermissionStatus {
    /// Input Monitoring is on in System Settings, but this process still reads its old answer.
    static let needsRelaunch = PermissionStatus.partial("granted, relaunch to use")
}

/// The real TCC reads and requests. Requests run from this process, so the prompt names this app and the answer
/// lands on the row the CLI checks.
public struct SystemPermissions: PermissionSystem {
    /// A prompt waits for the user; past this deadline the request reads the grant as it is and returns.
    static let promptDeadline: TimeInterval = 180

    private static let tccUserDb = NSString(string: "~/Library/Application Support/com.apple.TCC/TCC.db")
        .expandingTildeInPath

    public init() {}

    public func status(_ kind: PermissionKind) -> PermissionStatus {
        switch kind {
        case .inputMonitoring:
            if CGPreflightListenEventAccess() { return .granted }
            // The preflight answer is cached for the process; IOHID tells a refusal from a question not asked yet,
            // and from a grant this process cannot use until it starts again.
            let access = IOHIDCheckAccess(kIOHIDRequestTypeListenEvent)
            if access == kIOHIDAccessTypeDenied { return .denied }
            if access == kIOHIDAccessTypeGranted { return .needsRelaunch }
            return .notDetermined
        case .accessibility:
            // macOS has no status that tells "denied" from "not asked" here.
            return AXIsProcessTrusted() ? .granted : .notDetermined
        case .screenRecording:
            return CGPreflightScreenCaptureAccess() ? .granted : .notDetermined
        case .microphone:
            return Self.status(AVCaptureDevice.authorizationStatus(for: .audio))
        case .speechRecognition:
            switch SFSpeechRecognizer.authorizationStatus() {
            case .authorized: return .granted
            case .denied: return .denied
            case .restricted: return .restricted
            case .notDetermined: return .notDetermined
            @unknown default: return .unknown("unknown")
            }
        case .calendars:
            return Self.status(EKEventStore.authorizationStatus(for: .event))
        case .reminders:
            return Self.status(EKEventStore.authorizationStatus(for: .reminder))
        case .contacts:
            switch CNContactStore.authorizationStatus(for: .contacts) {
            case .authorized: return .granted
            case .denied: return .denied
            case .restricted: return .restricted
            case .notDetermined: return .notDetermined
            default: return .partial("limited")
            }
        case .fullDiskAccess:
            // The per-user TCC database is itself behind Full Disk Access: opening it is the probe.
            return FileHandle(forReadingAtPath: Self.tccUserDb) != nil ? .granted : .denied
        case .automation, .desktopFolder, .documentsFolder, .downloadsFolder:
            return .unknown("asks on first use")
        }
    }

    public func request(_ kind: PermissionKind) async -> PermissionStatus {
        switch kind {
        case .microphone:
            guard status(kind) == .notDetermined else { return status(kind) }
            await Self.waitForAnswer { done in AVCaptureDevice.requestAccess(for: .audio) { _ in done() } }
        case .speechRecognition:
            guard status(kind) == .notDetermined else { return status(kind) }
            await Self.waitForAnswer { done in SFSpeechRecognizer.requestAuthorization { _ in done() } }
        case .calendars:
            guard status(kind) == .notDetermined else { return status(kind) }
            let store = EKEventStore()
            await Self.waitForAnswer { done in
                store.requestFullAccessToEvents { _, error in
                    if let error { GenesisKit.log("permission calendar request: \(error.localizedDescription)") }
                    done()
                }
            }
        case .reminders:
            guard status(kind) == .notDetermined else { return status(kind) }
            let store = EKEventStore()
            await Self.waitForAnswer { done in
                store.requestFullAccessToReminders { _, error in
                    if let error { GenesisKit.log("permission reminders request: \(error.localizedDescription)") }
                    done()
                }
            }
        case .contacts:
            guard status(kind) == .notDetermined else { return status(kind) }
            let store = CNContactStore()
            await Self.waitForAnswer { done in
                store.requestAccess(for: .contacts) { _, error in
                    if let error { GenesisKit.log("permission contacts request: \(error.localizedDescription)") }
                    done()
                }
            }
        case .accessibility:
            await MainActor.run {
                let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
                _ = AXIsProcessTrustedWithOptions(options)
            }
        case .screenRecording:
            await MainActor.run { _ = CGRequestScreenCaptureAccess() }
        case .inputMonitoring:
            await MainActor.run { _ = CGRequestListenEventAccess() }
        case .fullDiskAccess:
            break
        case .automation:
            return await Self.probeAutomation()
        case .desktopFolder, .documentsFolder, .downloadsFolder:
            return await Self.probeFolder(kind.folderPath ?? "")
        }
        return status(kind)
    }

    @MainActor
    public func openSettings(_ kind: PermissionKind) -> Bool {
        let opened = NSWorkspace.shared.open(kind.settingsURL)
        GenesisKit.log("permission \(kind.rawValue) open settings \(kind.settingsAnchor) opened=\(opened)")
        return opened
    }

    private static func status(_ status: AVAuthorizationStatus) -> PermissionStatus {
        switch status {
        case .authorized: return .granted
        case .denied: return .denied
        case .restricted: return .restricted
        case .notDetermined: return .notDetermined
        @unknown default: return .unknown("unknown")
        }
    }

    private static func status(_ status: EKAuthorizationStatus) -> PermissionStatus {
        switch status {
        case .fullAccess: return .granted
        case .writeOnly: return .partial("Add Only")
        case .denied: return .denied
        case .restricted: return .restricted
        case .notDetermined: return .notDetermined
        default: return .unknown("status \(status.rawValue)")
        }
    }

    /// Runs `start`, then returns once it calls back or the deadline passes, whichever is first.
    private static func waitForAnswer(_ start: (@escaping @Sendable () -> Void) -> Void) async {
        let wait = PromptWait()
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            wait.arm(continuation)
            start { wait.finish() }
            DispatchQueue.global().asyncAfter(deadline: .now() + promptDeadline) {
                if wait.finish() { GenesisKit.log("permission prompt had no answer after \(Int(promptDeadline)) s") }
            }
        }
    }

    private static func probeAutomation() async -> PermissionStatus {
        await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                var errorInfo: NSDictionary?
                let script = NSAppleScript(source: "tell application \"System Events\" to get name")
                let result = script?.executeAndReturnError(&errorInfo)
                if let message = errorInfo?[NSAppleScript.errorMessage] as? String {
                    GenesisKit.log("permission automation probe: \(message)")
                }
                continuation.resume(returning: result != nil ? .granted : .denied)
            }
        }
    }

    private static func probeFolder(_ path: String) async -> PermissionStatus {
        await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                let readable = (try? FileManager.default.contentsOfDirectory(atPath: path)) != nil
                continuation.resume(returning: readable ? .granted : .denied)
            }
        }
    }
}

/// One continuation resumed exactly once, by the answer or by the deadline.
private final class PromptWait: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Void, Never>?
    private var finished = false

    func arm(_ continuation: CheckedContinuation<Void, Never>) {
        lock.lock()
        self.continuation = continuation
        lock.unlock()
    }

    /// True for the call that resumed it.
    @discardableResult
    func finish() -> Bool {
        lock.lock()
        guard !finished else {
            lock.unlock()
            return false
        }

        finished = true
        let pending = continuation
        continuation = nil
        lock.unlock()
        pending?.resume()
        return true
    }
}

/// What every feature reads and requests through: the system, with the denial simulation applied on top.
public struct PermissionAccess: Sendable {
    /// The real system and the simulation in this app's defaults.
    public static let live = PermissionAccess(system: SystemPermissions(), simulation: { PermissionSimulation.current() })

    public let system: any PermissionSystem
    private let simulation: @Sendable () -> PermissionSimulation
    private let lifted = LiftedKinds()

    public init(system: any PermissionSystem, simulation: @escaping @Sendable () -> PermissionSimulation = { PermissionSimulation() }) {
        self.system = system
        self.simulation = simulation
    }

    /// The simulated mode for `kind`, nil when it reads the real grant.
    public func simulatedMode(_ kind: PermissionKind) -> PermissionSimulation.Mode? {
        lifted.contains(kind) ? nil : simulation().mode(for: kind)
    }

    public func status(_ kind: PermissionKind) -> PermissionStatus {
        if !lifted.contains(kind), let simulated = simulation().status(for: kind) { return simulated }
        return system.status(kind)
    }

    public func isGranted(_ kind: PermissionKind) -> Bool {
        status(kind).isGranted
    }

    /// What a new process would read under the simulation; nil when the kind is not simulated.
    public func simulatedFreshStatus(_ kind: PermissionKind) -> PermissionStatus? {
        lifted.contains(kind) ? nil : simulation().freshStatus(for: kind)
    }

    /// Asks macOS in place where it allows it. A simulated kind never reaches macOS: `:ask` is lifted for this
    /// process (as if the prompt had been answered) and a denied one stays denied.
    public func request(_ kind: PermissionKind) async -> PermissionStatus {
        switch simulatedMode(kind) {
        case .ask:
            lifted.insert(kind)
            GenesisKit.log("permission \(kind.rawValue) simulated prompt answered")
            return system.status(kind)
        case .denied, .stale:
            GenesisKit.log("permission \(kind.rawValue) request skipped: simulated denial")
            return status(kind)
        case nil:
            let result = await system.request(kind)
            GenesisKit.log("permission \(kind.rawValue) requested: \(result.wireValue)")
            return result
        }
    }

    @MainActor
    @discardableResult
    public func openSettings(_ kind: PermissionKind) -> Bool {
        system.openSettings(kind)
    }
}

private final class LiftedKinds: @unchecked Sendable {
    private let lock = NSLock()
    private var kinds: Set<PermissionKind> = []

    func contains(_ kind: PermissionKind) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return kinds.contains(kind)
    }

    func insert(_ kind: PermissionKind) {
        lock.lock()
        kinds.insert(kind)
        lock.unlock()
    }
}
