// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground/Genesis/apps/Genesis/Sources/Genesis/Focus/Activity/InputCounter.swift at 2026-10-08T05:04:08+02:00 at commit hash 7bd89a24c79510fb90ab0c2a0701c1d085f2023e
import ApplicationServices
import CoreGraphics
import Foundation
import os

/// Spec 22 (S6) T3 — how hard the keyboard and mouse are working, and nothing else.
///
/// One listen-only `CGEvent` tap. The callback increments integers and returns; it never reads
/// a keycode, a character, a modifier combination or a pasteboard. That is not a promise in a
/// comment — there is nowhere in `ActivityStore` to put any of it (see
/// `ActivityStoreTests.testSchemaHasNowhereToStoreKeystrokeContent`).
///
/// Counts are flushed into one-minute buckets. If the system disables the tap (it does, under
/// load), the watchdog re-enables it and records a `capture_gap`, so a quiet hour reads as
/// "not measured" rather than "you did nothing".
public final class InputCounter {
    /// Called once per bucket with the counts accumulated in it. Always on `queue`.
    public var onFlush: ((_ bucketMs: Int64, _ counts: ActivityStore.InputCounts) -> Void)?
    /// Called when the tap died and came back, with the gap it left behind.
    public var onGap: ((_ startedMs: Int64, _ endedMs: Int64, _ reason: String) -> Void)?

    public private(set) var isRunning = false
    private var tap: CFMachPort?
    private var source: CFRunLoopSource?
    private var timer: DispatchSourceTimer?

    private let queue = DispatchQueue(label: "dev.genesis.input-counter")
    private var lock = os_unfair_lock_s()
    private var pending = ActivityStore.InputCounts()
    private var bucketMs: Int64 = InputCounter.bucketStart(Date().timeIntervalSince1970 * 1000)
    private var lastPoint: CGPoint?
    private var tapDisabledAtMs: Int64?

    public static let bucketSeconds: Int64 = 60

    public static func bucketStart(_ epochMs: Double) -> Int64 {
        let ms = Int64(epochMs)
        let width = bucketSeconds * 1_000
        return ms - (ms % width)
    }

    // MARK: - Lifecycle

    /// Starts the tap. Returns false when Accessibility is not granted — the caller shows the
    /// honest "capture is off" state rather than pretending to record.
    @discardableResult
    public func start() -> Bool {
        guard !isRunning else { return true }
        guard PermissionAccess.live.isGranted(.accessibility) else { return false }

        let mask: CGEventMask =
            (1 << CGEventType.keyDown.rawValue) |
            (1 << CGEventType.leftMouseDown.rawValue) |
            (1 << CGEventType.rightMouseDown.rawValue) |
            (1 << CGEventType.scrollWheel.rawValue) |
            (1 << CGEventType.mouseMoved.rawValue)

        let context = Unmanaged.passUnretained(self).toOpaque()
        guard let tap = CGEvent.tapCreate(tap: .cgSessionEventTap,
                                          place: .tailAppendEventTap,
                                          options: .listenOnly,
                                          eventsOfInterest: mask,
                                          callback: { _, type, event, refcon in
                                              guard let refcon else { return Unmanaged.passUnretained(event) }
                                              let counter = Unmanaged<InputCounter>.fromOpaque(refcon).takeUnretainedValue()
                                              counter.handle(type: type, event: event)
                                              return Unmanaged.passUnretained(event)
                                          },
                                          userInfo: context)
        else { return false }

        self.tap = tap
        source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        // Rebase the bucket to now: stop() left it at the minute capture stopped in, and input
        // arriving before the first timer flush would otherwise be filed under that minute.
        flush(now: Date().timeIntervalSince1970 * 1000, force: true)
        CGEvent.tapEnable(tap: tap, enable: true)
        startFlushTimer()
        isRunning = true
        return true
    }

