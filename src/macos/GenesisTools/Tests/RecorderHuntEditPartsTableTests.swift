import XCTest
@testable import GenesisToolsRecorder

/// Every part of an edit has a name and a tab for the undo menu, its own gesture key, and a line in the outside-edit
/// banner; the banner's times are the times the edit plays, and an item the edit cuts says so.
final class RecorderHuntEditPartsTableTests: XCTestCase {
    private func project() -> EditProject {
        EditProject.whole(video: "/tmp/none.mp4", durationUs: 10_000_000, width: 1920, height: 1080, cursor: nil, recording: nil)
    }

    /// One change per settings part that the undo menu did not name before.
    private func settingChanges(_ base: EditProject) -> [(String, String, InspectorTab, EditProject)] {
        var intro = base; intro.cards = EditProject.Cards(intro: .init(title: "Hello"))
        var end = base; end.cards = EditProject.Cards(end: .init(text: "Bye"))
        var style = base; style.captionsStyle = EditProject.CaptionsStyle()
        var progress = base; progress.progress = EditProject.ProgressBar()
        var smooth = base; smooth.cursorSmooth = EditProject.CursorSmooth()
        var badge = base; badge.autoSpeed = EditProject.AutoSpeed()
        var joins = base; joins.redactionJoins = EditProject.RedactionJoins(snapMs: 100)
        return [
            ("introCard", "Intro Card", .captions, intro),
            ("endCard", "End Card", .captions, end),
            ("captionsStyle", "Caption Animation", .captions, style),
            ("progress", "Progress Bar", .captions, progress),
            ("cursorSmooth", "Smooth Cursor", .cursor, smooth),
            ("autoSpeed", "Speed Badge", .clip, badge),
            ("redactionJoins", "Hidden Part Edges", .hide, joins),
        ]
    }

    func testEverySettingIsNamedWithItsTab() {
        let base = project()
        for (key, name, tab, changed) in settingChanges(base) {
            XCTAssertEqual(EditorModel.changedParts(base, changed), [key], key)
            let named = EditorModel.changeName(from: base, to: changed)
            XCTAssertEqual(named.name, name, key)
            XCTAssertEqual(named.tab, tab, key)
        }
    }

    func testTwoSettingsInARowAreTwoGestures() {
        let base = project()
        var intro = base
        intro.cards = EditProject.Cards(intro: .init(title: "Hello"))
        var both = intro
        both.progress = EditProject.ProgressBar()
        XCTAssertNotEqual(EditorModel.changedParts(base, intro), EditorModel.changedParts(intro, both),
                          "an intro title and then the progress bar are two undo steps")
        XCTAssertEqual(EditorModel.changeName(from: base, to: both).name, "Changes", "several parts at once are Changes")
    }

    func testTheBannerNamesEveryTopLevelChange() throws {
        let base = project()
        var changes = settingChanges(base).map { ($0.0, $0.3) }
        var camera = base; camera.camera = EditProject.Camera(file: "/tmp/cam.mp4")
        changes.append(("camera", camera))
        var bubble = camera; bubble.camera?.size = 0.3
        var lens = base; lens.lens = EditProject.Lens(items: [.init(id: "l1", startUs: 1_000_000, endUs: 2_000_000)])
        var tilt = base; tilt.tilt = EditProject.Tilt()
        var transitions = base; transitions.transitions = EditProject.Transitions()
        var privacy = base; privacy.privacy = EditProject.Privacy(applied: ["a"])
        var lanes = base; lanes.lanes = [EffectLane(id: "x")]
        changes += [("lens", lens), ("tilt", tilt), ("transitions", transitions), ("privacy", privacy), ("lanes", lanes)]
        for (key, changed) in changes {
            let said = try XCTUnwrap(EditDiff.describe(old: base, new: changed, by: "agent", at: Date()), key)
            XCTAssertNotEqual(said.lines.map(\.text), ["Changed the edit"], key)
        }
        let resized = try XCTUnwrap(EditDiff.describe(old: camera, new: bubble, by: "agent", at: Date()))
        XCTAssertEqual(resized.lines.map(\.text), ["Changed the camera bubble"])
    }

    func testAnAddedCameraHiddenPartIsNamedAndFlashes() throws {
        var before = project()
        before.camera = EditProject.Camera(file: "/tmp/cam.mp4")
        var after = before
        after.camera?.hidden = [.init(id: "k1", startUs: 1_000_000, endUs: 2_000_000)]
        let said = try XCTUnwrap(EditDiff.describe(old: before, new: after, by: "agent", at: Date()))
        XCTAssertEqual(said.lines.map(\.text), ["Added a camera-hidden part, 00:01.0 to 00:02.0"])
        XCTAssertEqual(said.itemIDs, ["k1"])
        XCTAssertEqual(said.startUs, 1_000_000)
    }

    func testAnItemInACutSaysSoAndAddsNoStart() throws {
        var before = project()
        before.clips = [EditProject.Clip(id: "a", fromUs: 0, toUs: 2_000_000), EditProject.Clip(id: "b", fromUs: 6_000_000, toUs: 10_000_000)]
        var after = before
        after.zooms = [EditProject.Zoom(id: "z", startUs: 3_000_000, endUs: 4_000_000)]
        let said = try XCTUnwrap(EditDiff.describe(old: before, new: after, by: "agent", at: Date()))
        XCTAssertEqual(said.lines.map(\.text), ["Added a 1.5× zoom, Cut from the edit"])
        XCTAssertNil(said.startUs, "a source time never stands in for an output time")

        var late = before
        late.zooms = [EditProject.Zoom(id: "z", startUs: 7_000_000, endUs: 8_000_000)]
        let played = try XCTUnwrap(EditDiff.describe(old: before, new: late, by: "agent", at: Date()))
        XCTAssertEqual(played.lines.map(\.text), ["Added a 1.5× zoom, 00:03.0 to 00:04.0"])
        XCTAssertEqual(played.startUs, 3_000_000)
    }

    func testTheClickSoundAloneIsNamedAsTheClickSound() throws {
        let base = project()
        var sound = base
        sound.clicks = EditProject.Clicks.settingSound(true, in: nil)
        let said = try XCTUnwrap(EditDiff.describe(old: base, new: sound, by: "agent", at: Date()))
        XCTAssertEqual(said.lines.map(\.text), ["Turned the click sound on"])
    }
}
