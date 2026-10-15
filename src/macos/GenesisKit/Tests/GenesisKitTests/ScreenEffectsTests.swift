import AppKit
import SwiftUI
import XCTest

@testable import GenesisKit

@MainActor
final class ScreenEffectsTests: XCTestCase {
    /// Two made-up displays far off every real screen, so a live panel test never shows anything to the user.
    private let left = ScreenEffectScreen(
        id: "display-a", frame: CGRect(x: -40_000, y: -40_000, width: 800, height: 500),
        visibleFrame: CGRect(x: -40_000, y: -39_930, width: 800, height: 405))
    private let right = ScreenEffectScreen(
        id: "display-b", frame: CGRect(x: -39_200, y: -40_000, width: 600, height: 400),
        visibleFrame: CGRect(x: -39_200, y: -40_000, width: 600, height: 400))

    // MARK: Geometry

    func testTheTargetPicksAllTheMainOrTheCursorsScreen() {
        let screens = [left, right]
        XCTAssertEqual(ScreenEffectGeometry.screens(for: .allScreens, among: screens, cursor: .zero), screens)
        XCTAssertEqual(ScreenEffectGeometry.screens(for: .mainScreen, among: screens, cursor: CGPoint(x: -39_000, y: -39_900)), [left])
        XCTAssertEqual(ScreenEffectGeometry.screens(for: .cursorScreen, among: screens, cursor: CGPoint(x: -39_000, y: -39_900)), [right])
        XCTAssertEqual(ScreenEffectGeometry.screens(for: .cursorScreen, among: screens, cursor: CGPoint(x: 5, y: 5)), [left],
                       "a cursor on no known screen falls back to the main one")
        XCTAssertEqual(ScreenEffectGeometry.screens(for: .allScreens, among: [], cursor: .zero), [])
    }

    func testPanelsCoverTheWholeScreenOrOnlyItsVisiblePart() {
        XCTAssertEqual(ScreenEffectGeometry.panelFrame(on: left, coversMenuBar: true), left.frame)
        XCTAssertEqual(ScreenEffectGeometry.panelFrame(on: left, coversMenuBar: false), left.visibleFrame)
        let bubble = ScreenEffectGeometry.bubbleFrame(on: left)
        XCTAssertEqual(bubble.maxX, left.visibleFrame.maxX - ScreenEffectGeometry.bubbleMargin)
        XCTAssertEqual(bubble.minY, left.visibleFrame.minY + ScreenEffectGeometry.bubbleMargin)
        XCTAssertEqual(bubble.width, ScreenEffectGeometry.bubbleSize)
        // The pill sits a third of the way down the visible part, centred on it (top-left coordinates).
        let pill = ScreenEffectGeometry.pillCenter(panel: left.frame, visible: left.visibleFrame)
        XCTAssertEqual(pill.x, 400)
        XCTAssertEqual(pill.y, 25 + 405 * 0.3, accuracy: 0.001)
        XCTAssertEqual(ScreenEffectGeometry.bubbleScreen(for: .cursorScreen, among: [left, right], cursor: CGPoint(x: -39_000, y: -39_900)), right)
        XCTAssertEqual(ScreenEffectGeometry.bubbleScreen(for: .allScreens, among: [left, right], cursor: .zero), left)
    }

    // MARK: State machine

    func testShowHideAndPreviewFollowTheRules() {
        var machine = ScreenEffectMachine()
        let t0 = Date(timeIntervalSince1970: 1_000)
        XCTAssertEqual(machine.show(at: t0, preview: true), .presented)
        XCTAssertTrue(machine.isPreview)
        XCTAssertEqual(machine.show(at: t0.addingTimeInterval(1), preview: true), .alreadyShown)
        XCTAssertEqual(machine.show(at: t0.addingTimeInterval(2)), .promoted, "a real show turns a preview real")
        XCTAssertFalse(machine.isPreview)
        XCTAssertEqual(machine.deadline(maximumDuration: 60), t0.addingTimeInterval(62), "the clock restarts")
        XCTAssertEqual(machine.show(at: t0.addingTimeInterval(3), preview: true), .alreadyShown, "a preview never replaces a real effect")
        XCTAssertFalse(machine.isPreview)
        XCTAssertNil(machine.deadline(maximumDuration: nil))
        XCTAssertTrue(machine.hide())
        XCTAssertFalse(machine.hide(), "hiding twice reports nothing new")
        XCTAssertNil(machine.deadline(maximumDuration: 60))
    }

