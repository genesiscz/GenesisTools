// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground/Genesis/apps/Genesis/Sources/Genesis/Focus/Activity/ActivityRecorder.swift at 2026-10-08T05:04:08+02:00 at commit hash 7bd89a24c79510fb90ab0c2a0701c1d085f2023e
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

    private let store: ActivityStore
    private let counter = InputCounter()
    private var settings: FocusSettings
    private var segmentId: Int64?
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
    private var terminateObserver: NSObjectProtocol?

    public static let historyLength = 24

    public static let pollSeconds: TimeInterval = 2
    /// Far above App Nap timer throttling, so only real sleep or suspension counts as unobserved.
    static let unobservedGapMs: Int64 = 60_000
    private var lastTickMs: Int64?

    public init(store: ActivityStore, settings: FocusSettings = FocusSettings(), liveServices: Bool = true,
                probeReader: (@Sendable (pid_t, String) -> AXFocusProbe.Result)? = nil) {
        self.store = store
        self.settings = settings
        self.liveServices = liveServices
        self.probeReader = probeReader ?? { AXFocusProbe.read(pid: $0, bundle: $1) }
        counter.onFlush = { [weak self] bucketMs, counts in
            // A flush from stop() runs on the main thread, right before the segment closes.
            // Persisting it in a later Task would find no open segment and drop the counts.
            if Thread.isMainThread {
                MainActor.assumeIsolated { self?.persistInput(bucketMs: bucketMs, counts: counts) }
            } else {
                Task { @MainActor in self?.persistInput(bucketMs: bucketMs, counts: counts) }
            }
        }
        counter.onGap = { [weak self] started, ended, reason in
            Task { @MainActor in
                self?.persist("input gap") { try self?.store.recordGap(startedMs: started, endedMs: ended, reason: reason) }
            }
        }
    }

    // MARK: - Lifecycle

    /// Records the stretch since the last thing on disk as a gap, then starts capturing.
    ///
    /// The app being closed is not an idle user and not an empty day: it is time nobody
    /// measured, and the ledger says so rather than leaving a hole the views would have to
    /// guess about.
    public func closeDowntime(launchedAt: Date = Date()) {
        guard remoteCommand == nil else { return }
        let launch = Int64(launchedAt.timeIntervalSince1970 * 1000)
        do {
            for segment in try store.openSegments() {
                try store.closeSegment(id: segment.id, at: segment.endedMs ?? segment.startedMs)
            }
            for gap in try store.gaps(from: 0, to: launch) where gap.endedMs == nil {
                try store.closeGap(id: gap.id, at: launch)
            }
            openGapId = nil
            guard var cursor = try store.lastRecordedMs(), launch - cursor >= 60_000 else { return }
            for gap in try store.gaps(from: cursor, to: launch) {
                if gap.startedMs - cursor >= 60_000 {
                    try store.recordGap(startedMs: cursor, endedMs: gap.startedMs, reason: "app_not_running")
                }
                cursor = max(cursor, min(gap.endedMs ?? launch, launch))
            }
            if launch - cursor >= 60_000 {
                try store.recordGap(startedMs: cursor, endedMs: launch, reason: "app_not_running")
            }
        } catch {
            FlowFocusLog.focus.error("capture recovery failed: \(error.localizedDescription)")
        }
    }

    public func start() {
        guard remoteCommand == nil else { return }
        guard !isCapturing else { return }
        guard settings.captureEnabled else { excludeCurrent(reason: "capture_off"); return }
        isCapturing = true
        invalidateProbes()
        closeOpenGap()
        guard liveServices else { return }
        _ = counter.start()
        NSWorkspace.shared.notificationCenter.addObserver(
            self, selector: #selector(appActivated(_:)),
            name: NSWorkspace.didActivateApplicationNotification, object: nil)
        let timer = Timer.scheduledTimer(withTimeInterval: Self.pollSeconds, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
        timer.tolerance = 0.5
        RunLoop.main.add(timer, forMode: .common)
        pollTimer = timer
        tick()
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
                    self.counter.stop()
                    let now = self.nowMs()
                    self.closeCurrentSegment(at: now)
                    if self.openGapId == nil {
                        self.openGapId = try? self.store.recordGap(startedMs: now, endedMs: nil,
                                                                   reason: "app_not_running")
                    }
                }
            }
    }

    public func stop() {
        invalidateProbes()
        if remoteCommand != nil {
            isCapturing = false
            return
        }
        guard isCapturing else { return }
        NSWorkspace.shared.notificationCenter.removeObserver(self)
        pollTimer?.invalidate()
        pollTimer = nil
        lastTickMs = nil
        counter.stop()
        closeCurrentSegment(at: nowMs())
        current = nil // as in pauseCapture: `start()` must open a fresh segment
        isCapturing = false
        if openGapId == nil {
            openGapId = persist("capture gap") { try store.recordGap(startedMs: nowMs(), endedMs: nil, reason: "capture_off") }
        }
    }

    public func apply(settings newValue: FocusSettings) {
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
        if let remoteCommand {
            do { remoteCommand("focus.capture.pause", try JSONEncoder().encode(date)) }
            catch { FlowFocusLog.focus.error("capture pause encoding failed: \(error.localizedDescription)") }
            return
        }
        invalidateProbes()
        pausedUntil = date
        // Stop first: its final flush is written against the segment that is still open.
        counter.stop()
        closeCurrentSegment(at: nowMs())
        // Nothing is current once the segment is closed. A stale snapshot would make the first
        // probe after the pause look like "same segment", and no segment would open until the
        // user switched windows; a phase change during the pause (`attach`) would reopen it.
        current = nil
        // A pause is recorded, so the range reads as "not measured" rather than "you did
        // nothing" when someone looks at it a week later.
        if openGapId == nil {
            openGapId = persist("capture gap") { try store.recordGap(startedMs: nowMs(), endedMs: nil, reason: "capture_paused") }
        }
    }

    public func resumeCapture() {
        if let remoteCommand { remoteCommand("focus.capture.resume", Data()); return }
        pausedUntil = nil
        closeOpenGap()
        guard isCapturing, liveServices else { return }
        _ = counter.start()
        tick()
    }

    /// False while a timed pause is still running. Once it has run out, capture comes back and
    /// the gap the pause opened is closed; left open, it would read as "not measured" up to
    /// now while capture was in fact running, and block the next pause from recording its own.
    public func resumeIfPauseExpired(now: Date = Date()) -> Bool {
        if remoteCommand != nil { return pausedUntil.map { now >= $0 } ?? true }
        guard let until = pausedUntil else { return true }
        if now < until { return false }
        pausedUntil = nil
        closeOpenGap()
        if isCapturing, liveServices { _ = counter.start() }
        return true
    }

    private func closeOpenGap() {
        guard let id = openGapId else { return }
        persist("gap close") { try store.closeGap(id: id, at: nowMs()) }
        openGapId = nil
    }

    /// The pomodoro engine calls this on every phase boundary: the current segment is split so
    /// no segment ever straddles two sessions.
    public func attach(sessionId newValue: Int64?) {
        guard remoteCommand == nil else { return }
        let now = nowMs()
        let snapshot = current
        closeCurrentSegment(at: now)
        sessionId = newValue
        sessionStartedMs = newValue == nil ? nil : now
        if newValue == nil { currentMix = [] }
        if let snapshot { openSegment(for: snapshot, at: now, idle: isIdle) }
    }

    // MARK: - Polling

    @objc private func appActivated(_ note: Notification) {
        invalidateProbes()
        tick()
    }

    private func tick() {
        guard isCapturing, liveServices else { return }
        guard resumeIfPauseExpired() else {
            lastTickMs = nil
            return
        }
        retryPendingCloses()
        counter.flush(now: Date().timeIntervalSince1970 * 1000)
        recordInputSample()
        recomputeMix()
        noteTick(at: nowMs())

        let idleSeconds = Self.idleSeconds()
        let nowIdle = idleSeconds >= Double(settings.idleThresholdSec)

        guard let app = NSWorkspace.shared.frontmostApplication,
              let bundle = app.bundleIdentifier
        else { return }
        let name = app.localizedName ?? bundle
        guard settings.records(bundle: bundle) else {
            excludeCurrent(reason: "excluded_app")
            return
        }

        requestProbe(pid: app.processIdentifier, bundle: bundle, appName: name, idle: nowIdle)
    }

    /// Ticks stop while the Mac sleeps. A silence far longer than the poll interval was never
    /// observed, so it ends the open segment where the last tick saw it instead of stretching it.
    func noteTick(at now: Int64) {
        if let last = lastTickMs, now - last > Self.unobservedGapMs {
            closeCurrentSegment(at: last)
            current = nil
            do { try store.recordGap(startedMs: last, endedMs: now, reason: "system_sleep") }
            catch { FlowFocusLog.focus.error("sleep gap record failed: \(error.localizedDescription)") }
        }
        lastTickMs = now
        // Provisional end, moved forward every tick. If the app dies here, the record stops
        // within one tick of the truth instead of running to "now" forever.
        if let id = segmentId { persist("segment touch") { try store.touchSegment(id: id, at: now) } }
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
            self.applyProbe(probe, bundle: bundle, appName: appName, settings: self.settings, idle: idle)
        }
    }

    private func excludeCurrent(reason: String) {
        invalidateProbes()
        counter.stop()
        closeCurrentSegment(at: nowMs())
        current = nil
        if openGapId == nil {
            openGapId = persist("capture gap") { try store.recordGap(startedMs: nowMs(), endedMs: nil, reason: reason) }
        }
    }

    /// Direct probe application also enforces privacy; test sources use the same persistence path.
    public func applyProbe(_ probe: AXFocusProbe.Result, bundle: String, appName: String,
                            settings: FocusSettings, idle: Bool) {
        guard remoteCommand == nil, pausedUntil == nil else { return }
        guard settings.captureEnabled else { excludeCurrent(reason: "capture_off"); return }
        guard settings.records(bundle: bundle) else { excludeCurrent(reason: "excluded_app"); return }
        if let raw = probe.url, let host = URL(string: raw)?.host, !settings.records(host: host) {
            excludeCurrent(reason: "excluded_host")
            return
        }
        let hadGap = openGapId != nil
        closeOpenGap()
        if hadGap, isCapturing, liveServices, pausedUntil == nil { _ = counter.start() }
        let parts = settings.urlParts(probe.url)
        let cmux = CmuxAttribution.parse(title: probe.title, bundle: bundle)
        let project = settings.project(cmuxSession: cmux.session, title: probe.title,
                                       host: probe.url.flatMap { URL(string: $0)?.host })
        let snapshot = FocusSnapshot(
            appBundle: bundle,
            appName: appName,
            windowTitle: settings.title(probe.title, appName: appName),
            urlHost: parts.host,
            urlPath: parts.path,
            cmuxSession: settings.titleMode == .appOnly ? nil : settings.title(cmux.session, appName: appName),
            cmuxPane: settings.titleMode == .appOnly ? nil : settings.title(cmux.pane, appName: appName),
            displayId: probe.displayId,
            project: project)

        let now = nowMs()
        let changedSegment = current.map { !$0.sameSegment(as: snapshot) } ?? true
        let changedIdle = idle != isIdle

        if changedSegment || changedIdle {
            closeCurrentSegment(at: now)
            isIdle = idle
            current = snapshot
            openSegment(for: snapshot, at: now, idle: idle)
        } else {
            current = snapshot
        }
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
    private func recomputeMix() {
        guard let started = sessionStartedMs else {
            if !currentMix.isEmpty { currentMix = [] }
            return
        }
        let mix = appMix(from: started, to: nowMs())
        if mix != currentMix { currentMix = mix }
    }

    // MARK: - Segment plumbing

    private func openSegment(for snapshot: FocusSnapshot, at ms: Int64, idle: Bool) {
        var segment = ActivityStore.Segment(
            startedMs: ms,
            appBundle: snapshot.appBundle,
            appName: snapshot.appName,
            windowTitle: snapshot.windowTitle)
        segment.sessionId = sessionId
        segment.urlHost = snapshot.urlHost
        segment.urlPath = snapshot.urlPath
        segment.cmuxSession = snapshot.cmuxSession
        segment.cmuxPane = snapshot.cmuxPane
        segment.displayId = snapshot.displayId
        segment.idle = idle
        segment.project = snapshot.project
        segmentId = persist("segment open") { try store.openSegment(segment) }
        segmentStartedMs = ms
    }

    private func closeCurrentSegment(at ms: Int64) {
        retryPendingCloses()
        guard let id = segmentId else { return }
        // The minute's input so far belongs to this segment: flush it before the next one opens, or it would be
        // filed under whatever segment is current when the minute ends.
        counter.flush(now: Double(ms), force: true)
        segmentId = nil
        do {
            try store.closeSegment(id: id, at: ms)
        } catch {
            pendingCloses[id] = ms
            FlowFocusLog.focus.error("segment \(id) close failed, retried on the next tick: \(error.localizedDescription)")
        }
    }

    private func persistInput(bucketMs: Int64, counts: ActivityStore.InputCounts) {
        guard let id = segmentId else { return }
        persist("input bucket") { try store.appendInput(bucketMs: bucketMs, segmentId: id, counts: counts) }
    }

    /// One key press into the live counter, for tests that drive `applyProbe` without an event tap.
    func recordKeyForTesting() {
        counter.recordForTesting(type: .keyDown)
    }

    private func retryPendingCloses() {
        for (id, ms) in pendingCloses {
            do {
                try store.closeSegment(id: id, at: ms)
                pendingCloses[id] = nil
            } catch {
                FlowFocusLog.focus.error("segment \(id) close retry failed: \(error.localizedDescription)")
            }
        }
    }

    /// A ledger write whose failure is logged with what it was, never swallowed; nil when it failed.
    @discardableResult
    private func persist<T>(_ what: String, _ write: () throws -> T) -> T? {
        do {
            return try write()
        } catch {
            FlowFocusLog.focus.error("focus ledger \(what) failed: \(error.localizedDescription)")
            return nil
        }
    }

    /// The HUD's live mix: which apps this stretch of time actually went to.
    public func appMix(from: Int64, to: Int64, limit: Int = 3) -> [AppShare] {
        guard let rows = try? store.segments(from: from, to: to) else { return [] }
        var totals: [String: (ms: Int64, bundleId: String)] = [:]
        let now = nowMs()
        for row in rows where !row.idle {
            let start = max(row.startedMs, from)
            let end = min(row.endedMs ?? now, to)
            guard end > start else { continue }
            var entry = totals[row.appName] ?? (0, row.appBundle)
            entry.ms += end - start
            totals[row.appName] = entry
        }
        let sum = totals.values.reduce(Int64(0)) { $0 + $1.ms }
        guard sum > 0 else { return [] }
        return totals.sorted { $0.value.ms > $1.value.ms }.prefix(limit).map {
            AppShare(appName: $0.key, bundleId: $0.value.bundleId, ms: $0.value.ms,
                     share: Double($0.value.ms) / Double(sum))
        }
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
        return chromiumAddress(element: window, depth: 0)
    }

    private static func chromiumAddress(element: AXUIElement, depth: Int) -> String? {
        guard depth < 4 else { return nil }
        guard let children = copy(element, kAXChildrenAttribute) as? [AXUIElement] else { return nil }
        for child in children {
            let role = copy(child, kAXRoleAttribute) as? String
            if role == kAXTextFieldRole as String {
                if let value = copy(child, kAXValueAttribute) as? String, value.contains(".") {
                    return value.hasPrefix("http") ? value : "https://" + value
                }
            }
            if role == kAXToolbarRole as String || role == kAXGroupRole as String,
               let found = chromiumAddress(element: child, depth: depth + 1) {
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
