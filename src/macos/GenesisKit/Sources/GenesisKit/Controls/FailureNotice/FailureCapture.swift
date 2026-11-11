import CryptoKit
import Foundation

/// Captures a failure when it occurs. A host installs this once; library tests and hosts that do not install it do
/// not start diagnostic commands or write reports. Opening Details never substitutes a newer machine snapshot.
public enum FailureCapture {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var prepare: (@Sendable (FailureReport) async -> FailureReport)?

    public static func enable(directory: URL = GenesisToolsHome.url("logs/failure-reports"),
                              environment: @escaping @Sendable () async -> FailureEnvironment? = { await FailureEnvironment.load() },
                              enrich: @escaping @Sendable (FailureReport) async -> FailureReport = { await $0.addingCallLog() }) {
        let store = FailureCaptureStore(directory: directory, environment: environment, enrich: enrich)
        lock.withLock { prepare = { report in await store.prepared(report) } }
        ToolsCallTrace.observeFailures { call in
            let message = call.stderr.flatMap { $0.isEmpty ? nil : $0 } ?? "The tools call failed."
            _ = FailureReport.toolsCall(ToolsBridgeError.refused(message), outcome: "The command did not finish",
                                       action: "Run the tools command", call: call, area: call.argv.first,
                                       time: call.ended ?? Date())
        }
    }

    public static func disable() {
        lock.withLock { prepare = nil }
        ToolsCallTrace.observeFailures(nil)
    }

    public static var isEnabled: Bool { lock.withLock { prepare != nil } }

    public static func record(_ report: FailureReport) {
        guard let work = lock.withLock({ prepare }) else { return }
        Task { _ = await work(report) }
    }

    public static func prepared(_ report: FailureReport) async -> FailureReport {
        guard let work = lock.withLock({ prepare }) else { return report }
        return await work(report)
    }
}

