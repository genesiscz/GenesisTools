import AppKit
import Foundation

/// `GenesisTools --link-relay`: a windowless face that never quits and is the OLDEST running instance of
/// the bundle. Launch Services hands a link, an `.html` file, a banner click and a Dock reopen to the
/// oldest registered instance and activates it before its handler runs (measured on macOS 26.3.1 in 14
/// runs; Apple does not document the rule). With the hub or a review window as the oldest, every
/// genesis.tools/md click raised that window over the app the click came from (2026-10-07). The relay
/// takes those deliveries instead: it has no window to raise, forwards each link to a fresh router
/// instance (BrowserURLForwarder.forward), and gives the focus back.
///
/// The relay is only older than a window face when it started first, so every window face makes sure it
/// runs before AppKit starts (`ensure`). A face that Launch Services itself started (`open -n`) is
/// registered from launch, so it is older than a relay it starts; it runs itself again as a plain child,
/// which registers only when its NSApplication starts.
enum LinkRelay {
    static let argument = "--link-relay"
    private nonisolated(unsafe) static var lockDescriptor: Int32 = -1
    private static let startDeadline: TimeInterval = 3

    private static var lockFile: URL {
        URL(fileURLWithPath: genesisHome()).appendingPathComponent(".genesis-tools/app/link-relay.lock")
    }

    /// The window faces that need a relay in front of them: every face `FaceRecord` reopens after a rebuild.
    static func shouldEnsure(_ arguments: [String]) -> Bool {
        FaceRecord.isWindowFace(arguments)
    }

    /// A bare launch may be macOS delivering a banner click to a fresh process, and that click is lost in a
    /// re-run, so only an explicit window request runs itself again.
    static func mayRunAgain(_ arguments: [String]) -> Bool {
        let first = arguments.first ?? ""
        return first == "--hub" || first == "--review" || first == "--window"
    }

    /// Another process holds the relay lock. Asks the kernel, not a pid file.
    static var isRunning: Bool {
        guard lockDescriptor < 0 else { return true }
        let descriptor = open(lockFile.path, O_RDONLY | O_CLOEXEC)
        guard descriptor >= 0 else { return false }
        defer { close(descriptor) }
        if flock(descriptor, LOCK_SH | LOCK_NB) == 0 {
            flock(descriptor, LOCK_UN)
            return false
        }
        return true
    }

