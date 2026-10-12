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
    /// EventKit's write-only grant: events can be added but not read. Full Access is asked for through macOS's prompt
    /// once, and otherwise chosen in System Settings.
    static let addOnly = PermissionStatus.partial("Add Only")
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
            guard kind.systemPromptAsks(from: status(kind)) else { return status(kind) }
            await Self.waitForAnswer { done in AVCaptureDevice.requestAccess(for: .audio) { _ in done() } }
        case .speechRecognition:
            guard kind.systemPromptAsks(from: status(kind)) else { return status(kind) }
            await Self.waitForAnswer { done in SFSpeechRecognizer.requestAuthorization { _ in done() } }
        case .calendars:
            // An Add Only grant is asked for full access once, like an undetermined one. macOS may not show the prompt
            // again for an app that answered before; the answer then stays Add Only and the dialog sends the user to
            // System Settings (`PermissionDialogModel.declinedUpgrade`).
            guard kind.systemPromptAsks(from: status(kind)) else { return status(kind) }
            let store = EKEventStore()
            await Self.waitForAnswer { done in
                store.requestFullAccessToEvents { _, error in
                    if let error { GenesisKit.log("permission calendar request: \(error.localizedDescription)") }
                    done()
                }
            }
        case .reminders:
            guard kind.systemPromptAsks(from: status(kind)) else { return status(kind) }
            let store = EKEventStore()
            await Self.waitForAnswer { done in
                store.requestFullAccessToReminders { _, error in
                    if let error { GenesisKit.log("permission reminders request: \(error.localizedDescription)") }
                    done()
                }
            }
        case .contacts:
            guard kind.systemPromptAsks(from: status(kind)) else { return status(kind) }
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
        case .writeOnly: return .addOnly
        case .denied: return .denied
        case .restricted: return .restricted
        case .notDetermined: return .notDetermined
        default: return .unknown("status \(status.rawValue)")
        }
    }

    /// Runs `start`, then returns once it calls back or the deadline passes, whichever is first.
    private static func waitForAnswer(_ start: (@escaping @Sendable () -> Void) -> Void) async {
        let wait = PromptWait<Void>()
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            wait.arm(continuation)
            start { wait.finish(()) }
            DispatchQueue.global().asyncAfter(deadline: .now() + promptDeadline) {
                if wait.finish(()) { GenesisKit.log("permission prompt had no answer after \(Int(promptDeadline)) s") }
            }
        }
    }

    /// Runs a blocking probe off the main thread and returns its answer, or `.notDetermined` once `deadline` passes.
    /// The probe may sit behind a macOS prompt (Automation) or a TCC check (a folder) for as long as the user leaves
    /// it, so the dialog gets its answer by the deadline like every other request. The probe itself cannot be
    /// stopped, so `flights` keeps one per `key`: a "Check again" while it still runs waits for that one's answer
    /// (by its own deadline) instead of starting another blocking probe.
    static func probe(_ key: String, within deadline: TimeInterval, flights: ProbeFlights = .shared,
                      _ work: @escaping @Sendable () -> PermissionStatus) async -> PermissionStatus
    {
        let wait = PromptWait<PermissionStatus>()
        return await withCheckedContinuation { (continuation: CheckedContinuation<PermissionStatus, Never>) in
            wait.arm(continuation)
            if flights.join(key, wait) {
                DispatchQueue.global(qos: .userInitiated).async { flights.land(key, work()) }
            }
            DispatchQueue.global().asyncAfter(deadline: .now() + deadline) {
                if wait.finish(.notDetermined) { GenesisKit.log("permission probe had no answer after \(Int(deadline)) s") }
            }
        }
    }

    private static func probeAutomation() async -> PermissionStatus {
        await probe("automation", within: promptDeadline) {
            var errorInfo: NSDictionary?
            let script = NSAppleScript(source: "tell application \"System Events\" to get name")
            let result = script?.executeAndReturnError(&errorInfo)
            if let message = errorInfo?[NSAppleScript.errorMessage] as? String {
                GenesisKit.log("permission automation probe: \(message)")
            }
            return result != nil ? .granted : .denied
        }
    }

    private static func probeFolder(_ path: String) async -> PermissionStatus {
        await probe("folder:" + path, within: promptDeadline) {
            (try? FileManager.default.contentsOfDirectory(atPath: path)) != nil ? .granted : .denied
        }
    }
}