    func testTheKillSwitchHidesAndRefusesUntilItsTime() {
        var machine = ScreenEffectMachine()
        let t0 = Date(timeIntervalSince1970: 5_000)
        _ = machine.show(at: t0)
        XCTAssertTrue(machine.suppress(until: t0.addingTimeInterval(600)))
        XCTAssertFalse(machine.isShown)
        XCTAssertEqual(machine.show(at: t0.addingTimeInterval(10)), .suppressed(until: t0.addingTimeInterval(600)))
        XCTAssertEqual(machine.show(at: t0.addingTimeInterval(20), preview: true), .suppressed(until: t0.addingTimeInterval(600)))
        XCTAssertEqual(machine.show(at: t0.addingTimeInterval(601)), .presented, "the suppression ends by itself")
        XCTAssertNil(machine.suppressedUntil)
        machine.suppress(until: t0.addingTimeInterval(9_999))
        machine.clearSuppression()
        XCTAssertEqual(machine.show(at: t0.addingTimeInterval(700)), .presented)
    }

    func testStrengthGrowsWithIntensityAndBlurBecomesDimWithoutTransparency() {
        let soft = ScreenEffectView.vignetteStrength(0.5)
        let strong = ScreenEffectView.vignetteStrength(2)
        XCTAssertLessThan(soft.edge, strong.edge)
        XCTAssertGreaterThan(soft.clearUntil, strong.clearUntil)
        XCTAssertEqual(ScreenEffectView.vignetteStrength(9).edge, strong.edge, "intensity is clamped to 2")
        XCTAssertEqual(ScreenEffectView.blurAlpha(2), 0.85, "a full blur still lets the screen through")
        XCTAssertEqual(ScreenEffectView.blurAlpha(1.4), 0.85)
        XCTAssertEqual(ScreenEffectView.blurAlpha(0), 0)
        XCTAssertLessThanOrEqual(ScreenEffectView.dimOpacity(5), 0.78)
        XCTAssertEqual(ScreenEffectStyle.blur.effective(reduceTransparency: true), .dim)
        XCTAssertEqual(ScreenEffectStyle.blur.effective(reduceTransparency: false), .blur)
        XCTAssertEqual(ScreenEffectStyle.sepia.effective(reduceTransparency: true), .sepia)
        XCTAssertEqual(ScreenEffectConfiguration(intensity: .nan).clampedIntensity, 1)
        XCTAssertEqual(ScreenEffectConfiguration(intensity: -3).clampedIntensity, 0)
    }

    // MARK: Live panels (off screen)

    private func controller(
        _ configuration: ScreenEffectConfiguration, screens: @escaping () -> [ScreenEffectScreen],
        cursor: CGPoint = CGPoint(x: -39_900, y: -39_900), reduceMotion: Bool = true,
        capture: @escaping () -> Bool? = { false }
    ) -> ScreenEffectsController {
        _ = NSApplication.shared
        return ScreenEffectsController(
            configuration: configuration, screens: screens, cursor: { cursor }, reduceMotion: { reduceMotion },
            reduceTransparency: { false }, screenCapture: capture)
    }

    private func spin(_ seconds: TimeInterval) {
        RunLoop.main.run(until: Date().addingTimeInterval(seconds))
    }

