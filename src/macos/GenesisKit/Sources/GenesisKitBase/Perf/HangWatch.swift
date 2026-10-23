//
//  HangWatch.swift
//
//  Main-thread stall detector with a built-in stack capture. From Genesis UI/HangWatch.swift and
//  the GenesisTools copy (its userInitiated timer with a 10 ms leeway), 2026-09-30.
//
//  A background timer posts a ping block to the main queue every 250 ms and
//  measures how long it waits to run. Queue latency is the truth: a run-loop
//  Timer heartbeat (the first version) is coalesced by App Nap while Genesis
//  sits behind other apps, so an idle main thread read as a 1-2 s "stall".
//  A block on the main queue only runs late when the main thread is actually
//  busy or starved.
//
//  A loop that returns to the run loop between its passes never delays the ping, so the same watchdog also
//  reads the main thread's own CPU time: busy above 85% for 5 s is a "main-spin", sampled the same way (the
//  widget sat at 100% CPU for three minutes in a SwiftUI update loop and logged nothing, 2026-10-23 17:10).
//
//  Stalls > 0.5 s land in PerfLog (the app's perf file + unified log).
//  When one crosses 1 s the watchdog runs `sample` on this process and writes
//  the main-thread call graph to `<log folder>/hangs/<time>.txt`, so the
//  stack is on disk without anyone racing `sample Genesis 3` by hand (which
//  is how the 2026-08-28 Session Details hang had to be attributed).
//

import AppKit
import Foundation
import UserNotifications

public enum HangWatch {
    private static let lock = NSLock()
    /// Time the outstanding ping was posted; nil when none is waiting.
    private nonisolated(unsafe) static var pingPostedAt: CFAbsoluteTime?
    private nonisolated(unsafe) static var monitor: DispatchSourceTimer?
    private nonisolated(unsafe) static var lastSampleAt: CFAbsoluteTime = 0
    /// The sample is spawned once per stall.
    private nonisolated(unsafe) static var sampledThisStall = false
    private nonisolated(unsafe) static var lastOngoingLog: CFAbsoluteTime = 0
    /// One alert per stall, so a wedge does not post a notification a second.
    private nonisolated(unsafe) static var alertedThisStall = false
    /// Set by the test that must not raise a real user notification.
    public nonisolated(unsafe) static var onWedge: ((CFAbsoluteTime) -> Void)?
    /// Runs on the main thread when a main-spin begins (5 s above 85% CPU), after it is logged and sampled. A face can
    /// take down the view that spins: the widget collapses its open panel (2026-10-23, an inbox list that relaid itself
    /// out on every run-loop pass for minutes). The main queue still runs between the passes of such a loop.
    public nonisolated(unsafe) static var onSpin: (@MainActor @Sendable (CFAbsoluteTime) -> Void)?

    /// The main thread's port, read from the watchdog's queue for its CPU time.
    private nonisolated(unsafe) static var mainThread: thread_act_t = 0
    /// Timer queue only (the timer's handler runs serially).
    private nonisolated(unsafe) static var spin = SpinTracker()
    private nonisolated(unsafe) static var lastCPU: (wall: CFAbsoluteTime, cpu: Double)?

    public static let stallThreshold: CFAbsoluteTime = 0.5
    public static let sampleThreshold: CFAbsoluteTime = 1.0
    /// Past this the main thread is not coming back on its own. The 2026-09-10
    /// wedge ran 79 MINUTES before anyone noticed, because the window keeps
    /// drawing its last frame and the app looks alive. Nothing here can run on
    /// the main thread, so the alert goes out from the watchdog's own queue.
    public static let wedgeThreshold: CFAbsoluteTime = 20
    /// One `sample` per 60 s at most: it costs ~1 s of a core and a MB on disk.
    public static let sampleCooldown: CFAbsoluteTime = 60
    public nonisolated(unsafe) static var hangsDirectory = PerfConfiguration.current.logDirectory
        .appendingPathComponent("hangs")
    /// Path of the last capture, for the test that blocks the main thread.
    public nonisolated(unsafe) static var lastCaptureFile: URL?
    /// Wall-clock time of the watchdog's last tick, and of the last wake it inferred. The tick's
    /// dispatch clock stops while the Mac sleeps, so a wall-clock gap far past its 250 ms period is a
    /// sleep, dark wakes included (those post no `didWakeNotification` to rely on).
    private nonisolated(unsafe) static var lastTickAt: CFAbsoluteTime = 0
    private nonisolated(unsafe) static var wokeAt: CFAbsoluteTime = 0
    /// Longer than any App Nap stretch of the 250 ms tick; the overnight gaps were 500-3600 s.
    public static let sleepGap: CFAbsoluteTime = 30
    /// 58 of 2026-09-26's 109 stalls (51.9 s of 101.5 s) came within 90 s of a wake, most of them
    /// the hourly dark wakes at ~xx:46 with the display off, when every monitor lane refreshes at once.
    public static let wakeWindow: CFAbsoluteTime = 120

