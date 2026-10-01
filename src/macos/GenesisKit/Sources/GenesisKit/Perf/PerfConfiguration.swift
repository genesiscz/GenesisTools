import Foundation

/// Where an app's perf lines, hang captures and stall stacks go, and whether they are on. The host
/// supplies it (`GenesisKitHost.perf`); both apps used to carry a copy of PerfLog and HangWatch that
/// differed only in these values.
public struct PerfConfiguration: Sendable {
    /// `GENESIS_TOOLS_PERF` / `GENESIS_PERF`: `0` or `false` turns logging off, anything else on.
    public var environmentKey: String
    /// On when the environment says nothing (GenesisTools: always; Genesis: debug builds).
    public var enabledByDefault: Bool
    /// The unified log subsystem, also the prefix of the writer queue's label.
    public var subsystem: String
    /// `~/.genesis-tools/logs` / `~/.genesis/logs`; hang captures go in its `hangs` folder.
    public var logDirectory: URL
    public var fileName: String
    /// Put before every line of this process ("[md] " for Genesis's Markdown helper).
    public var processTag: String
    /// The in-process stall stacks' file prefix (`stack-`, `stack-md-`).
    public var stackFilePrefix: String
    /// Named in the "is not responding" notification.
    public var appName: String
    /// The notification goes out only from a bundle whose id starts with this; nil never posts one.
    public var alertBundlePrefix: String?

    public init(
        environmentKey: String,
        enabledByDefault: Bool,
        subsystem: String,
        logDirectory: URL,
        fileName: String,
        processTag: String = "",
        stackFilePrefix: String = "stack-",
        appName: String,
        alertBundlePrefix: String?
    ) {
        self.environmentKey = environmentKey
        self.enabledByDefault = enabledByDefault
        self.subsystem = subsystem
        self.logDirectory = logDirectory
        self.fileName = fileName
        self.processTag = processTag
        self.stackFilePrefix = stackFilePrefix
        self.appName = appName
        self.alertBundlePrefix = alertBundlePrefix
    }

    /// An app that declares no host: off unless `GENESIS_PERF` asks, logs in `~/.genesis/logs`.
    public static let fallback = PerfConfiguration(
        environmentKey: "GENESIS_PERF",
        enabledByDefault: false,
        subsystem: Bundle.main.bundleIdentifier ?? "genesiskit",
        logDirectory: FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".genesis/logs"),
        fileName: "perf.log",
        appName: ProcessInfo.processInfo.processName,
        alertBundlePrefix: nil
    )

    /// Read once, when perf logging is first used.
    static let current: PerfConfiguration = GenesisKit.host?.perf ?? .fallback
}
