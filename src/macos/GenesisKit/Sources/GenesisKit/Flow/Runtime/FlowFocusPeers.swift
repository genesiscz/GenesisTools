import AppKit
import Darwin
import Foundation

/// A running Genesis.app, as the runtime sees it when it decides whether that copy speaks the Flow and Focus protocol.
/// Genesis links this package too, so a current copy joins the same election; a copy built before the protocol runs its
/// own dictation shortcut, capture, Focus timer and Do Not Disturb.
public struct FlowFocusPeerApp: Equatable, Sendable {
    public static let genesisBundleID = "dev.foltyn.genesis"

    public let pid: Int32
    public let bundlePath: String?
    public let version: String?
    /// LaunchServices' launch date. Nil for an app started another way (a script, a relaunch through exec).
    public let launchDate: Date?
    /// The kernel's start time of the process, which every process has.
    public let startedAt: Date?

    public init(pid: Int32, bundlePath: String? = nil, version: String? = nil, launchDate: Date? = nil, startedAt: Date? = nil) {
        self.pid = pid
        self.bundlePath = bundlePath
        self.version = version
        self.launchDate = launchDate
        self.startedAt = startedAt
    }

    /// Every running Genesis.app.
    @MainActor static func running() -> [FlowFocusPeerApp] {
        NSRunningApplication.runningApplications(withBundleIdentifier: genesisBundleID)
            .filter { !$0.isTerminated }
            .map { app in
                let bundle = app.bundleURL.flatMap(Bundle.init(url:))
                let short = bundle?.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
                let build = (bundle?.object(forInfoDictionaryKey: "CFBundleVersion") as? String).map { "(\($0))" }
                let version = [short, build].compactMap { $0 }.joined(separator: " ")
                return FlowFocusPeerApp(pid: app.processIdentifier, bundlePath: app.bundleURL?.path,
                                        version: version.isEmpty ? nil : version, launchDate: app.launchDate,
                                        startedAt: processStart(app.processIdentifier))
            }
    }

    static func processStart(_ pid: Int32) -> Date? {
        FlowAudioProcess.read(pid: pid).map {
            Date(timeIntervalSince1970: Double($0.seconds) + Double($0.microseconds) / 1_000_000)
        }
    }

    /// The process's short name from the kernel ("Genesis", "bun"), for diagnostics.
    static func processName(_ pid: Int32) -> String? {
        var buffer = [CChar](repeating: 0, count: 256)
        guard proc_name(pid, &buffer, UInt32(buffer.count)) > 0 else { return nil }
        return String(cString: buffer)
    }
}

/// What the runtime tells a person about a state it is in or a request it refused: the message, a dim line, what was
/// found (behind "Details"), and the fixes. Drawn by GenesisKit's `NoticePill`.
public struct FlowFocusNotice {
    public let text: String
    public let detail: String?
    public let found: String
    public let fixes: [NoticeFix]
}

enum FlowFocusDiagnostics {
    static func stamp(_ date: Date?) -> String {
        guard let date else { return "unknown" }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd HH:mm:ss"
        return formatter.string(from: date)
    }
}