    public func stop() {
        guard isRunning else { return }
        // Forced: the bucket that is still open would otherwise be dropped with the tap.
        flush(now: Date().timeIntervalSince1970 * 1000, force: true)
        timer?.cancel()
        timer = nil
        if let source { CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes) }
        if let tap { CGEvent.tapEnable(tap: tap, enable: false) }
        source = nil
        tap = nil
        isRunning = false
    }

    deinit { stop() }

    // MARK: - Counting

    /// The hot path. No allocation, no event inspection beyond its type.
    private func handle(type: CGEventType, event: CGEvent) {
        switch type {
        case .tapDisabledByTimeout, .tapDisabledByUserInput:
            reenable(reason: type == .tapDisabledByTimeout ? "tap_disabled_by_timeout" : "tap_disabled_by_user_input")
            return
        default:
            break
        }

        os_unfair_lock_lock(&lock)
        switch type {
        case .keyDown:
            pending.keys += 1
        case .leftMouseDown, .rightMouseDown:
            pending.clicks += 1
        case .scrollWheel:
            pending.scrolls += 1
        case .mouseMoved:
            let point = event.location
            if let last = lastPoint {
                let dx = point.x - last.x, dy = point.y - last.y
                pending.px += Int((dx * dx + dy * dy).squareRoot())
            }
            lastPoint = point
        default:
            break
        }
        os_unfair_lock_unlock(&lock)
    }

    /// Test seam: drive the counter without a real tap.
    public func recordForTesting(type: CGEventType, at point: CGPoint? = nil) {
        os_unfair_lock_lock(&lock)
        switch type {
        case .keyDown: pending.keys += 1
        case .leftMouseDown, .rightMouseDown: pending.clicks += 1
        case .scrollWheel: pending.scrolls += 1
        case .mouseMoved:
            if let point {
                if let last = lastPoint {
                    let dx = point.x - last.x, dy = point.y - last.y
                    pending.px += Int((dx * dx + dy * dy).squareRoot())
                }
                lastPoint = point
            }
        default: break
        }
        os_unfair_lock_unlock(&lock)
    }

    // MARK: - Tap watchdog

    private func reenable(reason: String) {
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        if tapDisabledAtMs == nil { tapDisabledAtMs = now }
        guard let tap else { return }
        CGEvent.tapEnable(tap: tap, enable: true)
        // The gap is recorded even though it is short: an unrecorded gap is indistinguishable
        // from an idle user, and those two must never look the same.
        if let started = tapDisabledAtMs {
            onGap?(started, Int64(Date().timeIntervalSince1970 * 1000), reason)
            tapDisabledAtMs = nil
        }
        _ = now
    }

    // MARK: - Flushing

    private func startFlushTimer() {
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + 5, repeating: 5)
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            self.flush(now: Date().timeIntervalSince1970 * 1000)
        }
        timer.resume()
        self.timer = timer
    }

    /// Flushes whenever the wall clock crosses a bucket boundary. `force` flushes the open
    /// bucket as well, which `stop()` needs so the last minute is not lost.
    public func flush(now epochMs: Double, force: Bool = false) {
        let currentBucket = Self.bucketStart(epochMs)
        os_unfair_lock_lock(&lock)
        let counts = pending
        let bucket = bucketMs
        let crossed = currentBucket != bucketMs || force
        if crossed {
            pending = ActivityStore.InputCounts()
            bucketMs = currentBucket
        }
        os_unfair_lock_unlock(&lock)

        guard crossed else { return }
        guard counts != ActivityStore.InputCounts() else { return }
        onFlush?(bucket, counts)
    }

    /// Drops what the open bucket counted when its minute overlaps `from..<to`: that activity was forgotten
    /// (`ActivityStore.forget`), so its counts must not reach the ledger on the next flush.
    public func discardPending(overlapping from: Int64, to: Int64) {
        os_unfair_lock_lock(&lock)
        if bucketMs < to && bucketMs + Self.bucketSeconds * 1_000 > from {
            pending = ActivityStore.InputCounts()
        }
        os_unfair_lock_unlock(&lock)
    }

    /// Everything counted in the bucket that is still open. The HUD sparkline reads this.
    public func snapshot() -> ActivityStore.InputCounts {
        os_unfair_lock_lock(&lock)
        defer { os_unfair_lock_unlock(&lock) }
        return pending
    }
}