    func testOnePanelPerTargetScreenThatNeverTakesClicksOrFocus() throws {
        let effects = controller(ScreenEffectConfiguration(target: .allScreens), screens: { [self.left, self.right] })
        defer { effects.tearDown() }
        XCTAssertTrue(effects.show())
        XCTAssertEqual(effects.panelFrames, ["display-a": left.frame, "display-b": right.frame])
        for panel in effects.panelList {
            XCTAssertTrue(panel.ignoresMouseEvents)
            XCTAssertFalse(panel.canBecomeKey)
            XCTAssertFalse(panel.canBecomeMain)
            XCTAssertFalse(panel.hidesOnDeactivate)
            XCTAssertEqual(panel.level, .statusBar, "below menus and pop-ups, above the Dock and the menu bar")
            XCTAssertEqual(panel.sharingType, NSWindow.SharingType.none)
            XCTAssertTrue(panel.collectionBehavior.isSuperset(of: [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]))
            XCTAssertTrue(panel.isVisible)
            XCTAssertEqual(panel.alphaValue, 1, "no ramp under Reduce Motion")
        }
        // Another target rebuilds the panels on the new screens (the cursor is on the left display).
        effects.configuration.target = .cursorScreen
        XCTAssertEqual(Array(effects.panelFrames.keys), ["display-a"])
        effects.configuration.coversMenuBar = false
        effects.configuration.target = .mainScreen
        XCTAssertEqual(effects.panelFrames, ["display-a": left.visibleFrame])
    }

    func testPanelsFollowADisplayChange() {
        var screens = [left, right]
        let effects = controller(ScreenEffectConfiguration(target: .allScreens), screens: { screens })
        defer { effects.tearDown() }
        effects.show()
        XCTAssertEqual(effects.panelList.count, 2)
        screens = [left]
        effects.rebuild()
        XCTAssertEqual(Array(effects.panelFrames.keys), ["display-a"])
        XCTAssertEqual(effects.panelList.first?.alphaValue, 1, "a rebuild keeps the current strength")
    }

    func testTheEffectHidesItselfAfterItsMaximumDuration() {
        let effects = controller(ScreenEffectConfiguration(maximumDuration: 0.15), screens: { [self.left] })
        defer { effects.tearDown() }
        var timeouts = 0
        var changes: [Bool] = []
        effects.onTimeout = { timeouts += 1 }
        effects.onVisibilityChange = { changes.append($0) }
        effects.show()
        XCTAssertTrue(effects.isVisible)
        spin(0.4)
        XCTAssertFalse(effects.isVisible)
        XCTAssertEqual(timeouts, 1)
        XCTAssertEqual(changes, [true, false])
        XCTAssertFalse(effects.panelList.contains { $0.isVisible }, "hidden panels leave the screen")
    }

    func testTheKillSwitchHidesTheEffectAndBlocksTheNextShow() {
        let effects = controller(ScreenEffectConfiguration(), screens: { [self.left] })
        defer { effects.tearDown() }
        effects.show()
        effects.suppress(until: Date().addingTimeInterval(600))
        XCTAssertFalse(effects.isVisible)
        XCTAssertFalse(effects.show())
        XCTAssertFalse(effects.preview(seconds: 1))
        XCTAssertNotNil(effects.suppressedUntil)
        effects.clearSuppression()
        XCTAssertTrue(effects.show())
    }

    func testAPreviewShowsItsStyleForAFewSecondsAndPutsTheOldOneBack() {
        let base = ScreenEffectConfiguration(style: .vignette, maximumDuration: nil)
        let effects = controller(base, screens: { [self.left] })
        defer { effects.tearDown() }
        var preview = base
        preview.style = .sepia
        XCTAssertTrue(effects.preview(preview, seconds: 0.15))
        XCTAssertTrue(effects.isPreviewing)
        XCTAssertEqual(effects.configuration.style, .sepia)
        spin(0.4)
        XCTAssertFalse(effects.isVisible)
        XCTAssertEqual(effects.configuration.style, .vignette, "the previewed style is not kept")
        // A preview never covers a real effect.
        effects.show()
        XCTAssertFalse(effects.preview(preview, seconds: 0.15))
        XCTAssertEqual(effects.configuration.style, .vignette)
    }

    func testTheCameraBubbleIsNeverSharedAndSitsInTheCorner() throws {
        var configuration = ScreenEffectConfiguration()
        configuration.sharingType = .readOnly
        let effects = controller(configuration, screens: { [self.left, self.right] })
        defer { effects.tearDown() }
        effects.show()
        effects.setCameraBubble(NSView(frame: .zero))
        let bubble = try XCTUnwrap(effects.bubble)
        XCTAssertEqual(bubble.sharingType, NSWindow.SharingType.none)
        XCTAssertEqual(bubble.frame, ScreenEffectGeometry.bubbleFrame(on: left))
        XCTAssertTrue(bubble.ignoresMouseEvents)
        XCTAssertEqual(effects.panelList.first?.sharingType, .readOnly, "the effect itself follows the setting")
        effects.setCameraBubble(nil)
        XCTAssertNil(effects.bubble)
    }