    /// The stall line. `sinceWake` is set only inside `wakeWindow`, and `hidden` when no window of the
    /// process was on screen, so `perf-report.ts` can keep stalls nobody could see (a dark-wake storm,
    /// the windowless Genesis Markdown helper starved under App Nap) apart from ones someone sat through.
    public static func stallMark(ms: Double, load: Double, sinceWake: CFAbsoluteTime?, hidden: Bool = false) -> String {
        var line = String(format: "main-stall recovered after %.0fms load=%.1f", ms, load)
        if let sinceWake {
            line += String(format: " wake+%.0fs", sinceWake)
        }
        if hidden {
            line += " hidden"
        }
        return line
    }

    /// `force` lets a test run the watchdog although PerfLog is off under XCTest.
    @MainActor
    public static func start(force: Bool = false) {
        guard force || PerfLog.enabled, monitor == nil else { return }
        // userInitiated, not utility: at utility QoS the stall capture's 20 ms sleeps were coalesced to
        // ~120 ms, and a 1.5 s stall yielded 8 stacks.
        let timer = DispatchSource.makeTimerSource(queue: .global(qos: .userInitiated))
        // An explicit leeway: the default one lets App Nap push a tick of a background window by
        // ~0.5 s, and a 843 ms stall was first seen 2 ms before it ended (GenesisTools hub).
        timer.schedule(deadline: .now() + 1, repeating: 0.25, leeway: .milliseconds(10))
        mainThread = mach_thread_self()
        timer.setEventHandler {
            checkSpin()
            tick()
        }
        timer.resume()
        monitor = timer
        // `sample` attaches about a second in, so every Genesis capture on 2026-09-26 said
        // "recovered while this sample ran". This one reads the main thread's stack in process from
        // 150 ms into a stall and writes `stack-<time>.txt` beside the hang files.
        MainStackSampler.start(directory: hangsDirectory)
        // Wall clock keeps running through system sleep. A ping posted just
        // before the lid closed would otherwise be read as an hours-long
        // stall on wake; drop it on both edges.
        let center = NSWorkspace.shared.notificationCenter
        for name in [NSWorkspace.willSleepNotification, NSWorkspace.didWakeNotification] {
            center.addObserver(forName: name, object: nil, queue: nil) { _ in
                lock.lock()
                pingPostedAt = nil
                sampledThisStall = false
                alertedThisStall = false
                lock.unlock()
            }
        }
    }

    /// Every field below is read from the timer queue, the main queue and the
    /// workspace-notification queue, so the whole check-and-set runs under the
    /// lock. `captureStack` and `PerfLog` are called after the unlock.
    private static func tick() {
        let now = CFAbsoluteTimeGetCurrent()
        lock.lock()
        if lastTickAt > 0, now - lastTickAt > sleepGap {
            wokeAt = now
        }
        lastTickAt = now
        guard let postedAt = pingPostedAt else {
            lock.unlock()
            post(at: now)
            return
        }
        let gap = now - postedAt
        guard gap > stallThreshold else {
            lock.unlock()
            return
        }
        var shouldSample = false
        // A scripted run (`PerfContext.run`) keeps the in-process stack file but spawns no `sample`: about a
        // second of a core on an already loaded machine, a 200 KB file, and an empty call graph, because the
        // run exits right after its capture (four such files on 2026-10-10 21:22-21:59).
        if gap > sampleThreshold, !sampledThisStall, now - lastSampleAt > sampleCooldown, PerfContext.run == nil {
            sampledThisStall = true
            lastSampleAt = now
            shouldSample = true
        }
        // Every 5 s while the stall is young, then once a minute: the
        // 2026-09-03 wedge wrote 180 identical lines before the app was
        // killed, and the 181st says nothing the 2nd did not.
        var shouldLog = false
        let ongoingInterval: CFAbsoluteTime = gap > 60 ? 60 : 5
        if now - lastOngoingLog > ongoingInterval {
            lastOngoingLog = now
            shouldLog = true
        }
        var shouldAlert = false
        if gap > wedgeThreshold, !alertedThisStall {
            alertedThisStall = true
            shouldAlert = true
        }
        lock.unlock()

        if shouldSample { captureStack(stallSoFar: gap, reason: "main-stall") }
        if shouldLog { PerfLog.mark(String(format: "main-stall ongoing %.1fs load=%.1f", gap, PerfLog.loadAverage()) + PerfContext.describe()) }
        if shouldAlert { reportWedge(stallSoFar: gap) }
    }

