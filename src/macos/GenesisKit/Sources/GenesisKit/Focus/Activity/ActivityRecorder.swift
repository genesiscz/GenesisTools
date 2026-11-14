import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

/// Spec 22 (S6) T2 — the continuous ledger of what the desktop was doing.
///
/// One segment = one contiguous stretch of a single (app, window, url) triple. Segments close on
/// focus change, on idle, at a phase boundary and at midnight, so their durations sum to wall
/// clock. Everything it writes goes through `ActivityStore`; everything it reads comes from
/// `NSWorkspace`, the Accessibility API and the idle clock.
///
/// AX reads run off the main thread with a messaging timeout, because a hung app must cost a
/// null title, never a frozen UI.
@MainActor
public final class ActivityRecorder: ObservableObject {
    /// What the desktop looks like right now, after the privacy policy has been applied.
    public struct FocusSnapshot: Codable, Equatable {
        public var appBundle: String
        public var appName: String
        public var windowTitle: String?
        public var urlHost: String?
        public var urlPath: String?
        public var cmuxSession: String?
        public var cmuxPane: String?
        public var displayId: Int64?
        public var project: String? = nil

        /// Two snapshots are the same *segment* when the triple matches. Anything else is a
        /// switch, and switches are what the breakdown counts.
        public func sameSegment(as other: FocusSnapshot) -> Bool {
            appBundle == other.appBundle && windowTitle == other.windowTitle
                && urlHost == other.urlHost && urlPath == other.urlPath && project == other.project
        }
    }

    @Published public private(set) var isCapturing = false
    @Published public private(set) var isIdle = false
    @Published public private(set) var current: FocusSnapshot?
    /// Set when capture is paused, so the HUD can show the badge instead of pretending.
    @Published public private(set) var pausedUntil: Date?
    /// Keystrokes per poll tick, newest last, capped. The HUD sparkline reads this instead of
    /// running its own timer — one source of truth, one wakeup.
    @Published public private(set) var inputHistory: [Int] = []
    /// The app mix of the running phase, recomputed once per tick. The HUD reads this instead
    /// of querying the store from its body, which would re-run on every invalidation.
    @Published public private(set) var currentMix: [AppShare] = []

    /// One app's share of the current phase.
    public struct AppShare: Codable, Identifiable, Equatable {
        public let appName: String
        public let bundleId: String?
        public let ms: Int64
        public let share: Double
        public var id: String { appName }
    }

    var remoteCommand: ((String, Data) -> Void)?

    var liveSnapshot: FocusRecorderSnapshot {
        FocusRecorderSnapshot(isCapturing: isCapturing, isIdle: isIdle, current: current,
                              pausedUntil: pausedUntil, inputHistory: inputHistory, currentMix: currentMix)
    }

    func applyRemote(_ snapshot: FocusRecorderSnapshot) {
        guard remoteCommand != nil else { return }
        if isCapturing != snapshot.isCapturing { isCapturing = snapshot.isCapturing }
        if isIdle != snapshot.isIdle { isIdle = snapshot.isIdle }
        if current != snapshot.current { current = snapshot.current }
        if pausedUntil != snapshot.pausedUntil { pausedUntil = snapshot.pausedUntil }
        if inputHistory != snapshot.inputHistory { inputHistory = snapshot.inputHistory }
        if currentMix != snapshot.currentMix { currentMix = snapshot.currentMix }
    }

    private final class PendingDestination { var segment: Int64? }
    private enum InputTarget { case segment(Int64), attaching(PendingDestination) }
    private final class InputDestination: @unchecked Sendable {
        private let lock = NSLock()
        private var value: InputTarget?
        private var deliveries = 0
        var hasPendingDeliveries: Bool { lock.lock(); defer { lock.unlock() }; return deliveries > 0 }
        private var waiters: [CheckedContinuation<Void, Never>] = []
        func beginDelivery() { lock.lock(); deliveries += 1; lock.unlock() }
        func endDelivery() {
            lock.lock()
            deliveries -= 1
            let ready = deliveries == 0 ? waiters : []
            if deliveries == 0 { waiters = [] }
            lock.unlock()
            for waiter in ready { waiter.resume() }
        }
        func waitForDeliveries() async {
            await withCheckedContinuation { continuation in
                lock.lock()
                if deliveries == 0 { lock.unlock(); continuation.resume() }
                else { waiters.append(continuation); lock.unlock() }
            }
        }
        func get() -> InputTarget? { lock.lock(); defer { lock.unlock() }; return value }
        func set(_ value: InputTarget?) { lock.lock(); self.value = value; lock.unlock() }
    }
    private struct InputWrite {
        let bucket: Int64
        let segment: Int64
        let counts: ActivityStore.InputCounts
    }
    private enum CaptureTransition {
        case pause(Date), resume, attach(Int64?), start, stop, exclude(String), poll, expirePause(Date)
        case probe(AXFocusProbe.Result, String, String, FocusSettings, Bool)
        case noteTick(Int64), forgotten(Int64, Int64), downtime(Date), barrier
        case generatedProbe(AXFocusProbe.Result, String, String, Bool, UInt64)
    }
    private enum MainOnlyRequest { case settings(FocusSettings), permission, forgetEnded(DeletionFence) }
    private enum Request {
        case ui(MainOnlyRequest)
        case transition(CaptureTransition, CheckedContinuation<Void, Never>?)
        case input(Int64, ActivityStore.InputCounts, InputTarget?)
        case gap(Int64, Int64, String)
    }
    private let inputDestination = InputDestination()
    private var requests: [Request] = []
    private var performing = false
    var hasPendingPersistence: Bool {
        performing || !requests.isEmpty || counter.hasPendingEmissions || inputDestination.hasPendingDeliveries
    }
    private var replayingUI = false
    private var collectedInput: [InputWrite]?
    private var pendingInput: [InputWrite] = []

