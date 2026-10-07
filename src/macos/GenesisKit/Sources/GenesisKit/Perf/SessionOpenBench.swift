//
//  SessionOpenBench.swift
//
//  Times one open of a session screen in a window nobody sees (alpha 0, below the desktop, never
//  activated): first frame, first transcript rows, main-thread busy time and the longest pass until the
//  main thread has been quiet for 3 s, a 40-step scroll, the CPU of the app and of every `tools` child,
//  and the memory footprint. Used by the bench tests of both apps (Genesis SessionDetailsBenchTests,
//  GenesisTools HubSessionDetailBenchTests), one open per process; it costs nothing until a test calls it.
//

import AppKit
import Darwin

@MainActor
public final class SessionOpenBench {
    public init() {}

    public struct Result {
        public var values: [String: Double] = [:]
        public var counts: [String: Int] = [:]
    }

    private var rowsVisibleAt: CFAbsoluteTime?
    private var observer: CFRunLoopObserver?

    /// Opens the window `make` returns, then measures until the main thread has been quiet for 3 s (at most
    /// 60 s), then scrolls the transcript up in 40 steps, then waits for every `tools` child but the live
    /// follow to exit (at most 30 s).
    public func run(_ make: () -> (NSWindow, AnyObject)) -> Result {
        var result = Result()
        RenderProbe.enabled = true
        _ = RenderProbe.take()
        let children0 = Self.cpuTime(RUSAGE_CHILDREN)
        let self0 = Self.cpuTime(RUSAGE_SELF)
        let footprint0 = Self.footprint().current
        let meter = MainBusy.Meter()
        let t0 = CFAbsoluteTimeGetCurrent()
        meter.start()
        let made = make()
        let window = made.0
        window.alphaValue = 0
        window.level = .init(rawValue: Int(CGWindowLevelForKey(.desktopWindow)) - 1)
        window.orderFrontRegardless()
        window.displayIfNeeded()
        RunLoop.main.run(until: Date())
        result.values["firstFrameMs"] = (CFAbsoluteTimeGetCurrent() - t0) * 1000

        // "Rows visible": the first run-loop pass that evaluated a transcript row's body.
        let observer = CFRunLoopObserverCreateWithHandler(kCFAllocatorDefault, CFRunLoopActivity.beforeWaiting.rawValue, true, Int.max - 1) { [weak self] _, _ in
            guard let self, self.rowsVisibleAt == nil, (RenderProbe.snapshot()["row.body"] ?? 0) > 0 else { return }
            self.rowsVisibleAt = CFAbsoluteTimeGetCurrent()
        }
        CFRunLoopAddObserver(CFRunLoopGetMain(), observer, .commonModes)
        self.observer = observer

        var last = meter.read().busyMs
        var quietSince = CFAbsoluteTimeGetCurrent()
        var lastBusyAt = t0
        while CFAbsoluteTimeGetCurrent() - t0 < 60 {
            RunLoop.main.run(until: Date().addingTimeInterval(0.1))
            let now = CFAbsoluteTimeGetCurrent()
            let total = meter.read(now: now).busyMs
            if total - last >= 8 {
                quietSince = now
                lastBusyAt = now
            }
            last = total
            if rowsVisibleAt != nil, now - quietSince >= 3 {
                break
            }
        }
        CFRunLoopRemoveObserver(CFRunLoopGetMain(), observer, .commonModes)
        let load = meter.stop()
        result.values["rowsVisibleMs"] = rowsVisibleAt.map { ($0 - t0) * 1000 } ?? -1
        result.values["settledMs"] = (lastBusyAt - t0) * 1000
        result.values["mainBusyMs"] = load.busyMs
        result.values["longestStallMs"] = load.longestMs
        result.values["footprintAfterLoadMB"] = Self.footprint().current - footprint0
        let probes = RenderProbe.snapshot()
        result.counts["rowBodies"] = probes["row.body"] ?? 0
        result.counts["toolRowLoads"] = probes["toolRow.load"] ?? 0
        result.counts["toolChangeProcesses"] = probes["toolChanges.process.tools"] ?? 0
        result.counts["gitProcesses"] = probes["toolChanges.process.git"] ?? 0

        let steps = scroll(window)
        result.counts["scrollSteps"] = steps.count
        if !steps.isEmpty {
            let sorted = steps.sorted()
            result.values["scrollStepP50Ms"] = sorted[sorted.count / 2]
            result.values["scrollStepP95Ms"] = sorted[min(sorted.count - 1, Int(Double(sorted.count) * 0.95))]
            result.values["scrollStepMaxMs"] = sorted.last ?? 0
            result.counts["scrollStepsOver50Ms"] = steps.filter { $0 >= 50 }.count
            result.counts["scrollStepsOver16Ms"] = steps.filter { $0 >= 16.7 }.count
        }

        // Every child but the live follow has to finish for its CPU to count.
        let waitStart = CFAbsoluteTimeGetCurrent()
        while CFAbsoluteTimeGetCurrent() - waitStart < 30, !Self.descendants().filter({ !Self.isLiveFollow($0) }).isEmpty {
            RunLoop.main.run(until: Date().addingTimeInterval(0.1))
        }
        let live = Self.descendants()
        result.counts["liveChildren"] = live.count
        let liveCpu = live.reduce(0.0) { $0 + Self.cpuMs(pid: $1) }
        let children1 = Self.cpuTime(RUSAGE_CHILDREN)
        let self1 = Self.cpuTime(RUSAGE_SELF)
        result.values["childCpuMs"] = children1 - children0 + liveCpu
        result.values["appCpuMs"] = self1 - self0
        result.values["peakFootprintMB"] = Self.footprint().peak
        result.counts["toolChangeProcessesTotal"] = RenderProbe.snapshot()["toolChanges.process.tools"] ?? 0
        window.orderOut(nil)
        window.close()
        withExtendedLifetime(made.1) {}
        return result
    }

