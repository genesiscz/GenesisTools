import SwiftUI
import XCTest
@testable import GenesisToolsRecorder

/// Settings → Recorder: the defaults of the three new choices, the decisions they drive (where a failure goes, when the
/// camera preview shows, what an idle shortcut does), and the page's bindings writing the keys the readers read.
@MainActor
final class RecorderSettingsTests: XCTestCase {
    private var suiteName = ""
    private var defaults: UserDefaults!

    override func setUp() async throws {
        suiteName = "genesistools.tests.recorder-settings.\(UUID().uuidString)"
        defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
    }

    override func tearDown() async throws {
        defaults.removePersistentDomain(forName: suiteName)
        RecorderNotice.outlets = .live
    }

    /// The defect: the note measured its own host with no sizing options (0 x 0), so every failure note opened as an
    /// invisible 0 x 0 window (review 2026-11-06).
    @MainActor
    func testAFailureNoteIsMeasuredAtItsRealSizeBeforeItShows() {
        let short = RecorderNoticePanel.measure(text: "The recording did not start.", more: nil)
        XCTAssertEqual(short.width, RecorderNoticePanel.width)
        XCTAssertGreaterThan(short.height, 24)
        let long = RecorderNoticePanel.measure(text: String(repeating: "The recording did not start. ", count: 8),
                                               more: "exit 2")
        XCTAssertGreaterThan(long.height, short.height, "a longer message wraps onto more lines")
    }

    func testNothingStoredGivesTheDefaultsAndADamagedValueFallsBackToThem() {
        XCTAssertEqual(RecorderFailureStyle.load(defaults), .notice)
        XCTAssertEqual(CameraPreviewPolicy.load(defaults), .everyCameraRecording)
        XCTAssertEqual(IdleShortcutFeedback.load(defaults), .note)

        defaults.set("modal", forKey: RecorderFailureStyle.key)
        defaults.set(3, forKey: CameraPreviewPolicy.key)
        defaults.set("loud", forKey: IdleShortcutFeedback.key)
        XCTAssertEqual(RecorderFailureStyle.load(defaults), .notice)
        XCTAssertEqual(CameraPreviewPolicy.load(defaults), .everyCameraRecording)
        XCTAssertEqual(IdleShortcutFeedback.load(defaults), .note)

        defaults.set("alert", forKey: RecorderFailureStyle.key)
        defaults.set("picker", forKey: CameraPreviewPolicy.key)
        defaults.set("beep", forKey: IdleShortcutFeedback.key)
        XCTAssertEqual(RecorderFailureStyle.load(defaults), .alert)
        XCTAssertEqual(CameraPreviewPolicy.load(defaults), .pickerRecordings)
        XCTAssertEqual(IdleShortcutFeedback.load(defaults), .beep)
    }

    func testTheKeysNestUnderTheRecorderAndItsArea() {
        XCTAssertEqual(RecorderFailureStyle.key, "recorder.failures.style")
        XCTAssertEqual(CameraPreviewPolicy.key, "recorder.camera.preview")
        XCTAssertEqual(IdleShortcutFeedback.key, "recorder.shortcuts.idleFeedback")
    }

    func testTheCameraPreviewShowsByPolicyAndWhoStartedTheRecording() {
        XCTAssertTrue(CameraPreviewPolicy.everyCameraRecording.showsPreview(startedByPicker: true))
        XCTAssertTrue(CameraPreviewPolicy.everyCameraRecording.showsPreview(startedByPicker: false),
                      "a CLI or agent recording with the camera shows the preview by default")
        XCTAssertTrue(CameraPreviewPolicy.pickerRecordings.showsPreview(startedByPicker: true))
        XCTAssertFalse(CameraPreviewPolicy.pickerRecordings.showsPreview(startedByPicker: false))
        XCTAssertFalse(CameraPreviewPolicy.never.showsPreview(startedByPicker: true))
        XCTAssertFalse(CameraPreviewPolicy.never.showsPreview(startedByPicker: false))
        XCTAssertEqual(CameraPreviewPolicy.allCases.filter(\.showsWhilePicking), [.everyCameraRecording, .pickerRecordings])
    }