    private let store: ActivityStore
    private let counter = InputCounter()
    /// Where a missing Accessibility grant goes: the GenesisKit permission dialog, once per process after "Not now".
    var permissionPresenter: @MainActor (PermissionNeed) -> Void = { PermissionCenter.shared.require($0) }
    /// Starts the input tap; false when it could not. Replaced in tests, because a real tap needs the grants of the
    /// machine running them.
    var inputCounterStarter: (InputCounter) -> Bool = { $0.start() }
    var suspendingTransitionPrepared: (() -> Void)?
    var suspendingTransitionWillWait: (() -> Void)?
    var generatedProbeQueued: (() -> Void)?
    private var settings: FocusSettings
    private var segmentId: Int64? { didSet { inputDestination.set(segmentId.map(InputTarget.segment)) } }
    /// Segments whose close failed (SQLite busy, a write error), with the end they should get. Retried on every
    /// tick and before the next close, so a row is never left open while a newer one claims the capture.
    private var pendingCloses: [Int64: Int64] = [:]
    private var segmentStartedMs: Int64 = 0
    private var pollTimer: Timer?
    private var sessionId: Int64?
    private let probeQueue = DispatchQueue(label: "dev.genesis.activity-probe", qos: .utility)
    private var probing = false
    private var probeGeneration: UInt64 = 0
    private let liveServices: Bool
    private let probeReader: @Sendable (pid_t, String) -> AXFocusProbe.Result
    private var lastKeyCount = 0
    private var sessionStartedMs: Int64?
    private var openGapId: Int64?
    /// Why the open gap was opened. A resume closes only a pause gap, and a start only a capture-off gap, so one
    /// cannot end the other while its own cause still holds.
    private var openGapReason: String?
    private var terminateObserver: NSObjectProtocol?

    public static let historyLength = 24

    public static let pollSeconds: TimeInterval = 2
    /// Far above App Nap timer throttling, so only real sleep or suspension counts as unobserved.
    nonisolated static let unobservedGapMs: Int64 = 60_000
    private var lastTickMs: Int64?

    public init(store: ActivityStore, settings: FocusSettings = FocusSettings(), liveServices: Bool = true,
                probeReader: (@Sendable (pid_t, String) -> AXFocusProbe.Result)? = nil) {
        self.store = store
        self.settings = settings
        self.liveServices = liveServices
        self.probeReader = probeReader ?? { AXFocusProbe.read(pid: $0, bundle: $1) }
        let destination = inputDestination
        counter.onFlush = { [weak self, destination] bucketMs, counts in
            let target = destination.get()
            // Attribute when the counter flushes, before a phase boundary can change the destination. A final flush
            // joins that boundary's batch; a timer flush carries its destination to the queued write.
            if Thread.isMainThread {
                MainActor.assumeIsolated { self?.persistInput(bucketMs: bucketMs, counts: counts, target: target) }
            } else if let recorder = self {
                destination.beginDelivery()
                Task { @MainActor in
                    recorder.persistInput(bucketMs: bucketMs, counts: counts, target: target)
                    destination.endDelivery()
                }
            }
        }
        counter.onGap = { [weak self, destination] started, ended, reason in
            guard let recorder = self else { return }
            destination.beginDelivery()
            Task { @MainActor in
                recorder.requests.append(.gap(started, ended, reason))
                recorder.runNextRequest()
                destination.endDelivery()
            }
        }
    }

    private struct CaptureState {
        var segment: Int64?
        var pendingCloses: [Int64: Int64]
        var segmentStarted: Int64
        var session: Int64?
        var sessionStarted: Int64?
        var gap: Int64?
        var gapReason: String?
        var inputs: [InputWrite]
        var paused: Date?
        var current: FocusSnapshot?
        var idle: Bool
        var capturing: Bool
        var lastTick: Int64?
        var mix: [AppShare]