/// The blocking probes still running, one per resource, and who waits for each. A probe can outlive its caller's
/// deadline (an Automation prompt nobody answers), so a later request joins it rather than starting another: at most
/// one blocking work item per resource, however often "Check again" is pressed.
final class ProbeFlights: @unchecked Sendable {
    static let shared = ProbeFlights()
    private let lock = NSLock()
    private var waiting: [String: [PromptWait<PermissionStatus>]] = [:]

    /// Adds `wait` to `key`'s probe; true when none was running, so the caller starts it.
    func join(_ key: String, _ wait: PromptWait<PermissionStatus>) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        let starts = waiting[key] == nil
        // Waits that already answered by their deadline are dropped, so a stalled probe holds no growing list.
        waiting[key] = (waiting[key] ?? []).filter { !$0.isFinished } + [wait]
        return starts
    }

    /// The probe answered: every wait still open gets the answer, and the next request starts a new probe.
    func land(_ key: String, _ answer: PermissionStatus) {
        lock.lock()
        let waits = waiting.removeValue(forKey: key) ?? []
        lock.unlock()
        for wait in waits { wait.finish(answer) }
    }

    /// Probes still running; for tests.
    var running: Int {
        lock.lock()
        defer { lock.unlock() }
        return waiting.count
    }
}

/// One continuation resumed exactly once, by the answer or by the deadline.
final class PromptWait<Value: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Value, Never>?
    private var finished = false

    func arm(_ continuation: CheckedContinuation<Value, Never>) {
        lock.lock()
        self.continuation = continuation
        lock.unlock()
    }

    var isFinished: Bool {
        lock.lock()
        defer { lock.unlock() }
        return finished
    }

    /// True for the call that resumed it.
    @discardableResult
    func finish(_ value: Value) -> Bool {
        lock.lock()
        guard !finished else {
            lock.unlock()
            return false
        }

        finished = true
        let pending = continuation
        continuation = nil
        lock.unlock()
        pending?.resume(returning: value)
        return true
    }
}

extension PermissionKind {
    /// Whether macOS still shows its own prompt for this kind from `status`: an undetermined grant, or an Add Only
    /// Calendars or Reminders grant, which EventKit's full-access request upgrades with a prompt.
    public func systemPromptAsks(from status: PermissionStatus) -> Bool {
        guard requestStyle == .systemPrompt else { return false }
        if status == .notDetermined { return true }
        return status == .addOnly && (self == .calendars || self == .reminders)
    }
}

/// What every feature reads and requests through: the system, with the denial simulation applied on top.
public struct PermissionAccess: Sendable {
    /// The real system and the simulation in this app's defaults.
    public static let live = PermissionAccess(system: SystemPermissions(), simulation: { PermissionSimulation.current() })

    public let system: any PermissionSystem
    private let simulation: @Sendable () -> PermissionSimulation
    private let lifted = LiftedKinds()
    private let probed = ProbeAnswers()

    public init(system: any PermissionSystem, simulation: @escaping @Sendable () -> PermissionSimulation = { PermissionSimulation() }) {
        self.system = system
        self.simulation = simulation
    }

    /// The simulated mode for `kind`, nil when it reads the real grant.
    public func simulatedMode(_ kind: PermissionKind) -> PermissionSimulation.Mode? {
        let current = simulation()
        return lifted.contains(kind, under: current) ? nil : current.mode(for: kind)
    }

    /// A probe kind has no silent read, so after a probe answered it shows that answer in place of `.unknown`: macOS
    /// held it then, and a Settings change since shows at the next `recheck`.
    public func status(_ kind: PermissionKind) -> PermissionStatus {
        let current = simulation()
        if !lifted.contains(kind, under: current), let simulated = current.status(for: kind) { return simulated }
        let live = system.status(kind)
        if case .unknown = live, let answered = probed.answer(kind) { return answered }
        return live
    }

