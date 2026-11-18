import AppKit
import QuartzCore
import XCTest
@testable import GenesisKit

/// Counts submissions as well as keys: adding the same key twice would still leave just one key on the layer.
private final class ObservedStroke: CAShapeLayer {
    var submissions: [String] = []
    var playback: CAAnimationDelegate?
    var onClear: (() -> Void)?

    override var path: CGPath? {
        didSet {
            if oldValue != nil && path == nil { onClear?() }
        }
    }

    override func add(_ anim: CAAnimation, forKey key: String?) {
        if anim is CAAnimationGroup, let key {
            submissions.append(key)
            anim.delegate = playback
        }
        super.add(anim, forKey: key)
    }
}

private final class PulsePlayback: NSObject, CAAnimationDelegate {
    private let requested = CACurrentMediaTime()
    private let began: XCTestExpectation
    private let finished: XCTestExpectation

    init(began: XCTestExpectation, finished: XCTestExpectation) {
        self.began = began
        self.finished = finished
    }

    func animationDidStart(_ anim: CAAnimation) {
        let ms = (CACurrentMediaTime() - requested) * 1000
        print(String(format: "target-pulse: zero-delay Core Animation start %.2f ms", ms))
        began.fulfill()
    }

    func animationDidStop(_ anim: CAAnimation, finished flag: Bool) {
        XCTAssertTrue(flag, "the choice played both beats to completion")
        finished.fulfill()
    }
}

@MainActor
final class TargetPulseTests: XCTestCase {
    private let left = CGRect(x: -320, y: -40, width: 320, height: 240)
    private let right = CGRect(x: 0, y: 0, width: 320, height: 240)
    private let target = CGRect(x: 40, y: 20, width: 100, height: 80)

    private struct Fixture {
        let pulse: TargetPulse
        let panels: [NSWindow]
        let strokes: [ObservedStroke]
    }

    private func fixture(_ screens: [CGRect], reduced: Bool = false) throws -> Fixture {
        let app = NSApplication.shared
        var strokes: [ObservedStroke] = []
        let pulse = TargetPulse(screens: screens, reduceMotion: { reduced }, makeStroke: {
            let stroke = ObservedStroke()
            strokes.append(stroke)
            return stroke
        })
        let panels = try pulse.windowIDs.map { id in try XCTUnwrap(app.windows.first { $0.windowNumber == id }) }
        // The real panels still order in and out. Their borders must stay invisible on the test machine.
        for panel in panels { panel.alphaValue = 0 }
        return Fixture(pulse: pulse, panels: panels, strokes: strokes)
    }

    func testExclusionIDsExistBeforeShowingAnyPanel() throws {
        let f = try fixture([left, right])
        let ids = f.pulse.windowIDs
        XCTAssertEqual(ids.count, 2)
        XCTAssertEqual(Set(ids).count, 2)
        XCTAssertTrue(ids.allSatisfy { $0 > 0 })
        XCTAssertTrue(f.panels.allSatisfy { !$0.isVisible && $0.sharingType == .none && $0.ignoresMouseEvents })
        XCTAssertTrue(f.panels.allSatisfy { $0.level == .screenSaver && $0.collectionBehavior.contains(.canJoinAllSpaces) })
        f.pulse.hover([target])
        f.pulse.clear()
        XCTAssertEqual(f.pulse.windowIDs, ids)
    }

    func testHoverDrawsBothRectsInLocalCoordinatesAndHidesUntouchedPanels() throws {
        let f = try fixture([left, right])
        defer { f.pulse.clear() }
        let spanning = CGRect(x: -20, y: 50, width: 80, height: 40)
        f.pulse.hover([spanning, target])
        XCTAssertEqual(f.panels.map(\.isVisible), [true, true])
        for (stroke, panel) in zip(f.strokes, f.panels) {
            XCTAssertNotNil(stroke.superlayer)
            XCTAssertTrue(stroke.superlayer === panel.contentView?.layer)
        }
        assertRect(f.strokes[0].path?.boundingBoxOfPath, spanning.offsetBy(dx: 320, dy: 40))
        assertRect(f.strokes[1].path?.boundingBoxOfPath, spanning.union(target))
        XCTAssertEqual(f.strokes.map { $0.submissions.count }, [1, 1])
        f.pulse.hover([spanning, target])
        XCTAssertEqual(f.strokes.map { $0.submissions.count }, [1, 1], "staying over a row does not restart its pulse")

        f.pulse.hover([target])
        XCTAssertEqual(f.panels.map(\.isVisible), [false, true])
        XCTAssertNil(f.strokes[0].path)
        XCTAssertEqual(f.strokes[1].path?.boundingBoxOfPath, target)
        f.pulse.clear()
        XCTAssertTrue(f.panels.allSatisfy { !$0.isVisible })
    }