        mutating func flushInput(store: ActivityStore) {
            inputs = inputs.filter { write in
                do { try store.appendInput(bucketMs: write.bucket, segmentId: write.segment, counts: write.counts); return false }
                catch { FlowFocusLog.focus.error("input bucket write failed; retained for retry: \(error.localizedDescription)"); return true }
            }
        }
        mutating func retryCloses(store: ActivityStore) {
            for (id, end) in pendingCloses {
                do { try store.closeSegment(id: id, at: end); pendingCloses[id] = nil }
                catch { FlowFocusLog.focus.error("segment \(id) close retry failed: \(error.localizedDescription)") }
            }
        }
        mutating func closeSegment(store: ActivityStore, at ms: Int64) {
            retryCloses(store: store)
            guard let id = segment else { return }
            segment = nil
            do { try store.closeSegment(id: id, at: ms) }
            catch { pendingCloses[id] = ms; FlowFocusLog.focus.error("segment \(id) close failed; retained for retry: \(error.localizedDescription)") }
        }
        mutating func openSegment(store: ActivityStore, snapshot: FocusSnapshot, at ms: Int64, idle: Bool) {
            var row = ActivityStore.Segment(startedMs: ms, appBundle: snapshot.appBundle, appName: snapshot.appName, windowTitle: snapshot.windowTitle)
            row.sessionId = session
            row.urlHost = snapshot.urlHost
            row.urlPath = snapshot.urlPath
            row.cmuxSession = snapshot.cmuxSession
            row.cmuxPane = snapshot.cmuxPane
            row.displayId = snapshot.displayId
            row.idle = idle
            row.project = snapshot.project
            do { segment = try store.openSegment(row) }
            catch { segment = nil; FlowFocusLog.focus.error("segment open failed: \(error.localizedDescription)") }
            segmentStarted = ms
        }
        mutating func noteTick(store: ActivityStore, at now: Int64) {
            if let last = lastTick, now - last > ActivityRecorder.unobservedGapMs {
                closeSegment(store: store, at: last)
                current = nil
                do { try store.recordGap(startedMs: last, endedMs: now, reason: "system_sleep") }
                catch { FlowFocusLog.focus.error("sleep gap record failed: \(error.localizedDescription)") }
            }
            lastTick = now
            if let segment {
                do { try store.touchSegment(id: segment, at: now) }
                catch { FlowFocusLog.focus.error("focus ledger segment touch failed: \(error.localizedDescription)") }
            }
        }
        mutating func reconcileForget(store: ActivityStore, from: Int64, to: Int64) {
            if let id = gap {
                do { gap = try store.openGapAfterForget(id: id, to: to); if gap == nil { gapReason = nil } }
                catch { FlowFocusLog.focus.error("capture gap not reread after deletion: \(error.localizedDescription)") }
            }
            guard let id = segment else { return }
            do {
                if let started = try store.segmentStartedMs(id: id) { segmentStarted = started } else { segment = nil }
            } catch {
                FlowFocusLog.focus.error("segment not reread after deletion: \(error.localizedDescription)")
                if segmentStarted >= from, segmentStarted < to { segment = nil }
                else if segmentStarted < from { segmentStarted = to }
            }
        }
        mutating func recoverDowntime(store: ActivityStore, launch: Int64) {
            do {
                for row in try store.openSegments() { try store.closeSegment(id: row.id, at: row.endedMs ?? row.startedMs) }
                var keptPause: Int64?
                for row in try store.gaps(from: 0, to: launch + 1) where row.endedMs == nil {
                    if row.reason == "capture_paused", let until = try store.gapUntil(id: row.id) {
                        if until > launch { keptPause = row.id; paused = Date(timeIntervalSince1970: Double(until) / 1000); continue }
                        try store.closeGap(id: row.id, at: max(row.startedMs, until))
                    } else { try store.closeGap(id: row.id, at: launch) }
                }
                gap = keptPause
                gapReason = keptPause == nil ? nil : "capture_paused"
                guard var cursor = try store.lastRecordedMs(), launch - cursor >= 60_000 else { return }
                for row in try store.gaps(from: cursor, to: launch) {
                    if row.startedMs - cursor >= 60_000 { try store.recordGap(startedMs: cursor, endedMs: row.startedMs, reason: "app_not_running") }
                    cursor = max(cursor, min(row.endedMs ?? launch, launch))
                }
                if launch - cursor >= 60_000 { try store.recordGap(startedMs: cursor, endedMs: launch, reason: "app_not_running") }
            } catch { FlowFocusLog.focus.error("capture recovery failed: \(error.localizedDescription)") }
        }
        static func appMix(rows: [ActivityStore.Segment], from: Int64, to: Int64, now: Int64, limit: Int) -> [AppShare] {
            var totals: [String: (ms: Int64, bundleId: String)] = [:]
            for row in rows where !row.idle {
                let start = max(row.startedMs, from), end = min(row.endedMs ?? now, to)
                guard end > start else { continue }
                var entry = totals[row.appName] ?? (0, row.appBundle)
                entry.ms += end - start
                totals[row.appName] = entry
            }
            let sum = totals.values.reduce(Int64(0)) { $0 + $1.ms }
            guard sum > 0 else { return [] }
            return totals.sorted { $0.value.ms > $1.value.ms }.prefix(limit).map {
                AppShare(appName: $0.key, bundleId: $0.value.bundleId, ms: $0.value.ms, share: Double($0.value.ms) / Double(sum))
            }
        }
        mutating func openGap(store: ActivityStore, reason: String, at ms: Int64, until: Int64? = nil) {
            guard gap == nil else { return }
            do { gap = try store.recordGap(startedMs: ms, endedMs: nil, reason: reason, untilMs: until); gapReason = reason }
            catch { FlowFocusLog.focus.error("capture gap failed: \(error.localizedDescription)") }
        }
        mutating func closeGap(store: ActivityStore, at ms: Int64, only reasons: Set<String>? = nil) {
            guard let id = gap else { return }
            if let reasons, let gapReason, !reasons.contains(gapReason) { return }
            do { try store.closeGap(id: id, at: ms); gap = nil; gapReason = nil }
            catch { FlowFocusLog.focus.error("capture gap close failed; retained for retry: \(error.localizedDescription)") }
        }
    }

    private var captureState: CaptureState {
        CaptureState(segment: segmentId, pendingCloses: pendingCloses, segmentStarted: segmentStartedMs,
                     session: sessionId, sessionStarted: sessionStartedMs, gap: openGapId, gapReason: openGapReason,
                     inputs: pendingInput.filter { inputAllowed($0.bucket) }, paused: pausedUntil, current: current,
                     idle: isIdle, capturing: isCapturing, lastTick: lastTickMs, mix: currentMix)
    }
    private func applyCaptureState(_ state: CaptureState) {
        segmentId = state.segment
        pendingCloses = state.pendingCloses
        segmentStartedMs = state.segmentStarted
        sessionId = state.session
        sessionStartedMs = state.sessionStarted
        openGapId = state.gap
        openGapReason = state.gapReason
        pendingInput = state.inputs.filter { inputAllowed($0.bucket) }
        if pausedUntil != state.paused { pausedUntil = state.paused }
        if current != state.current { current = state.current }
        if isIdle != state.idle { isIdle = state.idle }
        if isCapturing != state.capturing { isCapturing = state.capturing }
        lastTickMs = state.lastTick
        if currentMix != state.mix { currentMix = state.mix }
    }
    private func inputAllowed(_ bucket: Int64) -> Bool {
        !forgottenRanges.contains { bucket >= $0.from && bucket < $0.to }
            && !runningDeletions.values.contains { bucket >= $0.from && bucket < $0.to }
    }