    /// Scrolls the biggest scroll view (the transcript list) up, 40 steps of 150 pt, one frame apart, and
    /// returns each step's main-thread busy time.
    private func scroll(_ window: NSWindow) -> [Double] {
        guard let root = window.contentView, let scroll = Self.scrollViews(in: root).max(by: {
            ($0.documentView?.frame.height ?? 0) < ($1.documentView?.frame.height ?? 0)
        }) else { return [] }
        var steps: [Double] = []
        let clip = scroll.contentView
        for _ in 0..<40 {
            let y = clip.bounds.origin.y
            guard y > 0 else { break }
            let meter = MainBusy.Meter()
            meter.start()
            clip.scroll(to: NSPoint(x: clip.bounds.origin.x, y: max(0, y - 150)))
            scroll.reflectScrolledClipView(clip)
            RunLoop.main.run(until: Date().addingTimeInterval(0.034))
            steps.append(meter.stop().busyMs)
        }
        return steps
    }

    private static func scrollViews(in view: NSView) -> [NSScrollView] {
        var found: [NSScrollView] = []
        if let scroll = view as? NSScrollView { found.append(scroll) }
        for sub in view.subviews { found += scrollViews(in: sub) }
        return found
    }

    // MARK: Process numbers

    private static func cpuTime(_ who: Int32) -> Double {
        var usage = rusage()
        getrusage(who, &usage)
        func ms(_ t: timeval) -> Double { Double(t.tv_sec) * 1000 + Double(t.tv_usec) / 1000 }
        return ms(usage.ru_utime) + ms(usage.ru_stime)
    }

    private static func footprint() -> (current: Double, peak: Double) {
        var info = rusage_info_v4()
        let ok = withUnsafeMutablePointer(to: &info) { pointer in
            pointer.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) { proc_pid_rusage(getpid(), RUSAGE_INFO_V4, $0) }
        }
        guard ok == 0 else { return (-1, -1) }
        return (Double(info.ri_phys_footprint) / 1_048_576, Double(info.ri_lifetime_max_phys_footprint) / 1_048_576)
    }

    private static let timebase: Double = {
        var info = mach_timebase_info_data_t()
        mach_timebase_info(&info)
        return Double(info.numer) / Double(info.denom)
    }()

    private static func cpuMs(pid: pid_t) -> Double {
        var info = rusage_info_v2()
        let ok = withUnsafeMutablePointer(to: &info) { pointer in
            pointer.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) { proc_pid_rusage(pid, RUSAGE_INFO_V2, $0) }
        }
        guard ok == 0 else { return 0 }
        return Double(info.ri_user_time + info.ri_system_time) * timebase / 1_000_000
    }

    static func descendants(of parent: pid_t = getpid()) -> [pid_t] {
        var pids = [pid_t](repeating: 0, count: 256)
        let count = pids.withUnsafeMutableBufferPointer { buffer in
            proc_listchildpids(parent, buffer.baseAddress, Int32(buffer.count * MemoryLayout<pid_t>.size))
        }
        guard count > 0 else { return [] }
        let children = Array(pids.prefix(Int(count))).filter { $0 > 0 }
        return children + children.flatMap { descendants(of: $0) }
    }

    /// The live follow (`sessions tail … --live`) and its own children stay up for as long as the window.
    static func isLiveFollow(_ pid: pid_t) -> Bool {
        var current = pid
        for _ in 0..<4 {
            if arguments(of: current).contains("--live") { return true }
            var info = proc_bsdinfo()
            let size = proc_pidinfo(current, PROC_PIDTBSDINFO, 0, &info, Int32(MemoryLayout<proc_bsdinfo>.size))
            guard size > 0, info.pbi_ppid > 1, pid_t(info.pbi_ppid) != getpid() else { return false }
            current = pid_t(info.pbi_ppid)
        }
        return false
    }

    private static func arguments(of pid: pid_t) -> [String] {
        var mib: [Int32] = [CTL_KERN, KERN_PROCARGS2, pid]
        var size = 0
        guard sysctl(&mib, 3, nil, &size, nil, 0) == 0, size > 0 else { return [] }
        var buffer = [CChar](repeating: 0, count: size)
        guard sysctl(&mib, 3, &buffer, &size, nil, 0) == 0 else { return [] }
        let bytes = buffer.prefix(size).map { UInt8(bitPattern: $0) }
        return bytes.dropFirst(MemoryLayout<Int32>.size).split(separator: 0).map { String(decoding: $0, as: UTF8.self) }
    }

    // MARK: Output

    public static func append(_ result: Result, label: String, sessionId: String, to path: String) throws {
        var load = [Double](repeating: 0, count: 1)
        getloadavg(&load, 1)
        var object: [String: Any] = [
            "arm": label,
            "session": String(sessionId.prefix(8)),
            "at": ISO8601DateFormatter().string(from: Date()),
            "load1": load[0],
        ]
        for (key, value) in result.values { object[key] = (value * 10).rounded() / 10 }
        for (key, value) in result.counts { object[key] = value }
        let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        let url = URL(fileURLWithPath: path)
        if !FileManager.default.fileExists(atPath: path) {
            FileManager.default.createFile(atPath: path, contents: nil)
        }
        let handle = try FileHandle(forWritingTo: url)
        defer { try? handle.close() }
        try handle.seekToEnd()
        try handle.write(contentsOf: data + Data("\n".utf8))
    }
}