/// One archive per failure, written before gathering its context and replaced atomically when that context arrives.
/// Concurrent failures share only a gather already in flight; a later failure starts a fresh gather.
public actor FailureCaptureStore {
    public struct Record: Codable, Sendable {
        public var version = 1
        public var recordedAt: Date
        public var contextCapturedAt: Date?
        public var report: FailureReport

        public init(recordedAt: Date, contextCapturedAt: Date? = nil, report: FailureReport) {
            self.recordedAt = recordedAt
            self.contextCapturedAt = contextCapturedAt
            self.report = report
        }

        private enum CodingKeys: String, CodingKey { case version, recordedAt, contextCapturedAt, report }

        public init(from decoder: Decoder) throws {
            let values = try decoder.container(keyedBy: CodingKeys.self)
            report = try values.decode(FailureReport.self, forKey: .report)
            version = try values.decodeIfPresent(Int.self, forKey: .version) ?? 1
            recordedAt = try values.decodeIfPresent(Date.self, forKey: .recordedAt) ?? report.time
            contextCapturedAt = try values.decodeIfPresent(Date.self, forKey: .contextCapturedAt)
        }
    }

    private let directory: URL
    private let environment: @Sendable () async -> FailureEnvironment?
    private let enrich: @Sendable (FailureReport) async -> FailureReport
    private var work: [String: Task<FailureReport, Never>] = [:]
    private var gathering: (UUID, Task<FailureEnvironment?, Never>)?

    public init(directory: URL, environment: @escaping @Sendable () async -> FailureEnvironment? = { await FailureEnvironment.load() },
                enrich: @escaping @Sendable (FailureReport) async -> FailureReport = { await $0.addingCallLog() }) {
        self.directory = directory
        self.environment = environment
        self.enrich = enrich
    }

    public nonisolated static func key(_ report: FailureReport) -> String {
        let identity = report.call.map { "call:\($0.traceId):\(Int64(($0.started.timeIntervalSince1970 * 1000).rounded()))" }
            ?? "report:\(Int64((report.time.timeIntervalSince1970 * 1000).rounded())):\(report.title):\(report.headline)"
        return SHA256.hash(data: Data(identity.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    /// A visible notice keeps its original report across redraws. A changed error replaces it; dismissing and showing
    /// the same error creates a new view and therefore a new event. Tool calls already carry their own event id.
    static func presentationKey(_ report: FailureReport) -> String {
        if report.call != nil { return key(report) }
        let identity = [report.title, report.headline, report.summary, report.action, report.command, report.folder, report.log]
            .compactMap { $0 }.joined(separator: "\n")
        return SHA256.hash(data: Data(identity.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    public nonisolated func file(for report: FailureReport) -> URL {
        directory.appendingPathComponent(Self.key(report) + ".json")
    }

    /// A read-only loader. An older archive without version or capture time remains readable; malformed files are
    /// ignored and a later actual capture can replace them. Reading one never runs a diagnostic or rewrites it.
    public func read(_ report: FailureReport) -> Record? {
        let url = file(for: report)
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        do {
            let data = try Data(contentsOf: url)
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .millisecondsSince1970
            do {
                return try decoder.decode(Record.self, from: data)
            } catch {
                decoder.dateDecodingStrategy = .iso8601
                return try decoder.decode(Record.self, from: data)
            }
        } catch {
            PerfLog.mark("failure.capture read failed: \(error.localizedDescription)")
            return nil
        }
    }

    public func prepared(_ input: FailureReport) async -> FailureReport {
        let report = Self.sanitized(input)
        let key = Self.key(report)
        if let task = work[key] {
            let captured = await task.value
            var ready = report
            ready.environment = captured.environment
            if ready.log.isEmpty { ready.log = captured.log }
            if var stored = read(report), stored.report != ready {
                stored.report = ready
                write(stored, for: report)
            }
            return ready
        }
        if let stored = read(report), stored.contextCapturedAt != nil {
            var ready = report
            ready.environment = stored.report.environment
            if ready.log.isEmpty { ready.log = stored.report.log }
            if ready != stored.report {
                var updated = stored
                updated.report = ready
                write(updated, for: report)
            }
            return ready
        }

        let recordedAt = Date()
        write(Record(recordedAt: recordedAt, report: report), for: report)
        let environment = self.environment
        let enrich = self.enrich
        let task = Task { [weak self] in
            let snapshot = Task { await self?.facts(environment) }
            var ready = await enrich(report)
            let facts = await snapshot.value
            let capturedAt = Date()
            if var context = report.environment ?? facts {
                let formatter = DateFormatter()
                formatter.locale = Locale(identifier: "en_US_POSIX")
                formatter.dateFormat = "yyyy-MM-dd HH:mm:ss z"
                let stamp = "Diagnostic context collected at \(formatter.string(from: capturedAt)); failure occurred at \(formatter.string(from: report.time))."
                context.markdown = stamp + "\n\n" + context.markdown
                context.values["app-build"] = [context.values["app-build"], stamp].compactMap { $0 }.joined(separator: "\n\n")
                ready.environment = context
            }
            await self?.write(Record(recordedAt: recordedAt, contextCapturedAt: capturedAt, report: ready), for: report)
            return ready
        }
        work[key] = task
        let ready = await task.value
        work[key] = nil
        return ready
    }

    private func facts(_ load: @escaping @Sendable () async -> FailureEnvironment?) async -> FailureEnvironment? {
        if let (_, task) = gathering { return await task.value }
        let id = UUID()
        let task = Task { await load() }
        gathering = (id, task)
        let value = await task.value
        if gathering?.0 == id { gathering = nil }
        return value
    }

    private nonisolated static func sanitized(_ report: FailureReport) -> FailureReport {
        guard let call = report.call else { return report }
        var safe = report
        safe.headline = ToolsCallTrace.redactedText(report.headline, argv: call.argv)
        safe.summary = report.summary.map { ToolsCallTrace.redactedText($0, argv: call.argv) }
        safe.log = ToolsCallTrace.redactedText(report.log, argv: call.argv)
        safe.command = report.command.map { ToolsCallTrace.redactedText($0, argv: call.argv) }
        var safeCall = call
        safeCall.argv = ToolsCallTrace.redacted(call.argv)
        safeCall.stderr = call.stderr.map { ToolsCallTrace.redactedText($0, argv: call.argv) }
        safe.call = safeCall
        return safe
    }

    private func write(_ record: Record, for report: FailureReport) {
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                    attributes: [.posixPermissions: 0o700])
            let encoder = JSONEncoder()
            encoder.dateEncodingStrategy = .millisecondsSince1970
            encoder.outputFormatting = [.sortedKeys]
            let file = file(for: report)
            try encoder.encode(record).write(to: file, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        } catch {
            PerfLog.mark("failure.capture write failed: \(error.localizedDescription)")
        }
    }
}