    // MARK: Release and kill switch

    func testAReleasedControllerTakesItsPanelsAndBubbleDown() throws {
        var panels: [NSPanel] = []
        var hosted: NSView? = NSView(frame: .zero)
        weak var released: ScreenEffectsController?
        autoreleasepool {
            let effects = controller(ScreenEffectConfiguration(maximumDuration: nil), screens: { [self.left, self.right] })
            effects.setCameraBubble(hosted)
            effects.show()
            panels = effects.panelList + (effects.bubble.map { [$0] } ?? [])
            released = effects
        }
        XCTAssertNil(released, "nothing else keeps the controller alive")
        XCTAssertEqual(panels.count, 3)
        XCTAssertFalse(panels.contains { $0.isVisible }, "no tearDown(), and still nothing stays on screen")
        XCTAssertNil(hosted?.superview, "the camera view is let go")
        hosted = nil
    }

    func testDismissAllHidesEveryLiveEffectAndCanSuppressThem() {
        let first = controller(ScreenEffectConfiguration(), screens: { [self.left] })
        let second = controller(ScreenEffectConfiguration(), screens: { [self.right] })
        defer {
            first.tearDown()
            second.tearDown()
        }
        first.show()
        second.show()
        ScreenEffectsController.dismissAll(suppressingUntil: Date().addingTimeInterval(600))
        XCTAssertFalse(first.isVisible)
        XCTAssertFalse(second.isVisible)
        XCTAssertFalse((first.panelList + second.panelList).contains { $0.isVisible })
        XCTAssertFalse(first.show(), "the process-wide kill switch suppresses too")
        second.clearSuppression()
        XCTAssertTrue(second.show())
    }

    func testTearDownReportsTheHide() {
        let effects = controller(ScreenEffectConfiguration(), screens: { [self.left] })
        var changes: [Bool] = []
        effects.onVisibilityChange = { changes.append($0) }
        effects.show()
        effects.tearDown()
        effects.tearDown()
        XCTAssertEqual(changes, [true, false])
    }

    func testAnIntensityStepKeepsTheHostingView() throws {
        let effects = controller(ScreenEffectConfiguration(), screens: { [self.left] })
        defer { effects.tearDown() }
        effects.show()
        let host = try XCTUnwrap(effects.panelList.first?.contentView)
        effects.configuration.intensity = 1.35
        XCTAssertTrue(effects.panelList.first?.contentView === host, "the view is updated, not replaced")
    }

    // MARK: Screen capture

    func testTheCameraBubbleHidesWhileTheScreenIsCaptured() throws {
        var capturing: Bool? = true
        let effects = controller(
            ScreenEffectConfiguration(message: ScreenEffectMessage("Sit up straight"), maximumDuration: nil),
            screens: { [self.left] }, capture: { capturing })
        defer { effects.tearDown() }
        effects.setCameraBubble(NSView(frame: .zero))
        effects.show()
        XCTAssertTrue(effects.isScreenCaptureDetected)
        XCTAssertFalse(effects.bubble?.isVisible ?? false, "the face is not shown to a share")
        XCTAssertEqual(effects.drawnMessage?.text, "Sit up straight", "the default keeps the message")
        XCTAssertTrue(effects.panelList.allSatisfy(\.isVisible), "the tint still shows")

        capturing = false
        effects.checkScreenCapture()
        XCTAssertTrue(effects.bubble?.isVisible ?? false, "the bubble comes back when the capture ends")

        capturing = nil
        effects.checkScreenCapture()
        XCTAssertFalse(effects.bubble?.isVisible ?? false, "unknown counts as a capture")
    }