    func testAFailureIsANoteByDefaultAndAnAlertWhenChosen() {
        var calls: [String] = []
        RecorderNotice.outlets = recordingOutlets { calls.append($0) }

        RecorderNotice.failure("“Demo” has no movie to copy.", more: "  \n", defaults: defaults)
        XCTAssertEqual(calls, ["notice: “Demo” has no movie to copy. | -"], "blank output is no Details")

        defaults.set("alert", forKey: RecorderFailureStyle.key)
        RecorderNotice.failure("The recording did not start.", more: "exit 2", defaults: defaults)
        XCTAssertEqual(calls.last, "alert: The recording did not start. | exit 2")
        XCTAssertEqual(calls.count, 2)
    }

    func testAShortcutWithNothingToActOnFollowsItsSetting() {
        var calls: [String] = []
        RecorderNotice.outlets = recordingOutlets { calls.append($0) }

        RecorderNotice.nothingToActOn("Nothing to stop", detail: "No recording is running", defaults: defaults)
        XCTAssertEqual(calls, ["note: Nothing to stop | No recording is running"], "the default makes no sound")

        defaults.set("beep", forKey: IdleShortcutFeedback.key)
        RecorderNotice.nothingToActOn("Nothing to stop", detail: "No recording is running", defaults: defaults)
        XCTAssertEqual(calls.last, "beep")

        defaults.set("nothing", forKey: IdleShortcutFeedback.key)
        RecorderNotice.nothingToActOn("Nothing to stop", detail: "No recording is running", defaults: defaults)
        XCTAssertEqual(calls.count, 2, "Nothing shows nothing and plays nothing")

        XCTAssertEqual(RecorderShortcutActions.nothingToActOnTitle(.stop), "Nothing to stop")
        XCTAssertEqual(RecorderShortcutActions.nothingToActOnTitle(.pause), "Nothing to pause")
        XCTAssertEqual(RecorderShortcutActions.nothingToActOnTitle(.mark), "Nothing to mark")
    }

    func testRenameAsksInThePanelByDefaultAndGivesATrimmedNewTitleOnly() {
        var calls: [String] = []
        var panelAnswer: String? = "  Weekly demo  "
        RecorderNotice.outlets = recordingOutlets({ calls.append($0) }, panelAnswer: { panelAnswer }, alertAnswer: "From the alert")
        let request = RecorderTitleRequest(heading: "Rename “Demo”", detail: "Where it shows.", current: "Demo")
        var answers: [String?] = []

        RecorderNotice.askTitle(request, defaults: defaults) { answers.append($0) }
        panelAnswer = "Demo"
        RecorderNotice.askTitle(request, defaults: defaults) { answers.append($0) }
        panelAnswer = "   "
        RecorderNotice.askTitle(request, defaults: defaults) { answers.append($0) }
        panelAnswer = nil
        RecorderNotice.askTitle(request, defaults: defaults) { answers.append($0) }
        XCTAssertEqual(answers, ["Weekly demo", nil, nil, nil], "unchanged, empty and cancelled titles rename nothing")
        XCTAssertEqual(calls, Array(repeating: "titlePanel: Rename “Demo”", count: 4))

        defaults.set("alert", forKey: RecorderFailureStyle.key)
        RecorderNotice.askTitle(request, defaults: defaults) { answers.append($0) }
        XCTAssertEqual(calls.last, "titleAlert: Rename “Demo”")
        XCTAssertEqual(answers.last, "From the alert")
    }

    func testTheNoteSitsUnderTheMenuBarItemInsideTheScreen() {
        let visible = CGRect(x: 0, y: 0, width: 1440, height: 875)
        let size = CGSize(width: 340, height: 44)
        // An item in the middle of the menu bar: centred under it, 6 pt below.
        XCTAssertEqual(RecorderNoticePanel.origin(size: size, anchor: CGRect(x: 900, y: 875, width: 30, height: 25), visible: visible),
                       CGPoint(x: 745, y: 825))
        // Near the right edge: pulled inside the screen, 8 pt from it.
        XCTAssertEqual(RecorderNoticePanel.origin(size: size, anchor: CGRect(x: 1420, y: 875, width: 30, height: 25), visible: visible),
                       CGPoint(x: 1092, y: 825))
        // No item on screen: the top right corner.
        XCTAssertEqual(RecorderNoticePanel.origin(size: size, anchor: nil, visible: visible), CGPoint(x: 1088, y: 819))
    }