    private func prepareTransition(_ requested: CaptureTransition) -> (work: (ActivityStore) -> CaptureState, destination: PendingDestination?, transition: CaptureTransition) {
        var transition = requested
        if case .generatedProbe(let probe, let bundle, let name, let idle, let generation) = requested {
            if generation == probeGeneration, isCapturing, settings.captureEnabled, pausedUntil == nil {
                transition = .probe(probe, bundle, name, settings, idle)
            } else { transition = .barrier }
        }
        let now = nowMs()
        let snapshot = current
        let idle = isIdle
        var destination: PendingDestination?
        var nextProbe: FocusSnapshot?
        var probeChanged = false
        collectedInput = []
        switch transition {
        case .start:
            if isCapturing { transition = .barrier }
            else if !settings.captureEnabled { transition = .exclude("capture_off") }
            else { isCapturing = true; invalidateProbes() }
        case .stop:
            if !isCapturing { transition = .barrier }
            else {
                invalidateProbes()
                NSWorkspace.shared.notificationCenter.removeObserver(self)
                pollTimer?.invalidate()
                pollTimer = nil
                lastTickMs = nil
                counter.stop()
                counter.flush(now: Double(now), force: true)
                current = nil
                isCapturing = false
                inputDestination.set(nil)
            }
        case .pause(let date):
            invalidateProbes()
            pausedUntil = date
            counter.stop()
            counter.flush(now: Double(now), force: true)
            current = nil
            inputDestination.set(nil)
        case .attach:
            invalidateProbes()
            counter.flush(now: Double(now), force: true)
            if snapshot != nil { destination = PendingDestination(); inputDestination.set(destination.map(InputTarget.attaching)) }
        case .resume: pausedUntil = nil
        case .probe(let probe, let bundle, let name, let policy, let newIdle):
            if pausedUntil != nil { transition = .barrier }
            else if !policy.captureEnabled { transition = .exclude("capture_off") }
            else if !policy.records(bundle: bundle) { transition = .exclude("excluded_app") }
            else if let host = probe.url.flatMap({ URL(string: $0)?.host }), !policy.records(host: host) { transition = .exclude("excluded_host") }
            else {
                let parts = policy.urlParts(probe.url)
                let cmux = CmuxAttribution.parse(title: probe.title, bundle: bundle)
                nextProbe = FocusSnapshot(appBundle: bundle, appName: name, windowTitle: policy.title(probe.title, appName: name),
                    urlHost: parts.host, urlPath: parts.path,
                    cmuxSession: policy.titleMode == .appOnly ? nil : policy.title(cmux.session, appName: name),
                    cmuxPane: policy.titleMode == .appOnly ? nil : policy.title(cmux.pane, appName: name), displayId: probe.displayId,
                    project: policy.project(cmuxSession: cmux.session, title: probe.title, host: probe.url.flatMap { URL(string: $0)?.host }))
                probeChanged = current.map { old in nextProbe.map { !old.sameSegment(as: $0) } ?? false } ?? true
                probeChanged = probeChanged || newIdle != isIdle || segmentId == nil
                if probeChanged {
                    counter.flush(now: Double(now), force: true)
                    destination = PendingDestination()
                    inputDestination.set(destination.map(InputTarget.attaching))
                }
            }
        case .poll:
            if !isCapturing || !liveServices { transition = .barrier }
            else if pausedUntil.map({ Date() < $0 }) != true {
                counter.flush(now: Double(now))
                recordInputSample()
            }
        case .exclude, .noteTick, .forgotten, .downtime, .expirePause, .generatedProbe, .barrier: break
        }
        if case .exclude = transition {
            invalidateProbes()
            counter.stop()
            counter.flush(now: Double(now), force: true)
            current = nil
            inputDestination.set(nil)
        }
        var state = captureState
        state.inputs += collectedInput ?? []
        collectedInput = nil
        let operation = transition
        return ({ store in
            state.flushInput(store: store)
            switch operation {
            case .start:
                if state.paused == nil { state.closeGap(store: store, at: now, only: ["capture_off", "app_not_running"]) }
            case .stop:
                state.closeSegment(store: store, at: now)
                state.openGap(store: store, reason: "capture_off", at: now)
            case .exclude(let reason):
                state.closeSegment(store: store, at: now)
                state.openGap(store: store, reason: reason, at: now)
            case .pause(let date):
                state.closeSegment(store: store, at: now)
                let until = Int64(date.timeIntervalSince1970 * 1000)
                if state.gapReason == "capture_paused", let gap = state.gap {
                    do { try store.setGapUntil(id: gap, untilMs: until) }
                    catch { FlowFocusLog.focus.error("capture pause deadline failed: \(error.localizedDescription)") }
                } else { state.openGap(store: store, reason: "capture_paused", at: now, until: until) }
            case .resume: state.closeGap(store: store, at: now, only: ["capture_paused"])
            case .expirePause(let date):
                if let until = state.paused, date >= until { state.paused = nil; state.closeGap(store: store, at: now, only: ["capture_paused"]) }
            case .attach(let session):
                state.closeSegment(store: store, at: now)
                state.session = session
                state.sessionStarted = session == nil ? nil : now
                if let snapshot { state.openSegment(store: store, snapshot: snapshot, at: now, idle: idle) }
            case .probe(_, _, _, _, let newIdle):
                state.closeGap(store: store, at: now)
                if let nextProbe {
                    if probeChanged { state.closeSegment(store: store, at: now); state.idle = newIdle; state.openSegment(store: store, snapshot: nextProbe, at: now, idle: newIdle) }
                    state.current = nextProbe
                }
            case .poll:
                if let until = state.paused {
                    if Int64(until.timeIntervalSince1970 * 1000) > now { state.lastTick = nil; return state }
                    state.paused = nil
                    state.closeGap(store: store, at: now, only: ["capture_paused"])
                }
                state.retryCloses(store: store)
                state.noteTick(store: store, at: now)
                if let from = state.sessionStarted {
                    do { state.mix = CaptureState.appMix(rows: try store.segments(from: from, to: now), from: from, to: now, now: now, limit: 3) }
                    catch { FlowFocusLog.focus.error("capture mix read failed: \(error.localizedDescription)") }
                } else { state.mix = [] }
            case .noteTick(let at): state.noteTick(store: store, at: at)
            case .forgotten(let from, let to): state.reconcileForget(store: store, from: from, to: to)
            case .downtime(let date): state.recoverDowntime(store: store, launch: Int64(date.timeIntervalSince1970 * 1000))
            case .generatedProbe, .barrier: break
            }
            return state
        }, destination, operation)
    }
    private func finishTransition(_ state: CaptureState, transition: CaptureTransition, destination: PendingDestination?) {
        let wasPaused = pausedUntil != nil
        let hadGap = openGapId != nil
        applyCaptureState(state)
        destination?.segment = state.segment
        switch transition {
        case .attach(let session): if session == nil { currentMix = [] }
        case .start:
            guard liveServices else { return }
            if pausedUntil == nil { startCounter() }
            NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(appActivated(_:)), name: NSWorkspace.didActivateApplicationNotification, object: nil)
            let timer = Timer.scheduledTimer(withTimeInterval: Self.pollSeconds, repeats: true) { [weak self] _ in Task { @MainActor in self?.tick() } }
            timer.tolerance = 0.5
            RunLoop.main.add(timer, forMode: .common)
            pollTimer = timer
            tick()
        case .resume:
            if isCapturing, liveServices, openGapId == nil { startCounter(); tick() }
        case .expirePause:
            if wasPaused, pausedUntil == nil, isCapturing, liveServices, openGapId == nil { startCounter() }
        case .poll:
            if wasPaused, pausedUntil == nil, isCapturing, liveServices, openGapId == nil { startCounter() }
            if pausedUntil == nil { requestLiveProbe() }
        case .probe:
            if hadGap, openGapId == nil, isCapturing, liveServices, pausedUntil == nil { startCounter() }
        default: break
        }
    }
    private func performSync(_ transition: CaptureTransition) {
        let prepared = prepareTransition(transition)
        finishTransition(prepared.work(store), transition: prepared.transition, destination: prepared.destination)
    }

    /// Queues a capture transition behind the persistence still pending, in order; false when nothing is pending,
    /// so the caller runs it now.
    private func deferTransition(_ transition: CaptureTransition) -> Bool {
        deferRequest(.transition(transition, nil))
    }

    /// `deferTransition` for a change that only the main actor applies (`replay`).
    private func deferUI(_ request: MainOnlyRequest) -> Bool {
        deferRequest(.ui(request))
    }

    private func deferRequest(_ request: Request) -> Bool {
        guard !replayingUI, hasPendingPersistence else { return false }
        requests.append(request)
        runNextRequest()
        return true
    }
    private func replay(_ operation: MainOnlyRequest) {
        switch operation {
        case .settings(let next):
            invalidateProbes()
            let wasEnabled = settings.captureEnabled
            settings = next
            if !next.captureEnabled, isCapturing { requests.insert(.transition(.stop, nil), at: 0) }
            else if next.captureEnabled, !wasEnabled { requests.insert(.transition(.start, nil), at: 0) }
        case .permission: accessibilityWasGranted()
        case .forgetEnded(let fence): runningDeletions[fence] = nil
        }
    }
    private func runNextRequest() {
        guard !performing, !replayingUI, !requests.isEmpty else { return }
        performing = true
        let request = requests.removeFirst()
        if case .ui(let operation) = request {
            let requiresSuspendingAccess = ActivityStore.suspendingAccessRequired
            DispatchQueue.main.async { [self] in
                ActivityStore.$suspendingAccessRequired.withValue(requiresSuspendingAccess) {
                    self.replayingUI = true
                    self.replay(operation)
                    self.replayingUI = false
                    self.performing = false
                    self.runNextRequest()
                }
            }
            return
        }
        Task { @MainActor in
            switch request {
            case .transition(let transition, let continuation):
                suspendingTransitionWillWait?()
                await counter.waitForEmissions()
                let prepared = prepareTransition(transition)
                suspendingTransitionPrepared?()
                do {
                    let state = try await store.perform(prepared.work)
                    finishTransition(state, transition: prepared.transition, destination: prepared.destination)
                } catch { FlowFocusLog.focus.error("capture transition failed: \(error.localizedDescription)") }
                continuation?.resume()
            case .input(let bucket, let counts, let target):
                var state = captureState
                let id: Int64?
                switch target {
                case .segment(let value): id = value
                case .attaching(let destination): id = destination.segment
                case nil: id = nil
                }
                if let id, inputAllowed(bucket) { state.inputs.append(InputWrite(bucket: bucket, segment: id, counts: counts)) }
                do {
                    let inputs = state.inputs
                    let failed = try await store.perform { store in
                        var written = state
                        written.inputs = inputs
                        written.flushInput(store: store)
                        return written.inputs
                    }
                    pendingInput = failed.filter { inputAllowed($0.bucket) }
                } catch { pendingInput = state.inputs; FlowFocusLog.focus.error("input persistence failed: \(error.localizedDescription)") }
            case .gap(let start, let end, let reason):
                do { try await store.perform { try $0.recordGap(startedMs: start, endedMs: end, reason: reason) } }
                catch { FlowFocusLog.focus.error("input gap failed: \(error.localizedDescription)") }
            case .ui: break
            }
            performing = false
            runNextRequest()
        }
    }
    private func enqueue(_ transition: CaptureTransition) async {
        await withCheckedContinuation { continuation in
            requests.append(.transition(transition, continuation))
            switch transition {
            case .generatedProbe, .probe: generatedProbeQueued?()
            default: break
            }
            runNextRequest()
        }
    }
    public func pauseCaptureAsync(until date: Date) async {
        if remoteCommand != nil { pauseCapture(until: date); return }
        await enqueue(.pause(date))
    }
    public func resumeCaptureAsync() async {
        if remoteCommand != nil { resumeCapture(); return }
        await enqueue(.resume)
    }
    public func attachAsync(sessionId: Int64?) async {
        guard remoteCommand == nil else { return }
        await enqueue(.attach(sessionId))
    }
    func waitForPersistence() async {
        await counter.waitForEmissions()
        await inputDestination.waitForDeliveries()
        await enqueue(.barrier)
    }

    // MARK: - Lifecycle

    /// Records the stretch since the last thing on disk as a gap, then starts capturing.
    ///
    /// The app being closed is not an idle user and not an empty day: it is time nobody
    /// measured, and the ledger says so rather than leaving a hole the views would have to
    /// guess about.
    public func closeDowntime(launchedAt: Date = Date()) {
        if deferTransition(.downtime(launchedAt)) { return }
        guard remoteCommand == nil else { return }
        performSync(.downtime(launchedAt))
    }

    public func start() {
        if deferTransition(.start) { return }
        guard remoteCommand == nil else { return }
        performSync(.start)
    }

    /// Ends the record cleanly on quit. Synchronous on the main queue on purpose: a nested Task
    /// may not run before the process exits (the same trap FocusOrchestrator documents).
    public func installTerminateHook() {
        guard remoteCommand == nil else { return }
        guard terminateObserver == nil else { return }
        terminateObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.willTerminateNotification, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    // Stop first: its forced flush writes the open minute of input against the
                    // segment that is still open, before the process exits.
                    self.collectedInput = []
                    self.counter.stop()
                    self.pendingInput += self.collectedInput ?? []
                    self.collectedInput = nil
                    let now = self.nowMs()
                    self.closeCurrentSegment(at: now)
                    self.openGap("app_not_running", at: now)
                }
            }
    }

    public func stop() {
        if deferTransition(.stop) { return }
        if remoteCommand != nil { isCapturing = false; return }
        performSync(.stop)
    }

    public func apply(settings newValue: FocusSettings) {
        if deferUI(.settings(newValue)) { return }
        if remoteCommand != nil { settings = newValue; return }
        invalidateProbes()
        let wasEnabled = settings.captureEnabled
        settings = newValue
        if !newValue.captureEnabled, isCapturing {
            stop()
        } else if newValue.captureEnabled, !wasEnabled {
            start()
        }
    }

    /// Pauses capture for a while. The current segment closes immediately — a paused recorder
    /// must never leave a segment open that later looks like hours of focus.
    public func pauseCapture(until date: Date) {
        if deferTransition(.pause(date)) { return }
        if let remoteCommand {
            do { remoteCommand("focus.capture.pause", try JSONEncoder().encode(date)) }
            catch { FlowFocusLog.focus.error("capture pause encoding failed: \(error.localizedDescription)") }
            return
        }
        performSync(.pause(date))
    }

    /// Counting key presses and clicks needs Accessibility. A missing grant opens the permission dialog (an
    /// automatic one: capture starts by itself) instead of leaving the counts silently empty.
    private func startCounter() {
        if inputCounterStarter(counter) { return }
        guard !PermissionAccess.live.isGranted(.accessibility) else {
            FlowFocusLog.focus.error("input counter tap could not start although Accessibility is granted")
            return
        }

        permissionPresenter(PermissionNeed(
            .accessibility,
            reason: "Focus counts key presses and clicks to measure how active you are. It never records what you type.",
            trigger: .automatic,
            onGranted: { [weak self] in self?.accessibilityWasGranted() }))
    }

    /// An open gap is a stop on purpose: an excluded app or site counts no input. The probe that closes it starts the
    /// counter (`applyProbe`), so a grant that arrives meanwhile must not.
    func accessibilityWasGranted() {
        if deferUI(.permission) { return }
        guard isCapturing, liveServices, pausedUntil == nil, openGapId == nil else { return }
        startCounter()
    }

    public func resumeCapture() {
        if deferTransition(.resume) { return }
        if let remoteCommand { remoteCommand("focus.capture.resume", Data()); return }
        performSync(.resume)
    }

    /// False while a timed pause is still running. Once it has run out, capture comes back and
    /// the gap the pause opened is closed; left open, it would read as "not measured" up to
    /// now while capture was in fact running, and block the next pause from recording its own.
    public func resumeIfPauseExpired(now: Date = Date()) -> Bool {
        if remoteCommand != nil { return pausedUntil.map { now >= $0 } ?? true }
        guard let until = pausedUntil else { return true }
        if now < until { return false }
        if performing || !requests.isEmpty {
            requests.append(.transition(.expirePause(now), nil))
            runNextRequest()
            return false
        }
        performSync(.expirePause(now))
        return pausedUntil == nil
    }

    private func openGap(_ reason: String, at ms: Int64, untilMs: Int64? = nil) {
        var state = captureState
        state.openGap(store: store, reason: reason, at: ms, until: untilMs)
        applyCaptureState(state)
    }

    /// `only`: close the open gap only when it was opened for one of these reasons.

    /// The pomodoro engine calls this on every phase boundary: the current segment is split so
    /// no segment ever straddles two sessions.
    public func attach(sessionId newValue: Int64?) {
        if deferTransition(.attach(newValue)) { return }
        guard remoteCommand == nil else { return }
        performSync(.attach(newValue))
    }

    // MARK: - Polling

    @objc private func appActivated(_ note: Notification) {
        invalidateProbes()
        tick()
    }

    private func tick() {
        guard isCapturing, liveServices else { return }
        guard !requests.contains(where: { if case .transition(.poll, _) = $0 { return true }; return false }) else { return }
        requests.append(.transition(.poll, nil))
        runNextRequest()
    }

    private func requestLiveProbe() {
        guard isCapturing, liveServices, pausedUntil == nil else { return }
        let idle = Self.idleSeconds() >= Double(settings.idleThresholdSec)
        guard let app = NSWorkspace.shared.frontmostApplication, let bundle = app.bundleIdentifier else { return }
        guard settings.records(bundle: bundle) else {
            requests.append(.transition(.exclude("excluded_app"), nil))
            runNextRequest()
            return
        }
        requestProbe(pid: app.processIdentifier, bundle: bundle, appName: app.localizedName ?? bundle, idle: idle)
    }

    /// Ticks stop while the Mac sleeps. A silence far longer than the poll interval was never
    /// observed, so it ends the open segment where the last tick saw it instead of stretching it.
    func noteTick(at now: Int64) {
        if deferTransition(.noteTick(now)) { return }
        performSync(.noteTick(now))
    }

    private func invalidateProbes() {
        probeGeneration &+= 1
        probing = false
    }

    @discardableResult
    func requestProbe(pid: pid_t, bundle: String, appName: String, idle: Bool) -> Task<Void, Never>? {
        guard isCapturing, pausedUntil == nil, !probing else { return nil }
        probing = true
        let generation = probeGeneration
        let reader = probeReader
        let queue = probeQueue
        return Task { @MainActor [weak self] in
            let probe = await withCheckedContinuation { continuation in
                queue.async { continuation.resume(returning: reader(pid, bundle)) }
            }
            guard let self, self.probeGeneration == generation else { return }
            self.probing = false
            guard self.isCapturing, self.pausedUntil == nil, self.settings.captureEnabled else { return }
            await self.enqueue(.generatedProbe(probe, bundle, appName, idle, generation))
        }
    }


    /// Direct probe application also enforces privacy; test sources use the same persistence path.
    public func applyProbe(_ probe: AXFocusProbe.Result, bundle: String, appName: String,
                            settings: FocusSettings, idle: Bool) {
        if deferTransition(.probe(probe, bundle, appName, settings, idle)) { return }
        guard remoteCommand == nil else { return }
        performSync(.probe(probe, bundle, appName, settings, idle))
    }

    /// One sample per tick. A flushed bucket resets the counter, so a negative delta means the
    /// minute rolled over, not that the user un-typed something.
    private func recordInputSample() {
        let keys = counter.snapshot().keys
        let delta = max(0, keys - lastKeyCount)
        lastKeyCount = keys
        inputHistory.append(delta)
        if inputHistory.count > Self.historyLength { inputHistory.removeFirst(inputHistory.count - Self.historyLength) }
    }

    /// @Published has no value-skip, so a 30 Hz-equivalent republish of an identical array would
    /// invalidate the HUD for nothing. Compare before assigning.

    // MARK: - Segment plumbing


    private func closeCurrentSegment(at ms: Int64) {
        collectedInput = []
        counter.flush(now: Double(ms), force: true)
        var state = captureState
        state.inputs += collectedInput ?? []
        collectedInput = nil
        state.flushInput(store: store)
        state.closeSegment(store: store, at: ms)
        applyCaptureState(state)
    }

    /// The ledger just forgot `from..<to` (`ActivityStore.forget`). A segment that started before the range keeps its
    /// row and id there and starts again where the range ends, so recording goes on in it. One that started inside
    /// the range is gone: its id is dropped, so the next probe opens a new segment instead of touching a missing row
    /// and filing input under it. Where the row starts now is read back from the ledger, so a later deletion that
    /// covers that new start drops it too. An open capture gap (a pause, an exclusion) that started before the range
    /// was closed where the range begins and goes on in a new row after it, with its reason and deadline: the
    /// recorder follows that row, so resuming closes it. The current minute's counts, counted inside the range, are
    /// discarded rather than written back after the deletion.
    public func ledgerForgot(from: Int64, to: Int64) {
        guard remoteCommand == nil, from < to else { return }
        fence(from: from, to: to)
        counter.discardPending(overlapping: from, to: to)
        if deferTransition(.forgotten(from, to)) { return }
        performSync(.forgotten(from, to))
    }

    /// The hold one running deletion has on the recorder's input (`ledgerForgetting`). Each deletion has its own, so
    /// one that fails lets go of nothing another deletion, or a committed one, holds.
    public struct DeletionFence: Hashable, Sendable {
        fileprivate let id = UUID()
    }

    /// A deletion of `from..<to` is starting (`FocusController.forgetOwned`, before it runs off the main actor). A
    /// minute that starts inside the range is forgotten while the deletion runs: counts the counter already flushed,
    /// still on their way here, and the rest of that minute are not written back. The hold lasts until
    /// `ledgerForgetEnded`. A deletion that commits is fenced for good by `ledgerForgot`; one the ledger refused
    /// deleted nothing, so its range records again. Nil when there is nothing to hold (a client, an empty range).
    @discardableResult
    public func ledgerForgetting(from: Int64, to: Int64) -> DeletionFence? {
        guard remoteCommand == nil, from < to else { return nil }
        let fence = DeletionFence()
        runningDeletions[fence] = (from, to)
        return fence
    }

    /// The deletion that took `fence` is over, committed or refused. Call it after `ledgerForgot` on a commit, so
    /// the range is never unfenced in between.
    public func ledgerForgetEnded(_ fence: DeletionFence) {
        if deferUI(.forgetEnded(fence)) { return }
        runningDeletions[fence] = nil
    }

    /// Ranges deleted since this recorder started; one per "Delete activity", so the list stays short.
    private var forgottenRanges: [(from: Int64, to: Int64)] = []
    /// Ranges whose deletion is running now; they leave this list when it ends.
    private var runningDeletions: [DeletionFence: (from: Int64, to: Int64)] = [:]

    private func fence(from: Int64, to: Int64) {
        guard !forgottenRanges.contains(where: { $0.from == from && $0.to == to }) else { return }
        forgottenRanges.append((from, to))
    }

    private func persistInput(bucketMs: Int64, counts: ActivityStore.InputCounts, target: InputTarget?) {
        // The ledger deletes a minute by its start, so a forgotten one is fenced by its start too.
        guard !forgottenRanges.contains(where: { bucketMs >= $0.from && bucketMs < $0.to }),
              !runningDeletions.values.contains(where: { bucketMs >= $0.from && bucketMs < $0.to }) else { return }
        if case .segment(let id) = target, collectedInput != nil {
            collectedInput?.append(InputWrite(bucket: bucketMs, segment: id, counts: counts))
            return
        }
        requests.append(.input(bucketMs, counts, target))
        runNextRequest()
    }

    /// One key press into the live counter, for tests that drive `applyProbe` without an event tap.
    func recordKeyForTesting() {
        counter.recordForTesting(type: .keyDown)
    }

    var counterEmissionExtractedForTesting: (() -> Void)? {
        get { counter.emissionExtractedForTesting }
        set { counter.emissionExtractedForTesting = newValue }
    }

    func flushOffMainAsynchronouslyForTesting() -> Task<Void, Never> {
        let counter = self.counter
        return Task.detached { counter.flush(now: Date().timeIntervalSince1970 * 1000, force: true) }
    }

    /// The counter's flush timer, off the main thread: the open minute's counts leave the counter there and reach
    /// `persistInput` through a task queued on the main actor. For tests.
    func flushOffMainForTesting() {
        let counter = self.counter
        let done = DispatchSemaphore(value: 0)
        DispatchQueue.global().async {
            counter.flush(now: Date().timeIntervalSince1970 * 1000, force: true)
            done.signal()
        }
        if done.wait(timeout: .now() + 10) == .timedOut {
            FlowFocusLog.focus.error("the off-main test flush did not finish within 10 s")
        }
    }



    /// The HUD's live mix: which apps this stretch of time actually went to.
    public func appMix(from: Int64, to: Int64, limit: Int = 3) -> [AppShare] {
        guard let rows = try? store.segments(from: from, to: to) else { return [] }
        return CaptureState.appMix(rows: rows, from: from, to: to, now: nowMs(), limit: limit)
    }

    /// Counts in the bucket still open, for the sparkline.
    public func liveInput() -> ActivityStore.InputCounts { counter.snapshot() }

    // MARK: - Clocks

    private func nowMs() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }

    public static func idleSeconds() -> Double {
        guard let any = CGEventType(rawValue: ~0) else { return 0 }
        return CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: any)
    }
}

