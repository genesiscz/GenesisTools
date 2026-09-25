import Darwin
import Foundation

/// In-process main-thread stack capture for HangWatch.
///
/// `sample` (HangWatch's external capture) attaches about a second after it is spawned, so every
/// stall shorter than ~2 s was written down as an idle main thread: the hub's transcript stalls of
/// 0.6–2.1 s (2026-09-24) never had a single useful stack. This reads the main thread's registers
/// from the watchdog thread while the stall is still going: suspend, read pc/lr/fp, walk the frame
/// pointers with `vm_read_overwrite`, resume. Nothing allocates while the main thread is suspended
/// (it may hold the malloc lock); symbols are resolved with `dladdr` only after the resume.
enum MainStackSampler {
    private static let maxFrames = 64
    private static let lock = NSLock()
    private nonisolated(unsafe) static var mainThread: thread_act_t = 0
    /// Scratch for one capture, allocated once so the suspended window never mallocs.
    private nonisolated(unsafe) static let scratch = UnsafeMutablePointer<UInt>.allocate(capacity: maxFrames)
    /// The stacks of the stall in progress.
    private nonisolated(unsafe) static var stacks: [[UInt]] = []
    private nonisolated(unsafe) static var attempts = 0
    private nonisolated(unsafe) static var firstAttempt: CFAbsoluteTime = 0
    private nonisolated(unsafe) static var lastAttempt: CFAbsoluteTime = 0

    /// Time the sampler's own ping was sent; 0 when none is outstanding.
    private nonisolated(unsafe) static var pingSentAt: CFAbsoluteTime = 0

    /// Called once from the main thread (HangWatch.start). Starts the sampler's own watchdog: a
    /// dedicated userInteractive thread that pings the main queue every 100 ms and starts capturing
    /// 150 ms into a stall. HangWatch's 250 ms utility tick saw real stalls only in their last
    /// milliseconds (1 stack for a 1070 ms stall), so the capture no longer rides on it.
    @MainActor
    static func start(directory: URL) {
        guard mainThread == 0 else { return }
        mainThread = mach_thread_self()
        // `scratch` is a lazy global: its first read runs `allocate` (malloc). Do it here, never
        // while the main thread is suspended and may hold the malloc lock.
        scratch.initialize(repeating: 0, count: maxFrames)
        let thread = Thread {
            while true {
                let now = CFAbsoluteTimeGetCurrent()
                lock.lock()
                let sent = pingSentAt
                if sent == 0 {
                    pingSentAt = now
                }
                lock.unlock()
                if sent == 0 {
                    DispatchQueue.main.async {
                        let ran = CFAbsoluteTimeGetCurrent()
                        // Take this stall's samples in the same critical section that makes the next
                        // ping possible: a later burst can then never land in, or be reset by, this
                        // stall's `finish`.
                        lock.lock()
                        let sentAt = pingSentAt
                        let burst = takeBurstLocked()
                        pingSentAt = 0
                        lock.unlock()
                        let ms = (ran - sentAt) * 1000
                        DispatchQueue.global(qos: .utility).async { finish(burst, stallMs: ms, directory: directory) }
                    }
                    Thread.sleep(forTimeInterval: 0.1)
                } else if now - sent > 0.15 {
                    captureBurst(for: sent, limit: 500)
                    Thread.sleep(forTimeInterval: 0.02)
                } else {
                    Thread.sleep(forTimeInterval: 0.05)
                }
            }
        }
        thread.name = "hub.stall-sampler"
        thread.qualityOfService = .userInteractive
        thread.start()
    }

    /// One stall's samples, taken out of the shared state in one critical section.
    struct Burst {
        var stacks: [[UInt]] = []
        var attempts = 0
        var first: CFAbsoluteTime = 0
        var last: CFAbsoluteTime = 0
    }

    /// Hands over and resets the samples. Call with `lock` held.
    private static func takeBurstLocked() -> Burst {
        let burst = Burst(stacks: stacks, attempts: attempts, first: firstAttempt, last: lastAttempt)
        stacks = []
        attempts = 0
        firstAttempt = 0
        lastAttempt = 0
        return burst
    }