    private static func post(at now: CFAbsoluteTime) {
        lock.lock()
        pingPostedAt = now
        lastOngoingLog = now
        lock.unlock()
        DispatchQueue.main.async {
            let ran = CFAbsoluteTimeGetCurrent()
            lock.lock()
            let postedAt = pingPostedAt
            pingPostedAt = nil
            sampledThisStall = false
            alertedThisStall = false
            let woke = wokeAt
            lock.unlock()
            guard let postedAt else { return }
            let ms = (ran - postedAt) * 1000
            if ms > stallThreshold * 1000 {
                let sinceWake = woke > 0 && ran - woke < wakeWindow ? ran - woke : nil
                // On the main queue here, so AppKit may be asked. No app object (a test) counts as seen.
                let hidden = MainActor.assumeIsolated { NSApp.map { !$0.occlusionState.contains(.visible) } ?? false }
                PerfLog.mark(stallMark(ms: ms, load: PerfLog.loadAverage(), sinceWake: sinceWake, hidden: hidden) + PerfContext.describe(now: ran))
            }
        }
    }

    /// Tell the user the app is wedged. A frozen main thread cannot draw an
    /// alert, show a menu-bar item or answer a click, so a local notification
    /// (delivered by the notification daemon, not by us) is the only channel
    /// left. The message names the capture so the stack is one click away.
    private static func reportWedge(stallSoFar: CFAbsoluteTime) {
        PerfLog.mark(String(format: "main-thread WEDGED for %.0fs — app will not respond", stallSoFar))
        if let onWedge {
            onWedge(stallSoFar)
            return
        }
        // Only the app's own bundles (Genesis also posts from its nested Genesis Markdown.app);
        // the test runner has none and no notification center to abort in.
        let config = PerfConfiguration.current
        guard let prefix = config.alertBundlePrefix, Bundle.main.bundleIdentifier?.hasPrefix(prefix) == true else { return }
        NotificationEngine.shared.post(EngineNotification(
            source: "hang",
            title: "\(config.appName) is not responding",
            body: String(
                format: "The main thread has been blocked for %.0f seconds. %@",
                stallSoFar,
                lastCaptureFile.map { "Stack: \(($0.path as NSString).abbreviatingWithTildeInPath)" }
                    ?? "No stack was captured."
            ),
            idPrefix: "genesis.hang",
            ledgerFields: ["stallSeconds": Int(stallSoFar)]
        ))
    }

    /// Test seam: the reporter without a 20 s real stall in front of it.
    public static func reportWedgeForTesting(stallSoFar: CFAbsoluteTime) {
        reportWedge(stallSoFar: stallSoFar)
    }

    /// `sample <pid> 2` from a utility thread. Only the main thread's call
    /// graph is kept; the rest of a full sample is idle worker threads.
    private static func captureStack(stallSoFar: CFAbsoluteTime, reason: String) {
        let stamp = Self.fileStamp.string(from: Date())
        let file = hangsDirectory.appendingPathComponent("hang-\(stamp).txt")
        lastCaptureFile = file
        try? FileManager.default.createDirectory(at: hangsDirectory, withIntermediateDirectories: true)
        PerfLog.mark(String(format: "%@ %.1fs so far — sampling to %@", reason, stallSoFar, file.lastPathComponent) + PerfContext.describe())
        // The ping this stall belongs to. `sample` attaches ~1 s after the
        // stall was noticed and then samples for 2 s, so a 1.2 s stall is over
        // before the first sample lands and the capture shows an idle main
        // thread. 5 of the 7 captures on 2026-09-03 were that: three minutes
        // reading `mach_msg` stacks for stalls that had already recovered.
        // Recording which ping was outstanding lets the trim say so in the file
        // instead of leaving the reader to work it out.
        lock.lock()
        let stallPing = pingPostedAt
        lock.unlock()
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/sample")
        process.arguments = [
            String(ProcessInfo.processInfo.processIdentifier), "2", "-mayDie",
            "-file", file.path,
        ]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        process.terminationHandler = { _ in
            lock.lock()
            let stillStalled = pingPostedAt == stallPing
            lock.unlock()
            trimToMainThread(file, stillStalled: stillStalled)
        }
        do {
            try process.run()
        } catch {
            PerfLog.mark("main-stall sample failed: \(error.localizedDescription)")
        }
    }