// MARK: - AX probing

/// Reads the focused window of one process. Nonisolated on purpose: it runs on a utility queue
/// with a messaging timeout, so an app that stops answering costs a null title and nothing else.
public enum AXFocusProbe {
    public struct Result: Equatable, Sendable {
        public var title: String?
        public var url: String?
        public var displayId: Int64?
    }

    public static let messagingTimeout: Float = 0.25

    public static func read(pid: pid_t, bundle: String) -> Result {
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, messagingTimeout)
        guard let window = copy(app, kAXFocusedWindowAttribute) else { return Result() }
        let element = window as! AXUIElement // swiftlint:disable:this force_cast
        let title = copy(element, kAXTitleAttribute) as? String
        let url = FocusSettings.browserBundles.contains(bundle) ? browserURL(window: element, app: app) : nil
        return Result(title: title, url: url, displayId: displayId(of: element))
    }

    /// Safari and friends publish `AXDocument`; Chromium publishes the address field's value.
    /// Both are read-only reads of what is already on screen.
    private static func browserURL(window: AXUIElement, app: AXUIElement) -> String? {
        if let document = copy(window, kAXDocumentAttribute) as? String, !document.isEmpty {
            return document
        }
        var budget = ProbeBudget()
        return chromiumAddress(in: window, budget: &budget,
                               children: { copy($0, kAXChildrenAttribute) as? [AXUIElement] },
                               role: { copy($0, kAXRoleAttribute) as? String },
                               value: { copy($0, kAXValueAttribute) as? String })
    }

    /// The messaging timeout bounds one request, not a walk: a broad or slow browser tree could otherwise hold
    /// the serial probe queue for as long as it likes. Every attribute read spends from one budget of reads and
    /// wall time, and a spent budget means "no address" for this probe.
    struct ProbeBudget {
        var remainingReads: Int
        let deadline: ContinuousClock.Instant

        init(reads: Int = 200, seconds: Double = 0.4) {
            remainingReads = reads
            deadline = ContinuousClock.now + .milliseconds(Int(seconds * 1000))
        }

        mutating func spend() -> Bool {
            remainingReads -= 1
            return remainingReads >= 0 && ContinuousClock.now < deadline
        }
    }

    static func chromiumAddress<Node>(
        in element: Node,
        depth: Int = 0,
        budget: inout ProbeBudget,
        children: (Node) -> [Node]?,
        role: (Node) -> String?,
        value: (Node) -> String?
    ) -> String? {
        guard depth < 4, budget.spend(), let nodes = children(element) else { return nil }
        for child in nodes {
            guard budget.spend() else { return nil }
            let kind = role(child)
            if kind == kAXTextFieldRole as String {
                guard budget.spend() else { return nil }
                if let text = value(child), text.contains(".") {
                    return text.hasPrefix("http") ? text : "https://" + text
                }
            }
            if kind == kAXToolbarRole as String || kind == kAXGroupRole as String,
               let found = chromiumAddress(in: child, depth: depth + 1, budget: &budget,
                                           children: children, role: role, value: value) {
                return found
            }
        }
        return nil
    }

    private static func displayId(of window: AXUIElement) -> Int64? {
        guard let raw = copy(window, kAXPositionAttribute) else { return nil }
        var point = CGPoint.zero
        // swiftlint:disable:next force_cast
        AXValueGetValue(raw as! AXValue, .cgPoint, &point)
        for (index, screen) in NSScreen.screens.enumerated() where screen.frame.contains(point) {
            if let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber {
                return number.int64Value
            }
            return Int64(index)
        }
        return nil
    }

    private static func copy(_ element: AXUIElement, _ attribute: String) -> AnyObject? {
        var value: AnyObject?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else { return nil }
        return value
    }
}

// MARK: - cmux attribution

/// cmux window titles carry the session, which is the most reliable project signal on this
/// machine. Parsing the title is deliberate: it costs nothing and never shells out.
public enum CmuxAttribution {
    public static let bundles: Set<String> = ["com.cmuxterm.app"]

    public static func parse(title: String?, bundle: String) -> (session: String?, pane: String?) {
        guard bundles.contains(bundle), let title, !title.isEmpty else { return (nil, nil) }
        // Observed shapes: "restart-restart-◑ col-302921-pr-7402" and "session · pane".
        if let separator = title.range(of: " · ") {
            return (String(title[..<separator.lowerBound]), String(title[separator.upperBound...]))
        }
        return (title, nil)
    }
}
