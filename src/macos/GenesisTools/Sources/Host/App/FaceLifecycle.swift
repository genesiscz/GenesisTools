import AppKit
import Foundation

/// How each long-lived face starts and ends, one JSON line per event in `~/.genesis-tools/app/lifecycle.jsonl`:
/// `{"detail":…,"event":…,"face":…,"pid":…,"t":<epoch seconds>}`.
///
/// On 2026-11-02 the widget stopped at about 20:44 and nothing said how: no crash report, no day-log line, no quit mark.
/// It stayed off for two days. Every way a face ends now leaves a line: `exit` (a normal exit), `terminate` (AppKit's
/// quit, with the Apple Event sender when another app asked), `signal` (SIGTERM, SIGINT, SIGHUP), `crash` (SIGSEGV,
/// SIGBUS, SIGILL, SIGTRAP, SIGABRT, SIGFPE), `exception` (an uncaught NSException), and `vanished` (a face of an earlier
/// run that left no line at all: SIGKILL, a jetsam kill or a power loss, found at the next face start through its marker
/// in `app/lifecycle-alive/`). `start`, `window-close` and `quit-request` (PartQuit, "Quit All") show what led to it.
package enum FaceLifecycle {
    static var directory: URL {
        URL(fileURLWithPath: genesisHome()).appendingPathComponent(".genesis-tools/app", isDirectory: true)
    }

    static var logURL: URL { directory.appendingPathComponent("lifecycle.jsonl") }
    static var aliveDirectory: URL { directory.appendingPathComponent("lifecycle-alive", isDirectory: true) }

    /// The log moves to a uniquely named archive at a face start once it is this big.
    static let rotateBytes = 4 * 1024 * 1024

    static let terminatingSignals: [Int32] = [SIGTERM, SIGINT, SIGHUP]
    static let crashSignals: [Int32] = [SIGSEGV, SIGBUS, SIGILL, SIGTRAP, SIGABRT, SIGFPE]

    /// The faces that get a lifecycle: the window faces a rebuild reopens, every part face (the recorder included) and
    /// the link relay. `--rpc`, `--mic` and the permission probes start many times a minute and end on their own.
    static func isLogged(_ argv: [String]) -> Bool {
        if argv.contains("--snapshot") || argv.contains("--bench") {
            return false
        }
        let first = argv.first ?? ""
        return FaceRecord.isWindowFace(argv) || AppParts.partOfFace[first] != nil || first == LinkRelay.argument
    }

    /// The face's name in the log: its first argument, and `--window` for a bare launch (Finder, a notification click).
    static func faceName(_ argv: [String]) -> String {
        let first = argv.first ?? ""
        return first.isEmpty || first.hasPrefix("-psn_") ? "--window" : first
    }

    /// One log line. The keys are sorted, so `t` comes last: the signal handler writes everything before its value
    /// ahead of time and only the digits when the signal arrives.
    static func line(time: Int, pid: Int32, face: String, event: String, detail: String? = nil) -> String {
        var object: [String: Any] = ["t": time, "pid": Int(pid), "face": face, "event": event]
        if let detail { object["detail"] = detail }
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
              let text = String(data: data, encoding: .utf8)
        else { return "" }
        return text + "\n"
    }

    /// A `kill(pid, 0)` probe: true while a process with this pid exists (EPERM means it exists under another user).
    static func isAlive(_ pid: Int32) -> Bool {
        kill(pid, 0) == 0 || errno == EPERM
    }

    nonisolated(unsafe) private static var descriptor: Int32 = -1
    nonisolated(unsafe) private static var logPath: UnsafeMutablePointer<CChar>?
    nonisolated(unsafe) private static var face = ""
    nonisolated(unsafe) private static var aliveMarkerPath: UnsafeMutablePointer<CChar>?
    /// Per signal number: the line up to `"t":`, prepared at install, and its length.
    nonisolated(unsafe) private static var signalPrefixes: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>?
    nonisolated(unsafe) private static var signalPrefixLengths: UnsafeMutablePointer<Int>?
    nonisolated(unsafe) private static var signalLine: UnsafeMutablePointer<UInt8>?
    private static let signalSlots = 64
    private static let signalLineCapacity = 1024
    nonisolated(unsafe) private static var observers: [NSObjectProtocol] = []

    /// Once per face, at its start in `runHost`, before the face sets up its own signal handling (a face that installs
    /// a handler later replaces this one, as the link relay does: it logs its own SIGTERM).
    @MainActor
    static func install(arguments: [String]) {
        guard !NativePreview.enabled, isLogged(arguments), descriptor < 0 else { return }
        face = faceName(arguments)
        do {
            try FileManager.default.createDirectory(at: aliveDirectory, withIntermediateDirectories: true)
        } catch {
            FileHandle.standardError.write(Data("face lifecycle: \(error)\n".utf8))
            return
        }
        rotateIfLarge()
        descriptor = open(logURL.path, O_WRONLY | O_APPEND | O_CREAT | O_CLOEXEC, 0o644)
        guard descriptor >= 0 else { return }
        logPath = strdup(logURL.path)

        reportVanished(now: Int(Date().timeIntervalSince1970))
        writeAliveMarker()
        note("start", argv: arguments)
        installSignalHandlers()
        atexit { FaceLifecycle.exited() }
        NSSetUncaughtExceptionHandler { exception in
            FaceLifecycle.note("exception", detail: "\(exception.name.rawValue): \(exception.reason ?? "no reason")")
        }
        observe()
    }

    /// An event of this face, from anywhere in the app. No-op before `install` or in a face without a lifecycle.
    static func note(_ event: String, detail: String? = nil) {
        guard descriptor >= 0 else { return }
        let text = line(time: Int(Date().timeIntervalSince1970), pid: getpid(), face: face, event: event, detail: detail)
        appendLine(text, to: logURL)
    }

    private static func note(_ event: String, argv: [String]) {
        note(event, detail: argv.joined(separator: " "))
    }

    /// Resolve the current file at each event, so a face started before rotation writes to the active log.
    static func appendLine(_ text: String, to url: URL) {
        let target = open(url.path, O_WRONLY | O_APPEND | O_CREAT | O_CLOEXEC, 0o644)
        guard target >= 0 else { return }
        defer { close(target) }
        text.utf8CString.withUnsafeBufferPointer { buffer in
            _ = write(target, buffer.baseAddress, buffer.count - 1)
        }
    }

    static func rotateIfLarge(at url: URL = logURL, threshold: Int = rotateBytes) {
        let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int) ?? 0
        guard size >= threshold else { return }
        // Keep distinct archives: a writer that opened immediately before the rename may still append there.
        let old = URL(fileURLWithPath: url.path + "." + UUID().uuidString)
        try? FileManager.default.moveItem(at: url, to: old)
    }
    // MARK: Alive markers

    struct AliveMarker: Codable, Equatable {
        let face: String
        let t: Int
    }

    /// The markers of faces that died without removing theirs, each claimed once: the face whose remove succeeds logs
    /// it, so two faces starting together never log one death twice. A live pid keeps its marker.
    static func claimVanished(in directory: URL, ownPid: Int32, alive: (Int32) -> Bool) -> [(pid: Int32, marker: AliveMarker)] {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
        var claimed: [(pid: Int32, marker: AliveMarker)] = []
        for name in names {
            guard let pid = Int32(name), pid != ownPid, !alive(pid) else { continue }
            let url = directory.appendingPathComponent(name)
            let marker = (try? Data(contentsOf: url)).flatMap { try? JSONDecoder().decode(AliveMarker.self, from: $0) }
                ?? AliveMarker(face: "unknown", t: 0)
            guard (try? FileManager.default.removeItem(at: url)) != nil else { continue }
            claimed.append((pid, marker))
        }
        return claimed
    }

    private static func reportVanished(now: Int) {
        for (pid, marker) in claimVanished(in: aliveDirectory, ownPid: getpid(), alive: isAlive) {
            let text = line(
                time: now, pid: pid, face: marker.face, event: "vanished",
                detail: "started at \(marker.t) and left no exit line: SIGKILL, a jetsam kill or a power loss (seen by pid \(getpid()))")
            appendLine(text, to: logURL)
        }
    }

    private static func writeAliveMarker() {
        let url = aliveDirectory.appendingPathComponent("\(getpid())")
        guard let data = try? JSONEncoder().encode(AliveMarker(face: face, t: Int(Date().timeIntervalSince1970))) else { return }
        try? data.write(to: url, options: .atomic)
        aliveMarkerPath = strdup(url.path)
    }

    private static func exited() {
        note("exit")
        if let aliveMarkerPath { unlink(aliveMarkerPath) }
    }

    // MARK: Signals

    private static func installSignalHandlers() {
        let prefixes = UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>.allocate(capacity: signalSlots)
        prefixes.initialize(repeating: nil, count: signalSlots)
        let lengths = UnsafeMutablePointer<Int>.allocate(capacity: signalSlots)
        lengths.initialize(repeating: 0, count: signalSlots)
        signalLine = UnsafeMutablePointer<UInt8>.allocate(capacity: signalLineCapacity)
        for signal in terminatingSignals + crashSignals {
            let event = crashSignals.contains(signal) ? "crash" : "signal"
            let name = String(cString: strsignal(signal))
            // The line ends in `"t":0}\n`; the handler writes the real seconds where the 0 was.
            let full = Array(line(time: 0, pid: getpid(), face: face, event: event, detail: "signal \(signal): \(name)").utf8)
            let prefix = full.dropLast(3)
            guard !prefix.isEmpty, prefix.count + 24 < signalLineCapacity else { continue }
            let storage = UnsafeMutablePointer<UInt8>.allocate(capacity: prefix.count)
            storage.initialize(from: Array(prefix), count: prefix.count)
            prefixes[Int(signal)] = storage
            lengths[Int(signal)] = prefix.count
        }
        signalPrefixes = prefixes
        signalPrefixLengths = lengths
        for signal in terminatingSignals + crashSignals {
            var action = sigaction()
            action.__sigaction_u.__sa_handler = faceLifecycleSignalHandler
            sigemptyset(&action.sa_mask)
            action.sa_flags = 0
            sigaction(signal, &action, nil)
        }
    }

    /// Runs inside the signal handler: only `open`, `write`, `close`, `time`, `memcpy`, `unlink`, `signal` and `raise`, on memory
    /// prepared at install. It restores the default action and raises the signal again, so the process ends (and a
    /// crash report is written) exactly as it would without this log.
    fileprivate static func handle(signal: Int32) {
        if descriptor >= 0, signal > 0, Int(signal) < signalSlots,
           let prefixes = signalPrefixes, let lengths = signalPrefixLengths, let buffer = signalLine,
           let prefix = prefixes[Int(signal)], let logPath
        {
            let length = lengths[Int(signal)]
            memcpy(buffer, prefix, length)
            var cursor = length
            var seconds = time(nil)
            let digitsStart = cursor
            if seconds <= 0 {
                buffer[cursor] = 48
                cursor += 1
            }
            while seconds > 0, cursor < signalLineCapacity - 2 {
                buffer[cursor] = UInt8(48 + seconds % 10)
                seconds /= 10
                cursor += 1
            }
            var low = digitsStart
            var high = cursor - 1
            while low < high {
                let swap = buffer[low]
                buffer[low] = buffer[high]
                buffer[high] = swap
                low += 1
                high -= 1
            }
            buffer[cursor] = 125
            buffer[cursor + 1] = 10
            let target = open(logPath, O_WRONLY | O_APPEND | O_CREAT | O_CLOEXEC, 0o644)
            if target >= 0 {
                _ = write(target, buffer, cursor + 2)
                close(target)
            }
        }
        if let aliveMarkerPath { unlink(aliveMarkerPath) }
        Darwin.signal(signal, SIG_DFL)
        raise(signal)
    }

    // MARK: AppKit

    @MainActor
    private static func observe() {
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: NSWindow.willCloseNotification, object: nil, queue: .main) { note in
            MainActor.assumeIsolated {
                guard let window = note.object as? NSWindow, let detail = windowDetail(window) else { return }
                FaceLifecycle.note("window-close", detail: detail)
            }
        })
        observers.append(center.addObserver(forName: NSApplication.willTerminateNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated {
                FaceLifecycle.note("terminate", detail: terminateDetail())
            }
        })
    }

    /// The closed window's class, title and identifier. Nil for AppKit's own short-lived windows (menus, tooltips,
    /// popovers, the text input windows `TUINSWindow`), which close many times a minute and say nothing about how a
    /// face ends.
    @MainActor
    static func windowDetail(_ window: NSWindow) -> String? {
        let kind = String(describing: type(of: window))
        if kind.hasPrefix("_NS") || kind.hasPrefix("TUI") || kind.contains("Menu") || kind.contains("ToolTip")
            || kind.contains("Popover")
        {
            return nil
        }
        let identifier = window.identifier?.rawValue ?? "-"
        return "\(kind) \"\(window.title)\" id \(identifier)"
    }

    /// Who asked AppKit to quit, when it is still known: a quit Apple Event names its sender (another app, logout,
    /// `osascript`). Without one the quit came from inside this face (its menu, ⌘Q, or code).
    @MainActor
    private static func terminateDetail() -> String {
        guard let event = NSAppleEventManager.shared().currentAppleEvent, event.eventID == AEEventID(kAEQuitApplication) else {
            return "from this face: its quit menu, ⌘Q, \"Quit All\" from another part, or code"
        }
        let sender = event.attributeDescriptor(forKeyword: AEKeyword(keySenderPIDAttr))?.int32Value ?? 0
        let senderName = sender > 0 ? NSRunningApplication(processIdentifier: sender)?.localizedName ?? "pid \(sender)" : "unknown"
        let reason = event.attributeDescriptor(forKeyword: AEKeyword(kAEQuitReason)).map { fourCharCode($0.enumCodeValue) } ?? "none"
        return "quit Apple Event from \(senderName) (pid \(sender)), reason \(reason)"
    }

    private static func fourCharCode(_ code: FourCharCode) -> String {
        let bytes = [24, 16, 8, 0].map { UInt8((code >> $0) & 0xFF) }
        return String(bytes: bytes, encoding: .macOSRoman) ?? "\(code)"
    }
}

/// The C signal handler: a plain function with no captures, as `sigaction` needs.
private func faceLifecycleSignalHandler(_ signal: Int32) {
    FaceLifecycle.handle(signal: signal)
}