    func testTheOtherCaptureBehaviours() throws {
        var capturing: Bool? = true
        let effects = controller(
            ScreenEffectConfiguration(message: ScreenEffectMessage("Sit up straight"), maximumDuration: nil),
            screens: { [self.left] }, capture: { capturing })
        defer { effects.tearDown() }
        effects.setCameraBubble(NSView(frame: .zero))

        effects.configuration.duringScreenCapture = .hideCameraBubbleAndMessage
        effects.show()
        XCTAssertNil(effects.drawnMessage)
        XCTAssertFalse(effects.bubble?.isVisible ?? false)

        effects.configuration.duringScreenCapture = .holdBack
        XCTAssertTrue(effects.isVisible, "held back is still on")
        XCTAssertFalse(effects.panelList.contains { $0.isVisible }, "nothing is drawn during the capture")
        capturing = false
        effects.checkScreenCapture()
        XCTAssertTrue(effects.panelList.allSatisfy(\.isVisible))
        XCTAssertEqual(effects.drawnMessage?.text, "Sit up straight")

        capturing = true
        effects.configuration.duringScreenCapture = .showEverything
        XCTAssertFalse(effects.isScreenCaptureDetected, "showEverything does not even look")
        XCTAssertTrue(effects.bubble?.isVisible ?? false)
        XCTAssertEqual(effects.drawnMessage?.text, "Sit up straight")
    }

    func testACaptureThatStartsWhileTheEffectIsUpIsSeenWithinASecond() {
        var capturing: Bool? = false
        let effects = controller(ScreenEffectConfiguration(maximumDuration: nil), screens: { [self.left] }, capture: { capturing })
        defer { effects.tearDown() }
        effects.setCameraBubble(NSView(frame: .zero))
        effects.show()
        XCTAssertTrue(effects.bubble?.isVisible ?? false)
        capturing = true
        spin(ScreenEffectsController.captureCheckInterval + 0.4)
        XCTAssertFalse(effects.bubble?.isVisible ?? true)
    }

    func testTheSystemCaptureCheckExistsOnThisMac() {
        XCTAssertTrue(ScreenCaptureDetector.isAvailable, "SLSIsScreenWatcherPresent is gone: the bubble now always hides")
        XCTAssertNotNil(ScreenCaptureDetector.current())
    }

    /// Records a 2 by 2 pixel corner of the screen for two seconds with `screencapture -v` and watches the flag. Opt in
    /// with `GENESISKIT_CAPTURE_PROBE=1`: it starts a real (tiny, local) screen recording.
    func testTheSystemCaptureCheckSeesARealRecording() throws {
        guard ProcessInfo.processInfo.environment["GENESISKIT_CAPTURE_PROBE"] != nil else {
            throw XCTSkip("set GENESISKIT_CAPTURE_PROBE=1 to record two seconds of a 2x2 pixel screen corner")
        }
        XCTAssertEqual(ScreenCaptureDetector.current(), false, "something already captures the screen")
        let movie = FileManager.default.temporaryDirectory.appendingPathComponent("genesiskit-capture-probe-\(UUID()).mov")
        let recorder = Process()
        recorder.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
        recorder.arguments = ["-v", "-V", "2", "-R0,0,2,2", "-x", "-k", movie.path]
        try recorder.run()
        var seen = false
        let deadline = Date().addingTimeInterval(4)
        while Date() < deadline, !seen {
            if ScreenCaptureDetector.current() == true { seen = true }
            spin(0.05)
        }
        recorder.waitUntilExit()
        spin(1)
        XCTAssertTrue(seen, "the recording was not seen")
        XCTAssertEqual(ScreenCaptureDetector.current(), false, "the flag clears after the recording")
    }

    func testTheRampStartsClearAndReachesFullStrength() {
        let effects = controller(ScreenEffectConfiguration(rampIn: 0.25, rampOut: 0.1), screens: { [self.left] }, reduceMotion: false)
        defer { effects.tearDown() }
        effects.show()
        XCTAssertLessThan(effects.panelList.first?.alphaValue ?? 1, 0.5, "the ramp starts from clear")
        spin(0.5)
        XCTAssertEqual(effects.panelList.first?.alphaValue ?? 0, 1, accuracy: 0.01)
        effects.hide()
        spin(0.35)
        XCTAssertFalse(effects.panelList.first?.isVisible ?? true)
    }

    // MARK: Pictures