    /// Keep the header and the first thread (main) of the call graph; drop
    /// the per-thread sections after it and the binary image list.
    ///
    /// `stillStalled` is false when the main thread was served again while
    /// `sample` was running: the stack below is then an idle app, not the
    /// stall, and the header says so.
    public static func trimToMainThread(_ file: URL, stillStalled: Bool = true) {
        guard let text = try? String(contentsOf: file, encoding: .utf8) else { return }
        var kept: [Substring] = []
        if !stillStalled {
            kept.append(Substring(
                "NOTE: the main thread recovered while this sample ran — the stack below may be an idle app, not the stall."
            ))
        }
        var threadsSeen = 0
        for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
            if line.hasPrefix("    ") == true, line.dropFirst(4).first?.isNumber == true,
               line.contains("Thread_")
            {
                threadsSeen += 1
                if threadsSeen > 1 { break }
            }
            if line.hasPrefix("Binary Images:") { break }
            kept.append(line)
        }
        let trimmed = kept.joined(separator: "\n") + "\n"
        try? trimmed.write(to: file, atomically: true, encoding: .utf8)
    }

    // MARK: Spin

    /// Busy and quiet stretches of the main thread, one tick at a time. Pure, so a test can feed it shares.
    public struct SpinTracker {
        public enum Event: Equatable {
            case began(seconds: CFAbsoluteTime)
            case ended(seconds: CFAbsoluteTime)
        }

        public static let threshold: CFAbsoluteTime = 5
        public static let busyShare = 0.85
        private var since: CFAbsoluteTime?
        private var reported = false

        public init() {}

        /// `share` is the main thread's CPU over the last tick (1 = a whole core).
        public mutating func step(share: Double, now: CFAbsoluteTime) -> Event? {
            guard share >= Self.busyShare else {
                defer {
                    since = nil
                    reported = false
                }
                guard let since, reported else { return nil }
                return .ended(seconds: now - since)
            }
            let start = since ?? now
            since = start
            guard !reported, now - start >= Self.threshold else { return nil }
            reported = true
            return .began(seconds: now - start)
        }
    }

    /// A thread's user and system CPU time in seconds, or nil when the kernel refuses.
    static func cpuTime(of thread: thread_act_t) -> Double? {
        guard thread != 0 else { return nil }
        var info = thread_basic_info()
        var count = mach_msg_type_number_t(MemoryLayout<thread_basic_info_data_t>.size / MemoryLayout<integer_t>.size)
        let result = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                thread_info(thread, thread_flavor_t(THREAD_BASIC_INFO), $0, &count)
            }
        }
        guard result == KERN_SUCCESS else { return nil }
        return Double(info.user_time.seconds) + Double(info.user_time.microseconds) / 1_000_000
            + Double(info.system_time.seconds) + Double(info.system_time.microseconds) / 1_000_000
    }

    private static func checkSpin() {
        let now = CFAbsoluteTimeGetCurrent()
        guard let cpu = cpuTime(of: mainThread) else { return }
        defer { lastCPU = (now, cpu) }
        guard let last = lastCPU, now - last.wall > 0.05, now - last.wall < sleepGap else { return }
        let share = (cpu - last.cpu) / (now - last.wall)
        switch spin.step(share: share, now: now) {
        case let .began(seconds)?:
            PerfLog.mark(String(format: "main-spin %.0fs at %.0f%% cpu: the main thread never idles", seconds, share * 100)
                + PerfContext.describe())
            lock.lock()
            let sample = now - lastSampleAt > sampleCooldown && PerfContext.run == nil
            if sample { lastSampleAt = now }
            lock.unlock()
            if sample { captureStack(stallSoFar: seconds, reason: "main-spin") }
            // Which bodies the loop evaluates, for two seconds: one Bool read per body while off.
            let wasOn = RenderProbe.enabled
            let start = RenderProbe.snapshot()
            RenderProbe.enabled = true
            DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 2) {
                PerfLog.mark("main-spin bodies in 2s:" + RenderProbe.summary(since: start))
                if !wasOn { RenderProbe.enabled = false }
                // After the bodies are counted, so the recovery does not hide what the loop evaluated.
                if let onSpin {
                    DispatchQueue.main.async { MainActor.assumeIsolated { onSpin(seconds + 2) } }
                }
            }
        case let .ended(seconds)?:
            PerfLog.mark(String(format: "main-spin ended after %.0fs", seconds) + PerfContext.describe())
        case nil:
            break
        }
    }

    private static let fileStamp: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd-HHmmss"
        f.locale = Locale(identifier: "en_US_POSIX")
        return f
    }()
}
