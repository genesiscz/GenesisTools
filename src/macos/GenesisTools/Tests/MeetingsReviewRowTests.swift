import Foundation
import XCTest
@testable import GenesisToolsMeetings

/// The review rows of F6 and the layout around them: the trailing pane beside the rows, the window settings the rows
/// read, and the rows from `meeting.rows` with their decisions through the journal.
@MainActor
final class MeetingsReviewRowTests: XCTestCase {
    private func defaults() throws -> (UserDefaults, String) {
        let suite = "meetings.rows.tests.\(UUID().uuidString)"
        return (try XCTUnwrap(UserDefaults(suiteName: suite)), suite)
    }

    // MARK: The trailing pane (decision 2)

    func testTheTranscriptPaneShowsBesideTheRowsOnlyWhenTheColumnIsWideEnough() {
        let wide = MeetingDetailView.transcriptPaneMinWidth
        XCTAssertEqual(MeetingDetailView.trailingPane(tab: .items, width: wide, setting: .auto, sidePanelOpen: false), .transcript)
        XCTAssertNil(MeetingDetailView.trailingPane(tab: .items, width: wide - 1, setting: .auto, sidePanelOpen: false),
                     "a narrow column keeps the Transcript tab as today")
        XCTAssertNil(MeetingDetailView.trailingPane(tab: .transcript, width: 2000, setting: .always, sidePanelOpen: false),
                     "only the rows get the pane")
        XCTAssertEqual(MeetingDetailView.trailingPane(tab: .items, width: 400, setting: .always, sidePanelOpen: false), .transcript)
        XCTAssertNil(MeetingDetailView.trailingPane(tab: .items, width: 2000, setting: .never, sidePanelOpen: false))
        XCTAssertEqual(MeetingDetailView.trailingPane(tab: .screen, width: 400, setting: .never, sidePanelOpen: true), .settings,
                       "the open side panel replaces the pane on every tab")
    }

    // MARK: Window settings

    func testTheTypedAnswerKeyMovesToTheRowsAndKeepsItsValue() throws {
        let (defaults, suite) = try defaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set("noChoices", forKey: MeetingsPreferences.legacyTypedAnswerKey)
        MeetingsPreferences.migrate(defaults)
        XCTAssertNil(defaults.object(forKey: MeetingsPreferences.legacyTypedAnswerKey))
        XCTAssertEqual(MeetingsPreferences.Rows.typedAnswer.value(defaults), .noChoices)
        XCTAssertEqual(MeetingsPreferences.typedAnswer(defaults), .noChoices)
    }

    func testEveryWindowSettingHasItsDefaultAndOffersIt() throws {
        let (defaults, suite) = try defaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        typealias Rows = MeetingsPreferences.Rows
        typealias Playback = MeetingsPreferences.Playback
        typealias Panes = MeetingsPreferences.Panes
        XCTAssertEqual(Rows.returnKey.value(defaults), .edit)
        XCTAssertEqual(Rows.choiceKeys.value(defaults), .on)
        XCTAssertEqual(Rows.decided.value(defaults), .inPlace)
        XCTAssertEqual(Rows.order.value(defaults), .priority)
        XCTAssertEqual(Rows.lowPriority.value(defaults), .hide)
        XCTAssertEqual(Rows.askReach.value(defaults), .always)
        XCTAssertEqual(Rows.autoplayNext.value(defaults), .afterAnswer)
        XCTAssertEqual(Rows.autoplayDelaySec.value(defaults), 1)
        XCTAssertEqual(MeetingsPreferences.Notices.maxVisible.value(defaults), 3)
        XCTAssertEqual(Playback.view.value(defaults), .moment)
        XCTAssertEqual(Playback.speed.value(defaults), 1)
        XCTAssertEqual(Playback.repeatClip.value(defaults), .off)
        XCTAssertEqual(Playback.afterClip.value(defaults), .offerMore)
        XCTAssertEqual(Playback.moreSec.value(defaults), 30)
        XCTAssertEqual(Playback.contextSec.value(defaults), 120)
        XCTAssertEqual(Playback.rewindSec.value(defaults), 1)
        XCTAssertEqual(Playback.clickInQuestion.value(defaults), .push)
        XCTAssertEqual(Playback.onTopEnd.value(defaults), .return)
        XCTAssertEqual(Playback.stackDepth.value(defaults), 3)
        XCTAssertTrue(Panes.timelineShown.value(defaults))
        XCTAssertEqual(Panes.hoverDelayMs.value(defaults), 300)
        XCTAssertTrue(Panes.followPlayback.value(defaults))
        XCTAssertTrue(Panes.screenBesidePlayback.value(defaults))
        XCTAssertEqual(Panes.transcriptPane.value(defaults), .auto)

        XCTAssertTrue(Rows.autoplayDelaySec.choices.contains(Rows.autoplayDelaySec.defaultValue))
        XCTAssertTrue(Playback.speed.choices.contains(Playback.speed.defaultValue))
        XCTAssertTrue(Playback.stackDepth.choices.contains(Playback.stackDepth.defaultValue))
        XCTAssertTrue(Panes.hoverDelayMs.choices.contains(Panes.hoverDelayMs.defaultValue))

        defaults.set(false, forKey: Panes.followPlayback.key)
        defaults.set("confirm", forKey: Rows.returnKey.key)
        defaults.set(1.5, forKey: Playback.speed.key)
        XCTAssertFalse(Panes.followPlayback.value(defaults))
        XCTAssertEqual(Rows.returnKey.value(defaults), .confirm)
        XCTAssertEqual(Playback.speed.value(defaults), 1.5)
    }
}
