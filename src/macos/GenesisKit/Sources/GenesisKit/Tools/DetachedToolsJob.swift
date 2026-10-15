import Darwin
import Foundation

/// A long `tools` run that outlives the app: an index build that takes minutes must not die when Genesis is
/// restarted or reinstalled. A `ToolsLineStream` child writes into a pipe, and the first progress line after the
/// app is gone kills it with SIGPIPE; this child writes into files instead, so it runs to the end on its own.
///
/// `start` launches the child and returns a `Record` (pid and file paths) the caller saves; `DetachedToolsJob`
/// follows a record's files and pid from any app instance: the one that started the job, or the next one after a
/// restart, which reads the output from the beginning and then keeps up. Nothing polls: a kqueue file source wakes
/// it on each write, and a process source on the exit.
public final class DetachedToolsJob: @unchecked Sendable {
    public struct Record: Codable, Equatable, Sendable {
        public var pid: Int32
        public var startedAt: Date
        public var outputPath: String
        public var errorPath: String
        public var argv: [String]

        public init(pid: Int32, startedAt: Date, outputPath: String, errorPath: String, argv: [String]) {
            self.pid = pid
            self.startedAt = startedAt
            self.outputPath = outputPath
            self.errorPath = errorPath
            self.argv = argv
        }

        /// The process still exists (and is not a zombie of ours). A reused pid is ruled out by the caller, which
        /// also reads the lock or the output.
        public var isAlive: Bool {
            kill(pid, 0) == 0 || errno == EPERM
        }
    }

    public struct Exit: Sendable, Equatable {
        /// The exit status when this app instance started the job; nil after a restart (only the parent can
        /// read it), so callers judge the result from the job's own last lines.
        public let status: Int32?
        /// True for a `stop()` of ours.
        public let stopped: Bool
        /// The last `ToolsLineStream.stderrLimit` bytes of the error file.
        public let stderr: String
    }

    /// Launches `tools <subcommand> <args…>` with stdout and stderr in files (both truncated first) and stdin
    /// from /dev/null. `priority` works as in `ToolsLineStream`. The returned process object is the caller's
    /// only way to learn the exit status; pass it to `init(record:process:…)`.
    public static func start(
        bridge: ToolsBridge,
        subcommand: String,
        args: [String],
        outputPath: String,
        errorPath: String,
        priority: ToolsLineStream.Priority = .utility
    ) throws -> (Record, Process) {
        let binary = bridge.binaryPath
        guard ToolsBridge.isExecutableFile(binary) else {
            throw ToolsBridgeError.binaryNotFound(binary)
        }
        for path in [outputPath, errorPath] {
            try FileManager.default.createDirectory(at: URL(fileURLWithPath: path).deletingLastPathComponent(),
                                                    withIntermediateDirectories: true)
            guard FileManager.default.createFile(atPath: path, contents: nil) else {
                throw CocoaError(.fileWriteNoPermission, userInfo: [NSFilePathErrorKey: path])
            }
        }
        let argv = [subcommand] + args
        let plan = ToolsBridge.launchPlan(binaryPath: binary, argv: argv)
        let process = Process()
        priority.configure(process, plan: plan)
        var environment = ToolsBridge.scrubbedEnvironment()
        // The `tools` wrapper stops its child within 2 s once its parent is gone (its orphan watchdog), which is
        // exactly what a detached job must survive; this marker (GenesisTools src/utils/cli/detached.ts) turns
        // that off for this run only. Without it a restart of the app cancelled the build (exit 130).
        environment[Self.detachedMarker] = "1"
        process.environment = environment
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = try FileHandle(forWritingTo: URL(fileURLWithPath: outputPath))
        process.standardError = try FileHandle(forWritingTo: URL(fileURLWithPath: errorPath))
        try process.run()
        priority.applyNice(to: process.processIdentifier)
        let record = Record(pid: process.processIdentifier, startedAt: Date(), outputPath: outputPath,
                            errorPath: errorPath, argv: argv)
        return (record, process)
    }

    /// `DETACHED_ENV` in GenesisTools `src/utils/cli/detached.ts`.
    public static let detachedMarker = "GENESIS_TOOLS_DETACHED"