    /// Captures `spacing` apart while the ping sent at `ping` is unanswered, at most `limit` times. Called from the
    /// watchdog queue; one call covers the whole stall, because App Nap stretches the watchdog's own
    /// 250 ms timer in a background app (a 1.5 s test stall got 8 samples when this ran 10 per tick).
    static func captureBurst(for ping: CFAbsoluteTime, limit: Int = 150, spacing: TimeInterval = 0.02) {
        // Only for the length of a stall: without it App Nap stretches every 20 ms sleep of a
        // background app to ~150 ms, and a 1.5 s stall yielded 9 stacks.
        let activity = ProcessInfo.processInfo.beginActivity(options: [.userInitiatedAllowingIdleSystemSleep, .latencyCritical], reason: "main-thread stall capture")
        defer { ProcessInfo.processInfo.endActivity(activity) }
        for index in 0..<limit {
            if index > 0 {
                Thread.sleep(forTimeInterval: spacing)
            }
            lock.lock()
            guard pingSentAt == ping else {
                lock.unlock()
                return
            }
            attempts += 1
            let now = CFAbsoluteTimeGetCurrent()
            if firstAttempt == 0 { firstAttempt = now }
            lastAttempt = now
            lock.unlock()
            if let stack = captureOnce() {
                lock.lock()
                // The main thread may have answered (and taken the burst) while this capture ran:
                // its stack then belongs to that finished stall, not to the next one.
                if pingSentAt == ping, stacks.count < 400 {
                    stacks.append(stack)
                }
                lock.unlock()
            }
        }
    }

    /// Writes one stall's aggregated stacks next to HangWatch's samples. Off the main thread.
    static func finish(_ burst: Burst, stallMs: Double, directory: URL) {
        let taken = burst.stacks
        let tried = burst.attempts
        let spanMs = (burst.last - burst.first) * 1000
        let startedAgo = (CFAbsoluteTimeGetCurrent() - burst.first) * 1000
        guard !taken.isEmpty, stallMs >= 500 else {
            return
        }

        var inclusive: [String: Int] = [:]
        var leaf: [String: Int] = [:]
        var names: [UInt: String] = [:]
        func name(_ address: UInt) -> String {
            if let known = names[address] { return known }
            let resolved = symbolName(address)
            names[address] = resolved
            return resolved
        }
        for stack in taken {
            var seen = Set<String>()
            for (depth, address) in stack.enumerated() {
                let symbol = name(address)
                if depth == 0 {
                    leaf[symbol, default: 0] += 1
                }
                if seen.insert(symbol).inserted {
                    inclusive[symbol, default: 0] += 1
                }
            }
        }
        let total = taken.count
        var text = String(format: "Main-thread stacks captured in process during a %.0f ms stall: %d samples of %d attempts over %.0f ms (first capture %.0f ms before the stall ended).\n", stallMs, total, tried, spanMs, startedAgo)
        text += "Frames by the share of samples they appear in (inclusive), app frames first:\n\n"
        let ranked = inclusive.sorted { lhs, rhs in lhs.value == rhs.value ? lhs.key < rhs.key : lhs.value > rhs.value }
        for (symbol, hits) in ranked.filter({ $0.key.hasPrefix("[GenesisTools]") }).prefix(30) {
            text += String(format: "%5.1f%%  %@\n", Double(hits) * 100 / Double(total), symbol)
        }
        text += "\nAll frames:\n"
        for (symbol, hits) in ranked.prefix(40) {
            text += String(format: "%5.1f%%  %@\n", Double(hits) * 100 / Double(total), symbol)
        }
        text += "\nLeaf frames (where the time was spent):\n"
        for (symbol, hits) in leaf.sorted(by: { $0.value > $1.value }).prefix(15) {
            text += String(format: "%5.1f%%  %@\n", Double(hits) * 100 / Double(total), symbol)
        }
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd-HHmmss"
        let url = directory.appendingPathComponent("stack-\(formatter.string(from: Date())).txt")
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        do {
            try text.write(to: url, atomically: true, encoding: .utf8)
            PerfLog.mark(String(format: "main-stall stacks (%d samples, %.0f ms) → %@", total, stallMs, url.lastPathComponent))
        } catch {
            PerfLog.mark("main-stall stacks not written: \(error.localizedDescription)")
        }
    }