    public func isGranted(_ kind: PermissionKind) -> Bool {
        status(kind).isGranted
    }

    /// What a new process would read under the simulation; nil when the kind is not simulated.
    public func simulatedFreshStatus(_ kind: PermissionKind) -> PermissionStatus? {
        let current = simulation()
        return lifted.contains(kind, under: current) ? nil : current.freshStatus(for: kind)
    }

    /// Asks macOS in place where it allows it. A simulated kind never reaches macOS: `:ask` is lifted for this
    /// process (as if the prompt had been answered) and a denied one stays denied. A lift holds only under the
    /// simulation it answered: once the defaults change (`staging.ts allow`, `deny`, `ask`), the kind reads the new
    /// simulation, the way a running face reads every other change, with no relaunch.
    public func request(_ kind: PermissionKind) async -> PermissionStatus {
        let current = simulation()
        switch lifted.contains(kind, under: current) ? nil : current.mode(for: kind) {
        case .ask:
            lifted.insert(kind, under: current)
            GenesisKit.log("permission \(kind.rawValue) simulated prompt answered")
            return system.status(kind)
        case .denied, .stale:
            GenesisKit.log("permission \(kind.rawValue) request skipped: simulated denial")
            return status(kind)
        case nil:
            let result = await system.request(kind)
            probed.remember(result, for: kind)
            GenesisKit.log("permission \(kind.rawValue) requested: \(result.wireValue)")
            return result
        }
    }

    /// Reads a probe kind's grant again for a dialog waiting on System Settings. The probe touches the resource, which
    /// prompts only while macOS has not answered, so it runs only after an earlier probe got an answer. A kind still
    /// waiting for its first answer starts no probe and keeps its status, and so does a probe macOS does not answer by
    /// its deadline: the last answer stands.
    public func recheck(_ kind: PermissionKind) async -> PermissionStatus {
        guard kind.requestStyle == .probe, simulatedMode(kind) == nil, probed.answer(kind) != nil else {
            return status(kind)
        }

        let result = await request(kind)
        return result == .notDetermined ? status(kind) : result
    }

    /// Probes again every probe kind whose last answer was a grant. Nothing else notices a grant revoked in System
    /// Settings: `status` keeps showing the remembered answer. macOS has answered those kinds, so the probe never
    /// prompts; one it does not answer by its deadline leaves the grant standing.
    public func recheckGrantedProbes() async {
        for kind in PermissionKind.allCases where kind.requestStyle == .probe && probed.answer(kind) == .granted {
            _ = await recheck(kind)
        }
    }

    @MainActor
    @discardableResult
    public func openSettings(_ kind: PermissionKind) -> Bool {
        system.openSettings(kind)
    }
}

/// Kinds whose simulated prompt was answered, each with the simulation it answered.
private final class LiftedKinds: @unchecked Sendable {
    private let lock = NSLock()
    private var kinds: [PermissionKind: PermissionSimulation] = [:]

    /// True while the simulation is the one the prompt answered; a changed simulation drops the answer.
    func contains(_ kind: PermissionKind, under simulation: PermissionSimulation) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard let answered = kinds[kind] else { return false }
        if answered == simulation { return true }
        kinds[kind] = nil
        return false
    }

    func insert(_ kind: PermissionKind, under simulation: PermissionSimulation) {
        lock.lock()
        kinds[kind] = simulation
        lock.unlock()
    }
}

/// What macOS last answered to the probe of each probe kind (Automation, the three folders).
private final class ProbeAnswers: @unchecked Sendable {
    private let lock = NSLock()
    private var answers: [PermissionKind: PermissionStatus] = [:]

    func answer(_ kind: PermissionKind) -> PermissionStatus? {
        lock.lock()
        defer { lock.unlock() }
        return answers[kind]
    }

    /// Keeps a grant or a refusal. A probe macOS did not answer by its deadline reads `.notDetermined` and leaves the
    /// last answer standing.
    func remember(_ answer: PermissionStatus, for kind: PermissionKind) {
        guard kind.requestStyle == .probe, answer == .granted || answer == .denied else { return }
        lock.lock()
        answers[kind] = answer
        lock.unlock()
    }
}