    /// Where a tail read started. `count` is the bytes asked of the file, not the length of a buffer that was
    /// filled by reading the whole file first.
    struct StderrTailRead: Equatable, Sendable {
        var fileBytes: UInt64
        var offset: UInt64
        var count: Int
    }

    /// The last `limit` bytes of `path`, read from that offset. A missing file is empty. `read` is nil when the
    /// file could not be opened.
    static func stderrTail(at path: String, limit: Int = ToolsLineStream.stderrLimit) -> (data: Data, read: StderrTailRead?) {
        guard let handle = try? FileHandle(forReadingFrom: URL(fileURLWithPath: path)) else {
            return (Data(), nil)
        }
        defer { try? handle.close() }
        do {
            let size = try handle.seekToEnd()
            let count = min(limit, Int(size))
            let offset = size - UInt64(count)
            try handle.seek(toOffset: offset)
            let data = try handle.read(upToCount: count) ?? Data()
            return (data, StderrTailRead(fileBytes: size, offset: offset, count: count))
        } catch {
            return (Data(), nil)
        }
    }

    public let record: Record
    private let process: Process?
    private let queue = DispatchQueue(label: "genesiskit.detached-tools-job", qos: .utility)
    private let onLines: @MainActor ([String]) -> Void
    private let onExit: @MainActor (Exit) -> Void
    private var handle: FileHandle?
    private var fileSource: DispatchSourceFileSystemObject?
    private var exitSource: DispatchSourceProcess?
    private var buffer = ToolsLineBuffer()
    private var stopRequested = false
    private var finished = false

    /// Follows `record`: every line already in the output file, then each new one, on the main queue. `onExit`
    /// runs once, after the last lines. Pass the `Process` from `start` when this instance launched the job.
    public init(record: Record, process: Process? = nil,
                onLines: @escaping @MainActor ([String]) -> Void,
                onExit: @escaping @MainActor (Exit) -> Void) throws {
        self.record = record
        self.process = process
        self.onLines = onLines
        self.onExit = onExit
        let file = try FileHandle(forReadingFrom: URL(fileURLWithPath: record.outputPath))
        handle = file
        let source = DispatchSource.makeFileSystemObjectSource(fileDescriptor: file.fileDescriptor,
                                                               eventMask: [.write, .extend], queue: queue)
        source.setEventHandler { [weak self] in self?.drain() }
        fileSource = source
        source.resume()
        queue.async { [weak self] in self?.drain() }

        if let process {
            process.terminationHandler = { [weak self] _ in
                self?.queue.async { self?.complete() }
            }
            if !process.isRunning { queue.async { [weak self] in self?.complete() } }
        } else {
            // Not our child: a kqueue process source still reports its exit.
            let exit = DispatchSource.makeProcessSource(identifier: record.pid, eventMask: .exit, queue: queue)
            exit.setEventHandler { [weak self] in self?.complete() }
            exitSource = exit
            exit.resume()
            if !record.isAlive { queue.async { [weak self] in self?.complete() } }
        }
    }

    deinit {
        fileSource?.cancel()
        exitSource?.cancel()
    }

    /// SIGTERM to the job (`tools` forwards it to the process that does the work).
    public func stop() {
        queue.async { [weak self] in
            guard let self, !self.finished else { return }
            self.stopRequested = true
            if kill(self.record.pid, SIGTERM) != 0 {
                PerfLog.mark("tools.detached kill \(String(cString: strerror(errno)))")
            }
        }
    }

    private func drain() {
        guard let handle, !finished else { return }
        let data = handle.availableData
        guard !data.isEmpty else { return }
        let lines = buffer.append(data)
        guard !lines.isEmpty else { return }
        let onLines = onLines
        DispatchQueue.main.async {
            MainActor.assumeIsolated { onLines(lines) }
        }
    }

    private func complete() {
        guard !finished else { return }
        drain()
        finished = true
        fileSource?.cancel()
        exitSource?.cancel()
        let status: Int32? = process.map { $0.isRunning ? 0 : $0.terminationStatus }
        let errorData = Self.stderrTail(at: record.errorPath).data
        let report = Exit(status: status, stopped: stopRequested,
                          stderr: String(decoding: errorData, as: UTF8.self))
        let onExit = onExit
        DispatchQueue.main.async {
            MainActor.assumeIsolated { onExit(report) }
        }
    }
}
