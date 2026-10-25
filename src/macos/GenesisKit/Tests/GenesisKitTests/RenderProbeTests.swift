import XCTest
@testable import GenesisKitBase
@testable import GenesisKit

/// Two measurements open at once each count only the bodies that ran inside their own window: starting
/// the second one does not take the first one's counts away.
final class RenderProbeTests: XCTestCase {
    private var wasEnabled = false

    override func setUp() {
        wasEnabled = RenderProbe.enabled
        RenderProbe.enabled = true
        _ = RenderProbe.take()
    }

    override func tearDown() {
        _ = RenderProbe.take()
        RenderProbe.enabled = wasEnabled
    }

    func testOverlappingWindowsKeepTheirOwnCounts() {
        RenderProbe.hit("before")
        let first = RenderProbe.snapshot()
        RenderProbe.hit("row.body")
        let second = RenderProbe.snapshot()
        RenderProbe.hit("row.body")
        RenderProbe.hit("codeBlock.body")

        XCTAssertEqual(RenderProbe.summary(since: second), " bodies[codeBlock.body=1 row.body=1]")
        XCTAssertEqual(RenderProbe.summary(since: first), " bodies[codeBlock.body=1 row.body=2]")
        XCTAssertEqual(RenderProbe.summary(since: RenderProbe.snapshot()), " bodies[none]")
    }

    func testASummaryIsEmptyWhileTheProbeIsOff() {
        let start = RenderProbe.snapshot()
        RenderProbe.hit("row.body")
        RenderProbe.enabled = false

        XCTAssertEqual(RenderProbe.summary(since: start), "")
    }
}

/// A main thread that never idles is a spin even though every ping is served on time (the widget, 2026-10-23).
final class SpinTrackerTests: XCTestCase {
    func testFiveBusySecondsAreASpinReportedOnceThenItsEnd() {
        var tracker = HangWatch.SpinTracker()
        var events: [HangWatch.SpinTracker.Event] = []
        for tick in 0 ... 30 {
            if let event = tracker.step(share: 0.99, now: Double(tick) * 0.25) { events.append(event) }
        }
        if let event = tracker.step(share: 0.1, now: 8) { events.append(event) }
        XCTAssertEqual(events, [.began(seconds: 5), .ended(seconds: 8)])
    }

    func testABusyBurstShorterThanTheThresholdIsNoSpin() {
        var tracker = HangWatch.SpinTracker()
        for tick in 0 ..< 12 { XCTAssertNil(tracker.step(share: 1, now: Double(tick) * 0.25)) }
        XCTAssertNil(tracker.step(share: 0.2, now: 3), "an unreported burst ends silently")
        XCTAssertNil(tracker.step(share: 1, now: 3.25), "a new burst starts its own clock")
    }

    func testTheThreadCPUClockAdvancesWithWork() throws {
        let thread = mach_thread_self()
        let before = try XCTUnwrap(HangWatch.cpuTime(of: thread))
        // Spin until the CPU clock itself passes the bar: a loaded machine preempts the thread, so wall time proves nothing.
        let deadline = Date().addingTimeInterval(2)
        var spins = 0
        var after = before
        while Date() < deadline, after - before <= 0.05 {
            for _ in 0..<10_000 { spins &+= 1 }
            after = try XCTUnwrap(HangWatch.cpuTime(of: thread))
        }
        XCTAssertGreaterThan(after - before, 0.05, "busy work shows as CPU time (\(spins) spins)")
    }
}
