//
//  PerfLog.swift
//
//  Lightweight span timing, one file per app: `~/.genesis-tools/logs/app-perf.log` (GenesisTools,
//  read with `scripts/perf-report.ts`) or `~/.genesis/logs/perf.log` (Genesis), plus the unified log
//  under the app's subsystem, category `perf`. Where and whether come from `PerfConfiguration`.
//  From Genesis UI/PerfLog.swift and the GenesisTools copy, 2026-09-30.
//
//  Read the unified log with:
//    log show --last 3m --predicate 'subsystem == "<subsystem>" AND category == "perf"'
//

import Foundation
import os

public enum PerfLog {
    /// The configuration's switch: the environment key wins (`0` / `false` is off), then the default.
    /// Always off under XCTest: every ToolsBridge / ccusage test used to append fake spans
    /// (`monitor.tools.x.`) to the real file.
    public static let enabled: Bool = {
        let config = PerfConfiguration.current
        if let raw = ProcessInfo.processInfo.environment[config.environmentKey] {
            return raw != "0" && raw.lowercased() != "false"
        }
        if NSClassFromString("XCTestCase") != nil { return false }
        return config.enabledByDefault
    }()
    private static let log = Logger(subsystem: PerfConfiguration.current.subsystem, category: "perf")

    /// Wall-clock the process actually started, from the kernel — NOT the first
    /// time this type was touched, so "ms since launch" includes dyld, static
    /// init and everything before our first line of code runs.
    public static let processStart: Date = {
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, ProcessInfo.processInfo.processIdentifier]
        let ok = sysctl(&mib, UInt32(mib.count), &info, &size, nil, 0) == 0
        guard ok else { return Date() }
        let tv = info.kp_proc.p_starttime
        return Date(timeIntervalSince1970: Double(tv.tv_sec) + Double(tv.tv_usec) / 1_000_000)
    }()

    /// Milliseconds since the process started.
    public static var msSinceLaunch: Double { Date().timeIntervalSince(processStart) * 1000 }

    /// Mark a startup phase with its offset from process start. This is the
    /// startup profile: every stage prints `+NNNms` so the gap between two
    /// stages IS the cost of what sits between them.
    public static func phase(_ label: String) {
        guard enabled else { return }
        let ms = msSinceLaunch
        log.info("phase \(label, privacy: .public) +\(ms, format: .fixed(precision: 1))ms")
        append(String(format: "phase %@ +%.1fms since-launch", label, ms))
    }

    /// Time an async block.
    @discardableResult
    public static func spanAsync<T>(_ label: String, _ body: () async throws -> T) async rethrows -> T {
        guard enabled else { return try await body() }
        let t0 = CFAbsoluteTimeGetCurrent()
        let result = try await body()
        emit(label, ms: (CFAbsoluteTimeGetCurrent() - t0) * 1000)
        return result
    }

    /// Time a synchronous block and log its duration (ms). `rethrows` so throwing work (a lock
    /// acquire, a decode) can be spanned without restructuring it — the duration is still emitted for
    /// the success path, which is the one worth measuring.
    @discardableResult
    public static func span<T>(_ label: String, _ body: () throws -> T) rethrows -> T {
        guard enabled else { return try body() }
        let t0 = CFAbsoluteTimeGetCurrent()
        let result = try body()
        emit(label, ms: (CFAbsoluteTimeGetCurrent() - t0) * 1000)
        return result
    }

    /// A span that is written only when the block took at least `minMs`. For
    /// main-thread work that runs per tick or per streamed chunk: logging every
    /// pass would flood the file, logging none left 38 of 2026-09-26's 109
    /// `main-stall` marks with no span near them.
    @discardableResult
    public static func span<T>(_ label: String, over minMs: Double, _ body: () throws -> T) rethrows -> T {
        guard enabled else { return try body() }
        let t0 = CFAbsoluteTimeGetCurrent()
        let result = try body()
        let ms = (CFAbsoluteTimeGetCurrent() - t0) * 1000
        if ms >= minMs { emit(label, ms: ms) }
        return result
    }

    /// One 60 Hz frame: the threshold for `span(_:over:_:)` on main-thread paths.
    public static let frameMs: Double = 16

    /// Log the elapsed time since a recorded start (for spans that cross an
    /// async boundary, e.g. open-dialog → onAppear).
    public static func since(_ label: String, _ start: CFAbsoluteTime?) {
        guard enabled, let start else { return }
        emit(label, ms: (CFAbsoluteTimeGetCurrent() - start) * 1000)
    }

    public static func now() -> CFAbsoluteTime? { enabled ? CFAbsoluteTimeGetCurrent() : nil }

    /// Marks that only fire the FIRST time a label is seen — for things
    /// evaluated many times (SwiftUI bodies) where only the first matters.
    private static let onceLock = NSLock()
    private nonisolated(unsafe) static var seen = Set<String>()

    public static func markOnce(_ label: String) {
        guard enabled else { return }
        onceLock.lock()
        let isNew = seen.insert(label).inserted
        onceLock.unlock()
        guard isNew else { return }
        phase(label)
    }

    public static func mark(_ label: String) {
        guard enabled else { return }
        log.info("mark \(label, privacy: .public)")
        append("mark \(label)")
    }

    private static func emit(_ label: String, ms: Double) {
        log.info("\(label, privacy: .public) \(ms, format: .fixed(precision: 1))ms")
        append(String(format: "%@ %.1fms", label, ms))
    }

    // The unified log is awkward to read back reliably in headless profiling,
    // so also append to a plain file.
    public static let fileURL = PerfConfiguration.current.logDirectory
        .appendingPathComponent(PerfConfiguration.current.fileName)
    /// The one writer of the file: MonitorPerf goes through it too. A second queue on the same file
    /// let two seek-then-write appends land at the same offset, and both rotated it under the other.
    private static let ioQueue = DispatchQueue(label: "\(PerfConfiguration.current.subsystem).perflog")

    private static let stamp: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss.SSS"
        f.locale = Locale(identifier: "en_US_POSIX")
        return f
    }()

    /// Two processes can write one file (Genesis and its Genesis Markdown helper). Untagged, a stall
    /// from either read as the app's: on 2026-09-26 all three hang captures of the 16:25 burst sampled
    /// the helper, and nothing in the 41 `main-stall` lines around them said so.
    private static let tag = PerfConfiguration.current.processTag

    public static func stampedLine(_ line: String, at date: Date, tag: String) -> String {
        "[\(stamp.string(from: date))] " + tag + line + "\n"
    }

    /// The 1-minute load average, for stall marks: at load 18 on 16 cores a
    /// 700 ms stall is starvation, at load 2 it is work on the main thread.
    public static func loadAverage() -> Double {
        var load = [Double](repeating: 0, count: 1)
        return getloadavg(&load, 1) == 1 ? load[0] : -1
    }

    private static func append(_ line: String) {
        // Timestamped: without it two runs interleave in the file and you
        // cannot tell which boot a number belongs to.
        let stamped = stampedLine(line, at: Date(), tag: tag)
        ioQueue.async {
            guard let data = stamped.data(using: .utf8) else { return }
            // Create the directory first. Nothing else on this path does, and
            // every write here is `try?` — so on a machine where the log folder
            // doesn't exist yet (fresh install, or the dir cleaned up), the
            // entire startup profile was silently discarded and PerfLog looked
            // like it was simply disabled.
            try? FileManager.default.createDirectory(
                at: fileURL.deletingLastPathComponent(),
                withIntermediateDirectories: true)
            rotateIfHuge()
            if let handle = try? FileHandle(forWritingTo: fileURL) {
                defer { try? handle.close() }
                _ = try? handle.seekToEnd()
                try? handle.write(contentsOf: data)
            } else {
                try? data.write(to: fileURL)
            }
        }
    }

    /// One rotation, one backup. Debug builds log every span of every refresh
    /// lane, which reached 7 MB in a day (2026-09-03) with nothing bounding it,
    /// and `perf-report.ts` then has to parse a file that is mostly last week.
    public static let rotateBytes = 16 * 1024 * 1024

    public static func rotateIfHuge(
        url: URL = PerfLog.fileURL,
        limit: Int = PerfLog.rotateBytes,
        fileManager: FileManager = .default
    ) {
        guard
            let size = try? fileManager.attributesOfItem(atPath: url.path)[.size] as? Int,
            size >= limit
        else { return }
        let backup = url.appendingPathExtension("1")
        try? fileManager.removeItem(at: backup)
        try? fileManager.moveItem(at: url, to: backup)
    }
}
