import XCTest
@testable import GenesisToolsRecorder

/// The defect: an app chosen in the capture picker started `tools recorder start --app <pid>` with no title, so the
/// library, the menu and the export file name showed the pid; an untitled window showed "window <id>". The start
/// command now gets the line the picker shows as `--title`, and keeps the pid as the target.
final class RecorderHuntPickerAppTitleTests: XCTestCase {
    func testAnAppStartsWithItsNameAsTheTitleAndKeepsItsPidAsTheTarget() {
        XCTAssertEqual(CaptureChoice.target(.app(app: "501", name: "Notes")).arguments,
                       ["--app", "501", "--title", "Notes"])
    }

    func testAnUntitledWindowStartsWithItsAppNameAsTheTitle() {
        XCTAssertEqual(CaptureChoice.target(.window(ids: [7], app: "Safari", title: nil, pid: 9)).arguments,
                       ["--window", "7", "--title", "Safari"])
        XCTAssertEqual(CaptureChoice.target(.window(ids: [7], app: "Safari", title: "", pid: 9)).arguments,
                       ["--window", "7", "--title", "Safari"])
    }

    func testATargetWithNoNameLeavesTheTitleToTheRecorder() {
        XCTAssertEqual(CaptureChoice.target(.app(app: "501", name: nil)).arguments, ["--app", "501"])
        XCTAssertEqual(CaptureChoice.target(.window(ids: [7], app: nil, title: nil, pid: nil)).arguments, ["--window", "7"])
        XCTAssertEqual(CaptureChoice.target(.display(index: 0, name: "Built-in")).arguments, ["--display", "0"])
    }

    func testTheTitleIsTheLineThePickerShows() {
        let titled = RecordingTarget.window(ids: [3], app: "Editor", title: "notes", pid: 9)
        XCTAssertEqual(CaptureChoice.startTitle(of: titled), titled.title)
        let app = RecordingTarget.app(app: "501", name: "Notes")
        XCTAssertEqual(CaptureChoice.startTitle(of: app), app.title)
    }
}