    /// For a window face, before NSApplication exists: start the relay when none runs, and when this
    /// process is already registered with Launch Services, run this face again as a child and exit.
    static func ensure(_ arguments: [String]) {
        guard !isRunning else { return }
        let bundleId = Bundle.main.bundleIdentifier ?? ""
        let own = ProcessInfo.processInfo.processIdentifier
        let registered = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId)
            .contains { $0.processIdentifier == own }
        start()
        guard registered, mayRunAgain(arguments) else {
            LinkRelay.note("started before \(arguments.first ?? "the settings window")")
            return
        }
        runAgainAsChild(arguments)
    }

    private static func start() {
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.arguments = [argument]
        configuration.createsNewApplicationInstance = true
        configuration.activates = false
        // Launch Services does not pass this face's environment on. The relay must find its lock under the
        // same `genesisHome()` (GENESIS_TOOLS_HOME), or this face waits for a lock the relay never takes.
        configuration.environment = ProcessInfo.processInfo.environment
        let opened = DispatchSemaphore(value: 0)
        NSWorkspace.shared.openApplication(at: Bundle.main.bundleURL, configuration: configuration) { _, error in
            if let error {
                LinkRelay.note("did not start: \(error)")
            }
            opened.signal()
        }
        _ = opened.wait(timeout: .now() + startDeadline)
        // The relay claims its lock right after Launch Services registers it; wait for that, with a deadline.
        let deadline = Date().addingTimeInterval(startDeadline)
        while !isRunning, Date() < deadline {
            Thread.sleep(forTimeInterval: 0.1)
        }
        if !isRunning {
            LinkRelay.note("not running after \(Int(startDeadline)) s; links keep reaching the window faces")
        }
    }

    private static func runAgainAsChild(_ arguments: [String]) -> Never {
        guard let executable = Bundle.main.executablePath else {
            LinkRelay.note("no executable path, this face stays older than the relay")
            return runOn(arguments)
        }
        let child = Process()
        child.executableURL = URL(fileURLWithPath: executable)
        child.arguments = arguments
        do {
            try child.run()
        } catch {
            LinkRelay.note("running \(arguments.first ?? "") again failed: \(error)")
            return runOn(arguments)
        }
        LinkRelay.note("\(arguments.first ?? "") runs again as pid \(child.processIdentifier), younger than the relay")
        exit(0)
    }

    /// Unreachable in practice; keeps the face running when it cannot run itself again.
    private static func runOn(_ arguments: [String]) -> Never {
        switch arguments.first {
        case "--hub": runHub(Array(arguments.dropFirst()))
        case "--review": runReview(Array(arguments.dropFirst()))
        default: runWindowApp(showWindowImmediately: true)
        }
    }

    /// One line in app-perf.log and in the relay's own journal (LinkRelayJournal.swift).
    static func note(_ text: String) {
        HubPerf.log("relay: \(text)")
        RelayJournal.write(text)
    }

    private static let heartbeatSeconds = 60.0
    private nonisolated(unsafe) static var state: RelayJournal.State?
    private nonisolated(unsafe) static var heartbeat: DispatchSourceTimer?
    private nonisolated(unsafe) static var terminationSources: [DispatchSourceSignal] = []

    /// The relay face itself. Exits at once when another relay holds the lock.
    static func run() -> Never {
        RelayJournal.role = "relay"
        guard claim() else {
            note("relay lock could not be claimed, exiting")
            exit(0)
        }
        if let previous = RelayJournal.previousEnd(
            RelayJournal.readState(),
            isAlive: { kill($0, 0) == 0 },
            crashReport: { RelayJournal.crashReport(since: $0) }
        ) {
            note(previous)
        }
        let now = Date()
        let started = RelayJournal.State(pid: getpid(), startedAt: now, heartbeatAt: now, cleanExit: false)
        state = started
        RelayJournal.writeState(started)
        endCleanlyOnSignals()
        UserDefaults.standard.register(defaults: ["NSTreatUnknownArgumentsAsOpen": "NO"])
        let app = NSApplication.shared
        app.delegate = relayDelegate
        app.setActivationPolicy(.accessory)
        installBrowserURLForwarder()
        installNotificationClicksForWindowFace()
        MainActor.assumeIsolated {
            // A hung relay holds every link: its stalls and samples land in app-perf.log and logs/hangs/.
            HangWatch.start()
        }
        startHeartbeat()
        note("running as pid \(getpid()), version \(bundleVersion()), parent pid \(getppid())")
        app.run()
        exit(0)
    }

    /// On the main queue, so a stale heartbeat in link-relay.json dates the moment the main thread stopped.
    private static func startHeartbeat() {
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now() + heartbeatSeconds, repeating: heartbeatSeconds, leeway: .seconds(5))
        timer.setEventHandler {
            guard var current = state else { return }
            current.heartbeatAt = Date()
            state = current
            RelayJournal.writeState(current)
        }
        timer.resume()
        heartbeat = timer
    }

    /// A rebuild's reap sends SIGTERM: recorded as a clean end, so only a crash or a SIGKILL reads as one.
    private static func endCleanlyOnSignals() {
        for number in [SIGTERM, SIGINT, SIGHUP] {
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .global())
            source.setEventHandler {
                note("ending on signal \(number)")
                if var current = state {
                    current.cleanExit = true
                    RelayJournal.writeState(current)
                }
                exit(0)
            }
            source.resume()
            terminationSources.append(source)
        }
    }

    /// A startup probe holds a shared lock briefly. Give it time to release without mistaking it for a relay.
    static func acquireLock(_ descriptor: Int32) -> Bool {
        for attempt in 0..<4 {
            if flock(descriptor, LOCK_EX | LOCK_NB) == 0 { return true }
            if attempt < 3 { Thread.sleep(forTimeInterval: 0.1) }
        }
        return false
    }

    /// A descriptor is returned only after the file opened and this process owns its exclusive lock.
    static func claimDescriptor(_ file: URL) -> Int32? {
        let descriptor = open(file.path, O_RDWR | O_CREAT | O_CLOEXEC, 0o644)
        guard descriptor >= 0 else { return nil }
        guard acquireLock(descriptor) else {
            close(descriptor)
            return nil
        }
        return descriptor
    }

    private static func claim() -> Bool {
        do {
            try FileManager.default.createDirectory(at: lockFile.deletingLastPathComponent(), withIntermediateDirectories: true)
        } catch {
            note("lock directory could not be created: \(error)")
            return false
        }
        guard let descriptor = claimDescriptor(lockFile) else {
            note("lock file could not be claimed (errno \(errno))")
            return false
        }
        lockDescriptor = descriptor
        return true
    }
}

private let relayDelegate = LinkRelayDelegate()

private final class LinkRelayDelegate: NSObject, NSApplicationDelegate {
    /// A local `.html` file, or a link AppKit hands here instead of the URL event.
    func application(_ application: NSApplication, open urls: [URL]) {
        let files = urls.filter(\.isFileURL).map(\.lastPathComponent)
        if !files.isEmpty {
            LinkRelay.note("files handed over: \(files.joined(separator: ", "))")
        }
        LocalFileHandoff.deliver(urls)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func application(_ app: NSApplication, shouldRestoreSecureApplicationState coder: NSCoder) -> Bool { false }

    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool { true }

    /// `open -a GenesisTools` and a Dock click reach the relay: the main window opens in its own face.
    @MainActor
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if (AppMainWindow.current == .hub || HubSingleInstance.isRunningElsewhere), AppDock.showHub(nil) {
            LinkRelay.note("reopen, showing the hub")
        } else if let executable = Bundle.main.executablePath {
            LinkRelay.note("reopen, opening the settings window")
            let child = Process()
            child.executableURL = URL(fileURLWithPath: executable)
            child.arguments = ["--window"]
            try? child.run()
        }
        NSApp.setActivationPolicy(.accessory)
        return false
    }

    @MainActor
    func applicationDockMenu(_ sender: NSApplication) -> NSMenu? {
        AppDock.menu()
    }
}