    func testChoiceSubmitsOneAnimationPerCallAndClearsItsKeyAtTheEnd() async throws {
        let f = try fixture([right])
        defer { f.pulse.clear() }
        let stroke = f.strokes[0]
        let began = expectation(description: "Core Animation started the choice")
        let finished = expectation(description: "Core Animation finished the choice")
        stroke.playback = PulsePlayback(began: began, finished: finished)
        f.pulse.pulse([target], after: .zero)
        let key = try XCTUnwrap(stroke.submissions.first)
        XCTAssertEqual(stroke.submissions, [key])
        let group = try XCTUnwrap(stroke.animation(forKey: key) as? CAAnimationGroup)
        XCTAssertEqual(group.duration, 0.9, accuracy: 0.0001)
        let tracks = try XCTUnwrap(group.animations as? [CAKeyframeAnimation])
        XCTAssertEqual(Set(tracks.compactMap(\.keyPath)), ["opacity", "lineWidth"])
        for track in tracks {
            let values = try XCTUnwrap(track.values as? [NSNumber]).map(\.doubleValue)
            XCTAssertEqual(values.count, 5)
            guard values.count == 5 else { continue }
            XCTAssertGreaterThan(values[1], max(values[0], values[2]))
            XCTAssertGreaterThan(values[3], max(values[2], values[4]))
        }
        XCTAssertEqual(stroke.animationKeys(), [key])
        let ended = expectation(description: "the choice ends")
        stroke.onClear = { ended.fulfill() }
        await fulfillment(of: [began, finished, ended], timeout: 4)
        XCTAssertNil(stroke.animation(forKey: key))
        XCTAssertFalse(f.panels[0].isVisible)

        stroke.playback = nil
        stroke.onClear = nil
        f.pulse.pulse([target], after: .zero)
        XCTAssertEqual(stroke.submissions, [key, key])
        XCTAssertEqual(stroke.animationKeys(), [key])

        let other = target.offsetBy(dx: 120, dy: 0)
        f.pulse.pulse([other], after: .zero)
        try await Task.sleep(for: .milliseconds(80))
        XCTAssertEqual(stroke.submissions, [key, key, key])
        XCTAssertEqual(stroke.animationKeys(), [key], "the replaced choice's completion cannot clear the new choice")
        XCTAssertEqual(stroke.path?.boundingBoxOfPath, other)
    }

    func testHoverSettlesToAThinBorderUntilCleared() async throws {
        let f = try fixture([right])
        defer { f.pulse.clear() }
        f.pulse.hover([target])
        let stroke = f.strokes[0]
        let key = try XCTUnwrap(stroke.submissions.first)
        try await Task.sleep(for: .milliseconds(1100))
        XCTAssertNil(stroke.animation(forKey: key))
        XCTAssertTrue(f.panels[0].isVisible)
        XCTAssertEqual(stroke.path?.boundingBoxOfPath, target)
        XCTAssertEqual(stroke.lineWidth, 1.5)
    }

    func testReduceMotionShowsASteadyThreePointBorderWithoutAnimation() async throws {
        let f = try fixture([right], reduced: true)
        defer { f.pulse.clear() }
        let stroke = f.strokes[0]
        f.pulse.hover([target])
        XCTAssertTrue(f.panels[0].isVisible)
        XCTAssertEqual(stroke.lineWidth, 3)
        XCTAssertTrue((stroke.animationKeys() ?? []).isEmpty)
        f.pulse.clear()
        let ended = expectation(description: "the steady choice ends after its hold")
        let start = CACurrentMediaTime()
        var held: CFTimeInterval = 0
        stroke.onClear = {
            held = CACurrentMediaTime() - start
            ended.fulfill()
        }
        f.pulse.pulse([target], after: .zero)
        XCTAssertTrue(f.panels[0].isVisible)
        XCTAssertEqual(stroke.lineWidth, 3)
        XCTAssertTrue((stroke.animationKeys() ?? []).isEmpty)
        XCTAssertTrue(stroke.submissions.isEmpty)
        await fulfillment(of: [ended], timeout: 4)
        XCTAssertGreaterThanOrEqual(held, 1.2)
        XCTAssertFalse(f.panels[0].isVisible)
    }

    func testClearAndNewHoverSupersedeDelayedChoices() async throws {
        let f = try fixture([left, right])
        defer { f.pulse.clear() }
        f.pulse.pulse([target], after: .milliseconds(30))
        XCTAssertTrue(f.panels.allSatisfy { !$0.isVisible })
        f.pulse.clear()
        try await Task.sleep(for: .milliseconds(80))
        XCTAssertTrue(f.strokes.allSatisfy { $0.submissions.isEmpty })
        f.pulse.pulse([target], after: .milliseconds(30))
        f.pulse.hover([target.offsetBy(dx: -200, dy: 0)])
        try await Task.sleep(for: .milliseconds(80))
        XCTAssertEqual(f.panels.map(\.isVisible), [true, false])
        XCTAssertEqual(f.strokes.map { $0.submissions.count }, [1, 0])

        f.pulse.clear()
        f.pulse.pulse([target], after: .milliseconds(30))
        try await Task.sleep(for: .milliseconds(80))
        XCTAssertEqual(f.panels.map(\.isVisible), [false, true])
        XCTAssertEqual(f.strokes.map { $0.submissions.count }, [1, 1])
    }
}

/// Rounded-rect paths carry floating-point noise (80.00000000000001); compare each edge within a thousandth.
private func assertRect(_ actual: CGRect?, _ expected: CGRect, file: StaticString = #filePath, line: UInt = #line) {
    guard let actual else { return XCTFail("no path", file: file, line: line) }
    for (a, e) in [(actual.minX, expected.minX), (actual.minY, expected.minY), (actual.width, expected.width), (actual.height, expected.height)] {
        XCTAssertEqual(a, e, accuracy: 0.001, file: file, line: line)
    }
}