    /// One stack, leaf first; nil when the thread could not be read.
    private static func captureOnce() -> [UInt]? {
        #if arch(arm64)
        let thread = mainThread
        // Never called on the main thread (the watchdog runs on a utility queue). `mach_thread_self()`
        // is not compared here: every call returns a new port right that would have to be released.
        guard thread != 0 else { return nil }
        guard thread_suspend(thread) == KERN_SUCCESS else { return nil }
        var frames = 0
        var state = arm_thread_state64_t()
        var stateCount = mach_msg_type_number_t(MemoryLayout<arm_thread_state64_t>.size / MemoryLayout<natural_t>.size)
        let read = withUnsafeMutablePointer(to: &state) { pointer in
            pointer.withMemoryRebound(to: natural_t.self, capacity: Int(stateCount)) {
                thread_get_state(thread, ARM_THREAD_STATE64, $0, &stateCount)
            }
        }
        if read == KERN_SUCCESS {
            scratch[0] = strip(UInt(state.__pc))
            scratch[1] = strip(UInt(state.__lr))
            frames = 2
            var framePointer = UInt(state.__fp)
            var record: (UInt, UInt) = (0, 0)
            while frames < maxFrames, framePointer != 0, framePointer % 8 == 0 {
                var size = vm_size_t(0)
                let status = withUnsafeMutablePointer(to: &record) { pointer in
                    vm_read_overwrite(mach_task_self_, vm_address_t(framePointer), vm_size_t(16),
                                      vm_address_t(UInt(bitPattern: pointer)), &size)
                }
                guard status == KERN_SUCCESS, size == 16 else { break }
                let (previous, returnAddress) = record
                guard returnAddress != 0 else { break }
                scratch[frames] = strip(returnAddress)
                frames += 1
                guard previous > framePointer else { break }
                framePointer = previous
            }
        }
        thread_resume(thread)
        guard frames > 0 else { return nil }
        return Array(UnsafeBufferPointer(start: scratch, count: frames))
        #else
        // The register read above is ARM64 only; other builds record no stacks.
        return nil
        #endif
    }

    /// Drops pointer-authentication bits from a code address.
    private static func strip(_ address: UInt) -> UInt {
        address & 0x0000_7FFF_FFFF_FFFF
    }

    private typealias Demangle = @convention(c) (UnsafePointer<CChar>?, Int, UnsafeMutablePointer<CChar>?, UnsafeMutablePointer<Int>?, UInt32) -> UnsafeMutablePointer<CChar>?
    private static let demangle: Demangle? = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "swift_demangle")
        .map { unsafeBitCast($0, to: Demangle.self) }

    private static func symbolName(_ address: UInt) -> String {
        var info = Dl_info()
        guard dladdr(UnsafeRawPointer(bitPattern: address), &info) != 0 else {
            return String(format: "0x%lx", address)
        }
        let image = info.dli_fname.map { (String(cString: $0) as NSString).lastPathComponent } ?? "?"
        guard let raw = info.dli_sname else {
            return "[\(image)] 0x\(String(address, radix: 16))"
        }
        var symbol = String(cString: raw)
        if let demangle, let plain = demangle(raw, strlen(raw), nil, nil, 0) {
            symbol = String(cString: plain)
            free(plain)
        }
        if symbol.count > 160 {
            symbol = String(symbol.prefix(160)) + "…"
        }
        return "[\(image)] \(symbol)"
    }
}
/// `GENESIS_HUB_STALL_TEST=<ms>`: blocks the main thread once, 3 s after launch, in a frame with a
/// known name, so a run proves the stall capture end to end (the stack file must name `block(ms:)`).
enum HubStallTest {
    @MainActor
    static func scheduleIfRequested() {
        guard let raw = ProcessInfo.processInfo.environment["GENESIS_HUB_STALL_TEST"], let ms = Double(raw), ms > 0 else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { block(ms: ms) }
    }

    @inline(never)
    static func block(ms: Double) {
        let end = CFAbsoluteTimeGetCurrent() + ms / 1000
        var spins = 0
        while CFAbsoluteTimeGetCurrent() < end {
            spins &+= 1
        }
        PerfLog.mark("stall test: blocked the main thread \(Int(ms)) ms (\(spins) spins)")
    }
}