    /// A bright, busy "desktop" for the effects to sit on.
    private struct Desktop: View {
        var body: some View {
            LinearGradient(colors: [Color(white: 0.92), Color(white: 0.78)], startPoint: .top, endPoint: .bottom)
                .overlay(
                    VStack(spacing: 14) {
                        ForEach(0..<6) { row in
                            RoundedRectangle(cornerRadius: 6).fill(Color(white: row % 2 == 0 ? 0.66 : 0.72))
                                .frame(height: 18)
                        }
                    }.padding(60))
        }
    }

    func testTheVignetteDarkensTheEdgesAndKeepsTheMiddle() throws {
        let size = CGSize(width: 640, height: 400)
        let view = ZStack { Desktop(); ScreenEffectView(style: .vignette, intensity: 1.2) }
        let rep = try KitShots.render(view, size: size, name: "effect-vignette")
        let middle = KitShots.brightness(rep, in: CGRect(x: 280, y: 170, width: 80, height: 60), viewWidth: size.width)
        let corner = KitShots.brightness(rep, in: CGRect(x: 0, y: 0, width: 50, height: 40), viewWidth: size.width)
        XCTAssertGreaterThan(middle, 0.6, "the middle stays clear")
        XCTAssertLessThan(corner, middle * 0.55, "corner \(corner), middle \(middle)")
    }

    func testThePillShowsItsMessageAndTheOtherStylesTint() throws {
        let size = CGSize(width: 640, height: 400)
        let message = ScreenEffectMessage("Sit up straight", symbol: "figure.stand")
        let pill = ZStack { Desktop(); ScreenEffectView(style: .transparent, intensity: 1, message: message, reduceTransparency: true) }
        let rep = try KitShots.render(pill, size: size, name: "effect-pill")
        // The solid pill is dark around a third of the way down; its text is white.
        let pillBand = CGRect(x: 230, y: 108, width: 180, height: 26)
        var white = 0
        var dark = 0
        let scale = CGFloat(rep.pixelsWide) / size.width
        for y in Int(pillBand.minY * scale)..<Int(pillBand.maxY * scale) {
            for x in Int(pillBand.minX * scale)..<Int(pillBand.maxX * scale) {
                guard let c = rep.colorAt(x: x, y: y)?.usingColorSpace(.sRGB) else { continue }
                if c.brightnessComponent > 0.9, c.saturationComponent < 0.1 { white += 1 }
                if c.brightnessComponent < 0.2 { dark += 1 }
            }
        }
        XCTAssertGreaterThan(dark, 200, "the pill's body is drawn")
        XCTAssertGreaterThan(white, 40, "its text is drawn")

        let sepia = try KitShots.render(ZStack { Desktop(); ScreenEffectView(style: .sepia, intensity: 1) }, size: size, name: "effect-sepia")
        let warm = try XCTUnwrap(KitShots.color(sepia, at: CGPoint(x: 30, y: 200), viewWidth: size.width))
        XCTAssertGreaterThan(warm.redComponent, warm.blueComponent + 0.12, "sepia warms the screen")

        let glow = try KitShots.render(ZStack { Desktop(); ScreenEffectView(style: .edgeGlow, intensity: 1) }, size: size, name: "effect-glow")
        let edge = try XCTUnwrap(KitShots.color(glow, at: CGPoint(x: 320, y: 2), viewWidth: size.width))
        let centre = try XCTUnwrap(KitShots.color(glow, at: CGPoint(x: 320, y: 200), viewWidth: size.width))
        XCTAssertGreaterThan(edge.redComponent - edge.blueComponent, 0.25, "the edge glows red")
        XCTAssertLessThan(abs(centre.redComponent - centre.blueComponent), 0.12, "the middle stays neutral")

        let dim = try KitShots.render(ZStack { Desktop(); ScreenEffectView(style: .dim, intensity: 1) }, size: size, name: "effect-dim")
        let dimmed = KitShots.brightness(dim, in: CGRect(x: 280, y: 170, width: 80, height: 60), viewWidth: size.width)
        XCTAssertLessThan(dimmed, 0.6)
        XCTAssertGreaterThan(dimmed, 0.3)
    }
}
