//
//  FrameWatch.swift
//
//  Dropped frames, the lag below HangWatch's 500 ms. A display link on the main run loop measures the
//  gap between two frames; a gap of 50 ms or more is a visible hitch (three frames lost at 60 Hz). Every
//  5 s that had one, a line lands in the perf file with the count, the worst gap and the frames lost,
//  plus `PerfContext` (the open screen and the steps before), so "the Agents tab is laggy" can be read
//  back as which screen dropped how many frames, and after what.
//
//  It runs only while the app is active: a display link wakes the main thread every frame, and a hub
//  behind other apps has nobody to stutter for. `GENESIS_FRAMEWATCH=0` turns it off.
//

import AppKit
import QuartzCore

@MainActor
public final class FrameWatch: NSObject {
    public static let shared = FrameWatch()
    /// A gap this long is a dropped frame worth counting.
    public static let dropMs: Double = 50
    /// One summary line per window that had a drop.
    public static let windowSeconds: Double = 5

    private var link: CADisplayLink?
    private var observers: [NSObjectProtocol] = []
    private var last: CFTimeInterval = 0
    private var windowStart: CFTimeInterval = 0
    private var frames = 0
    private var drops = 0
    private var worstMs = 0.0
    private var lostMs = 0.0

    public static func start() {
        shared.begin()
    }

    private func begin() {
        guard PerfLog.enabled, ProcessInfo.processInfo.environment["GENESIS_FRAMEWATCH"] != "0", observers.isEmpty else { return }
        let center = NotificationCenter.default
        observers = [
            center.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { _ in
                MainActor.assumeIsolated { FrameWatch.shared.resume() }
            },
            center.addObserver(forName: NSApplication.didResignActiveNotification, object: nil, queue: .main) { _ in
                MainActor.assumeIsolated { FrameWatch.shared.pause() }
            },
            center.addObserver(forName: NSWindow.didChangeScreenNotification, object: nil, queue: .main) { _ in
                MainActor.assumeIsolated { FrameWatch.shared.relink() }
            },
            center.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { _ in
                MainActor.assumeIsolated { FrameWatch.shared.relink() }
            },
        ]
        if NSApp?.isActive == true {
            resume()
        }
    }

    private func resume() {
        guard link == nil, let screen = NSScreen.main else { return }
        let next = screen.displayLink(target: self, selector: #selector(tick(_:)))
        next.add(to: .main, forMode: .common)
        link = next
        last = 0
        windowStart = 0
        reset()
    }

    /// A display link keeps the refresh rate of the screen it was made for. A window moved to another
    /// screen, or a changed rate, needs a new link, or the frames lost are counted against the old rate.
    private func relink() {
        guard link != nil else { return }
        pause()
        resume()
    }

    private func pause() {
        flush()
        link?.invalidate()
        link = nil
    }

    @objc private func tick(_ link: CADisplayLink) {
        let now = link.timestamp
        defer { last = now }
        if windowStart == 0 {
            windowStart = now
        }
        guard last > 0 else { return }
        frames += 1
        let gapMs = (now - last) * 1000
        if gapMs >= Self.dropMs {
            let frameMs = max((link.targetTimestamp - link.timestamp) * 1000, 1)
            drops += 1
            worstMs = max(worstMs, gapMs)
            lostMs += gapMs - frameMs
        }
        if now - windowStart >= Self.windowSeconds {
            flush()
            windowStart = now
        }
    }

    private func flush() {
        if drops > 0 {
            PerfLog.mark(
                String(format: "frames %d dropped of %d in %.0fs, worst %.0fms, lost %.0fms", drops, frames, Self.windowSeconds, worstMs, lostMs)
                    + PerfContext.describe()
            )
        }
        reset()
    }

    private func reset() {
        frames = 0
        drops = 0
        worstMs = 0
        lostMs = 0
    }
}
