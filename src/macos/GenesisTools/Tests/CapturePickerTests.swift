import XCTest
@testable import GenesisToolsRecorder

final class CapturePickerTests: XCTestCase {
    /// The running recorder face draws the picker for `render.snapshot` and then closes the window it ordered in. A
    /// window made in code releases itself on close by default, so the close and ARC released it twice and the face
    /// crashed in the main queue's autorelease pool pop (EXC_BAD_ACCESS in objc_release, 2026-11-05 06:33).
    @MainActor
    func testThePickerSnapshotInsideTheRunningFaceClosesItsWindowWithoutAnOverRelease() async throws {
        _ = NSApplication.shared
        let out = FileManager.default.temporaryDirectory.appendingPathComponent("picker-snapshot-\(UUID().uuidString).png").path
        defer { try? FileManager.default.removeItem(atPath: out) }
        var request = RecorderRequest()
        request.picker = true
        for _ in 0..<2 {
            _ = try await RecorderRenders.snapshot(request, to: out)
            try await Task.sleep(for: .milliseconds(150))
        }
        XCTAssertTrue(FileManager.default.fileExists(atPath: out))
    }

    func testEachChoiceNamesItsTargetTheWayTheStartCommandTakesIt() {
        XCTAssertEqual(CaptureChoice.target(.window(ids: [41, 42], app: "Editor", title: "notes", pid: 9)).arguments,
                       ["--window", "41,42", "--title", "notes"])
        XCTAssertEqual(CaptureChoice.target(.app(app: "4242", name: "Finder")).arguments, ["--app", "4242"])
        XCTAssertEqual(CaptureChoice.target(.display(index: 1, name: "Side")).arguments, ["--display", "1"])
        XCTAssertEqual(CaptureChoice.area(CGRect(x: 10.4, y: 20, width: 300.6, height: 200)).arguments,
                       ["--region", "10,20,301,200"])
        XCTAssertEqual(CaptureChoice.followPointer.arguments, [])
    }

    func testCocoaRectsBecomeTopLeftScreenPoints() {
        // A 1000 pt tall primary display: a rect 100 pt above its bottom edge, 50 pt tall, starts 850 pt from the top.
        let rect = CaptureChoice.coreGraphicsRect(cocoa: CGRect(x: 30, y: 100, width: 200, height: 50), primaryHeight: 1000)
        XCTAssertEqual(rect, CGRect(x: 30, y: 850, width: 200, height: 50))
    }

    func testDefaultOptionsGiveThePlainStartCommand() {
        XCTAssertEqual(CaptureOptions().startArguments(.followPointer), ["recorder", "start", "--fps", "60"])
    }

    func testEveryOptionReachesTheCommandLine() {
        var options = CaptureOptions()
        options.fps = 30
        options.idleFps = 0.5
        options.threshold = 2.5
        options.systemAudio = true
        options.microphone = true
        options.drawCursor = false
        options.shortcutsOverlay = false
        options.camera = true
        XCTAssertEqual(options.startArguments(.target(.display(index: 0, name: nil)), excludeWindowIds: [77]), [
            "recorder", "start", "--display", "0", "--fps", "30", "--idle-fps", "0.5", "--threshold", "2.5",
            "--audio", "system,mic", "--system-cursor", "--no-shortcuts", "--camera", "--exclude-window-ids", "77",
        ])
    }

    func testOptionsRoundTripThroughDefaultsAndRefuseValuesThePickerDoesNotOffer() throws {
        let suite = "genesistools.tests.capture.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        var options = CaptureOptions()
        options.countdownSeconds = 5
        options.fps = 24
        options.camera = true
        options.save(defaults)
        XCTAssertEqual(CaptureOptions.load(defaults), options)
        defaults.set(7, forKey: CaptureOptions.Key.fps)
        defaults.set(99, forKey: CaptureOptions.Key.countdownSeconds)
        let loaded = CaptureOptions.load(defaults)
        XCTAssertEqual(loaded.fps, 60, "a frame rate the menu does not list falls back to the default")
        XCTAssertEqual(loaded.countdownSeconds, 10)
    }

    func testShortcutBindingsRoundTripAndADamagedValueFallsBackToTheDefault() {
        let chord = HotkeyChord(keyCode: 26, modifiers: HotkeyChord.command)
        XCTAssertEqual(RecorderShortcutBinding(storageValue: RecorderShortcutBinding(chord: chord).storageValue),
                       RecorderShortcutBinding(chord: chord))
        let off = RecorderShortcutBinding(chord: chord, enabled: false)
        XCTAssertEqual(RecorderShortcutBinding(storageValue: off.storageValue), off)
        XCTAssertNil(RecorderShortcutBinding(storageValue: "26"))
        XCTAssertNil(RecorderShortcutBinding(storageValue: nil))
        XCTAssertEqual(RecorderShortcutAction.picker.defaultChord, chord, "⌘7 opens the picker")
    }

    func testShortcutsHaveDistinctCarbonIdsAndDefaultChords() {
        let ids = RecorderShortcutAction.allCases.map(\.hotKeyId)
        XCTAssertEqual(Set(ids).count, ids.count)
        let chords = RecorderShortcutAction.allCases.map { "\($0.defaultChord.keyCode):\($0.defaultChord.modifiers)" }
        XCTAssertEqual(Set(chords).count, chords.count)
        XCTAssertEqual(RecorderShortcutAction.allCases.filter(\.needsLiveRecording), [.stop, .pause, .mark])
    }
}