    func testThePageWritesTheKeysTheRecorderReads() {
        let model = RecorderSettingsModel(defaults: defaults, broadcasts: false)

        XCTAssertEqual(model.capture(\.fps).wrappedValue, 60)
        model.capture(\.fps).wrappedValue = 30
        model.capture(\.countdown).wrappedValue = false
        XCTAssertEqual(CaptureOptions.load(defaults).fps, 30)
        XCTAssertFalse(CaptureOptions.load(defaults).countdown)

        let chord = HotkeyChord(keyCode: 26, modifiers: HotkeyChord.command | HotkeyChord.shift)
        model.setShortcut(.picker, RecorderShortcutBinding(chord: chord, enabled: true))
        model.setShortcut(.mark, RecorderShortcutBinding(chord: RecorderShortcutAction.mark.defaultChord, enabled: false))
        XCTAssertEqual(RecorderShortcutBinding.load(.picker, defaults: defaults), RecorderShortcutBinding(chord: chord))
        XCTAssertFalse(RecorderShortcutBinding.load(.mark, defaults: defaults).enabled)

        XCTAssertEqual(model.choice(CameraPreviewPolicy.key, CameraPreviewPolicy.everyCameraRecording).wrappedValue, .everyCameraRecording)
        model.choice(CameraPreviewPolicy.key, CameraPreviewPolicy.everyCameraRecording).wrappedValue = .never
        XCTAssertEqual(CameraPreviewPolicy.load(defaults), .never)
        model.choice(RecorderFailureStyle.key, RecorderFailureStyle.notice).wrappedValue = .alert
        XCTAssertEqual(RecorderFailureStyle.load(defaults), .alert)
        model.choice(IdleShortcutFeedback.key, IdleShortcutFeedback.note).wrappedValue = .nothing
        XCTAssertEqual(IdleShortcutFeedback.load(defaults), .nothing)

        // A stored value the control does not offer reads as the reader's default.
        defaults.set(5, forKey: EditorModel.lanesShownKey)
        XCTAssertEqual(model.int(EditorModel.lanesShownKey, 4, allowed: EditorModel.lanesShownChoices).wrappedValue, 4)
        model.int(EditorModel.lanesShownKey, 4, allowed: EditorModel.lanesShownChoices).wrappedValue = 6
        XCTAssertEqual(defaults.object(forKey: EditorModel.lanesShownKey) as? Int, 6)
        model.double(EditorModel.idleMinKey, 2).wrappedValue = 5
        XCTAssertEqual(defaults.object(forKey: EditorModel.idleMinKey) as? Double, 5, "the Clip tab reads a Double")
        model.bool(RecorderShortcuts.alwaysHeldKey, false).wrappedValue = true
        XCTAssertTrue(defaults.bool(forKey: RecorderShortcuts.alwaysHeldKey))
    }

    func testThePlugInAddsTheRecorderSectionWithItsTwoPages() throws {
        let host = FakeSettingsHost(defaults: defaults)
        RecorderSettingsPlugin().install(in: host)
        let section = try XCTUnwrap(host.sections.first)
        XCTAssertEqual(host.sections.count, 1)
        XCTAssertEqual(section.id, "recorder")
        XCTAssertEqual(section.pages.map(\.id), [RecorderSettingsPlugin.recordingPageID, RecorderSettingsPlugin.editorPageID])
        XCTAssertNil(NativeSettingsStore.validate([section]))
    }

    // MARK: Helpers

    private func recordingOutlets(_ record: @escaping (String) -> Void, panelAnswer: @escaping () -> String? = { nil },
                                  alertAnswer: String? = nil) -> RecorderNoticeOutlets {
        RecorderNoticeOutlets(
            notice: { record("notice: \($0) | \($1 ?? "-")") },
            alert: { record("alert: \($0) | \($1 ?? "-")") },
            note: { record("note: \($0) | \($1)") },
            beep: { record("beep") },
            titlePanel: { request, done in
                record("titlePanel: \(request.heading)")
                done(panelAnswer())
            },
            titleAlert: { request in
                record("titleAlert: \(request.heading)")
                return alertAnswer
            })
    }
}

@MainActor
private final class FakeSettingsHost: FeatureSettingsPluginHost {
    let mode = FeatureSettingsMode.snapshot
    let defaults: UserDefaults
    let appearance: NativeSettingsAppearance
    private(set) var sections: [NativeSettingsSection] = []

    init(defaults: UserDefaults) {
        self.defaults = defaults
        appearance = NativeSettingsAppearance(defaults: defaults, observeExternalChanges: false)
    }

    func register(section: NativeSettingsSection) -> Bool {
        sections.append(section)
        return true
    }

    func showSettings(pageID: String?) {}
    func addAboutInfo(_ line: String) {}
}
