// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground/Genesis/apps/Genesis/Sources/Genesis/UI/PerfLog.swift at 2026-09-24T04:59:16+02:00 at commit hash 0d268a43e86e6e5e0ce16132aed8c862e201923e
//
//  PerfLog.swift
//  Genesis
//
//  Lightweight span timing for main-window perf work (cmd-tab activation, the
//  Search dialog, vault open). Zero-cost unless GENESIS_PERF is set in the
//  environment, so it can stay in the code as a durable profiling lever.
//
//  Read the numbers with:
//    log show --last 3m --predicate 'subsystem == "dev.foltyn.genesis" AND category == "perf"'
//

import Foundation
import os

enum PerfLog {
    /// Always on in debug builds — a profiling lever you have to remember to
    /// enable is a profiling lever you don't have when the slow thing happens.
    /// Release builds stay opt-in via GENESIS_PERF, and GENESIS_PERF=0 forces
    /// it off anywhere.
    static let enabled: Bool = {
        // GenesisTools adaptation: GENESIS_TOOLS_PERF, and on by default: the app always ships as a
        // release build (`bun run app`), and the hub's loads must be measured on every run.
        if let raw = ProcessInfo.processInfo.environment["GENESIS_TOOLS_PERF"] {
            return raw != "0" && raw.lowercased() != "false"
        }
        // `swift test` builds debug too, and every ToolsBridge / ccusage test
        // was appending fake spans (`monitor.tools.x.`) to the real perf.log.
        if NSClassFromString("XCTestCase") != nil { return false }
        return true
    }()
    // GenesisTools adaptation: this app's subsystem.
    private static let log = Logger(subsystem: "com.genesiscz.genesistools", category: "perf")

    /// Wall-clock the process actually started, from the kernel — NOT the first
    /// time this type was touched, so "ms since launch" includes dyld, static
    /// init and everything before our first line of code runs.
    static let processStart: Date = {
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, ProcessInfo.processInfo.processIdentifier]
        let ok = sysctl(&mib, UInt32(mib.count), &info, &size, nil, 0) == 0
        guard ok else { return Date() }
        let tv = info.kp_proc.p_starttime
        return Date(timeIntervalSince1970: Double(tv.tv_sec) + Double(tv.tv_usec) / 1_000_000)
    }()

    /// Milliseconds since the process started.
    static var msSinceLaunch: Double { Date().timeIntervalSince(processStart) * 1000 }

    /// Mark a startup phase with its offset from process start. This is the
    /// startup profile: every stage prints `+NNNms` so the gap between two
    /// stages IS the cost of what sits between them.
    static func phase(_ label: String) {
        guard enabled else { return }
        let ms = msSinceLaunch
        log.info("phase \(label, privacy: .public) +\(ms, format: .fixed(precision: 1))ms")
        append(String(format: "phase %@ +%.1fms since-launch", label, ms))
    }

    /// Time an async block.
    @discardableResult
    static func spanAsync<T>(_ label: String, _ body: () async throws -> T) async rethrows -> T {
        guard enabled else { return try await body() }
        let t0 = CFAbsoluteTimeGetCurrent()
        let result = try await body()
        emit(label, ms: (CFAbsoluteTimeGetCurrent() - t0) * 1000)
        return result
    }

    /// Time a synchronous block and log its duration (ms).
    @discardableResult
    /// `rethrows` so throwing work (a lock acquire, a decode) can be spanned
    /// without restructuring it — the duration is still emitted for the
    /// success path, which is the one worth measuring.
    static func span<T>(_ label: String, _ body: () throws -> T) rethrows -> T {
        guard enabled else { return try body() }
        let t0 = CFAbsoluteTimeGetCurrent()
        let result = try body()
        emit(label, ms: (CFAbsoluteTimeGetCurrent() - t0) * 1000)
        return result
    }

    /// Log the elapsed time since a recorded start (for spans that cross an
    /// async boundary, e.g. open-dialog → onAppear).
    static func since(_ label: String, _ start: CFAbsoluteTime?) {
        guard enabled, let start else { return }
        emit(label, ms: (CFAbsoluteTimeGetCurrent() - start) * 1000)
    }

    static func now() -> CFAbsoluteTime? { enabled ? CFAbsoluteTimeGetCurrent() : nil }

    /// Marks that only fire the FIRST time a label is seen — for things
    /// evaluated many times (SwiftUI bodies) where only the first matters.
    private static let onceLock = NSLock()
    private nonisolated(unsafe) static var seen = Set<String>()

    static func markOnce(_ label: String) {
        guard enabled else { return }
        onceLock.lock()
        let isNew = seen.insert(label).inserted
        onceLock.unlock()
        guard isNew else { return }
        phase(label)
    }

    static func mark(_ label: String) {
        guard enabled else { return }
        log.info("mark \(label, privacy: .public)")
        append("mark \(label)")
    }

    private static func emit(_ label: String, ms: Double) {
        log.info("\(label, privacy: .public) \(ms, format: .fixed(precision: 1))ms")
        append(String(format: "%@ %.1fms", label, ms))
    }

    // The unified log is awkward to read back reliably in headless profiling,
    // so also append to a plain file: ~/.genesis/logs/perf.log
    // GenesisTools adaptation: ~/.genesis-tools/logs/app-perf.log (read it with scripts/perf-report.ts).
    static let fileURL = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".genesis-tools/logs/app-perf.log")
    private static let ioQueue = DispatchQueue(label: "com.genesiscz.genesistools.perflog")

    private static let stamp: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss.SSS"
        f.locale = Locale(identifier: "en_US_POSIX")
        return f
    }()

    private static func append(_ line: String) {
        // Timestamped: without it two runs interleave in the file and you
        // cannot tell which boot a number belongs to.
        let stamped = "[\(stamp.string(from: Date()))] " + line + "\n"
        ioQueue.async {
            guard let data = stamped.data(using: .utf8) else { return }
            // Create the directory first. Nothing else on this path does, and
            // every write here is `try?` — so on a machine where
            // ~/.genesis/logs/ doesn't exist yet (fresh install, or the dir
            // cleaned up), the entire startup profile was silently discarded
            // and PerfLog looked like it was simply disabled.
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
    static let rotateBytes = 16 * 1024 * 1024

    static func rotateIfHuge(
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
