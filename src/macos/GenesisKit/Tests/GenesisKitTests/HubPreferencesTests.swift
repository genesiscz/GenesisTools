import Combine
import Foundation
import Observation
import XCTest

@testable import GenesisKitBase
@testable import GenesisKit

@MainActor
final class HubPreferencesTests: XCTestCase {
    private func suite() -> (UserDefaults, String) {
        let name = "dev.genesis.hub.preferences.test.\(UUID().uuidString)"
        return (UserDefaults(suiteName: name)!, name)
    }

    private func preferences(_ defaults: UserDefaults, _ namespace: String, broadcasts: Bool = false,
                             observe: Bool = false) -> HubPreferences {
        HubPreferences(defaults: defaults, notificationNamespace: namespace, broadcasts: broadcasts,
                       observeExternalChanges: observe)
    }

    func testLayoutDefaultsAndSavedChoicesSurviveReopeningTheDomain() {
        let (defaults, name) = suite()
        defer { defaults.removePersistentDomain(forName: name) }
        for area in HubLayout.Area.allCases {
            XCTAssertEqual(HubLayout.choice(area, defaults: defaults), .classic)
            defaults.set(HubLayout.Choice.compact.rawValue, forKey: area.key)
        }
        defaults.synchronize()
        let reopened = UserDefaults(suiteName: name)!
        for area in HubLayout.Area.allCases {
            XCTAssertEqual(HubLayout.choice(area, defaults: reopened), .compact)
            reopened.set("unknown", forKey: area.key)
            XCTAssertEqual(HubLayout.choice(area, defaults: reopened), .classic)
            reopened.set("classic", forKey: area.key)
            XCTAssertEqual(HubLayout.choice(area, defaults: reopened), .classic)
        }
    }

    func testLayoutOverridesAreValidatedAndDoNotWritePreferences() {
        let (defaults, name) = suite()
        defer { defaults.removePersistentDomain(forName: name) }
        defaults.set("b", forKey: HubLayout.Area.prDetail.key)
        let parsed = HubLayout.parse(["app", "--sketch", "prDetail=a", "--sketch", "prDetail=classic",
                                      "--sketch", "lists=unknown", "--sketch", "unknown=a", "--sketch"])
        XCTAssertEqual(parsed, ["prDetail": "classic"])
        XCTAssertEqual(defaults.string(forKey: HubLayout.Area.prDetail.key), "b")
    }

    func testLayoutChangeInvalidatesAnOpenReaderAcrossTheNotificationBoundary() async {
        let (defaults, name) = suite()
        defer { defaults.removePersistentDomain(forName: name) }
        let writer = HubLayoutState(defaults: defaults, namespace: name, observeChanges: false)
        let reader = HubLayoutState(defaults: UserDefaults(suiteName: name)!, namespace: name, broadcasts: false)
        for choice in [HubLayout.Choice.focused, .compact, .classic] {
            let changed = expectation(description: "open view observes \(choice.rawValue)")
            // lint-rules-ignore: one shot on purpose, each loop iteration arms a new expectation before its change.
            withObservationTracking {
                XCTAssertNotEqual(reader.choice(.prDetail), choice)
            } onChange: {
                changed.fulfill()
            }
            writer.set(choice, for: .prDetail)
            await fulfillment(of: [changed], timeout: 3)
            XCTAssertEqual(reader.choice(.prDetail), choice)
            XCTAssertEqual(reader.choice(.transcript), .classic)
            XCTAssertEqual(defaults.string(forKey: HubLayout.Area.prDetail.key), choice.rawValue)
        }
    }

    func testScriptedLayoutChangesStayIsolatedFromTheOpenReader() async throws {
        let (defaults, name) = suite()
        defer { defaults.removePersistentDomain(forName: name) }
        let scripted = HubLayoutState(defaults: defaults, namespace: name, broadcasts: false, observeChanges: false)
        let reader = HubLayoutState(defaults: defaults, namespace: name, broadcasts: false)
        scripted.set(.compact, for: .lists)
        XCTAssertEqual(scripted.choice(.lists), .compact)
        let changed = expectation(description: "scripted changes do not reach an open reader")
        changed.isInverted = true
        // lint-rules-ignore: one-shot inverted observation; any notification is a failure.
        withObservationTracking {
            _ = reader.choice(.lists)
        } onChange: {
            changed.fulfill()
        }
        await fulfillment(of: [changed], timeout: 0.25)
        XCTAssertEqual(reader.choice(.lists), .classic)
        reader.reload()
        XCTAssertEqual(reader.choice(.lists), .compact)
    }

    func testAFreshDomainReadsTheHubLookWithoutGlassEnergyOrAnIdleRule() {
        let (defaults, name) = suite()
        defer { defaults.removePersistentDomain(forName: name) }
        let hub = preferences(defaults, name)
        XCTAssertEqual(hub.style, .hub)
        XCTAssertFalse(hub.glass)
        XCTAssertFalse(hub.processEnergy)
        XCTAssertEqual(hub.cleanupIdleDays, 0)
    }

    func testEveryValueIsStoredUnderTheKeyTheHubAlreadyReads() {
        let (defaults, name) = suite()
        defer { defaults.removePersistentDomain(forName: name) }
        let hub = preferences(defaults, name)
        hub.style = .native
        hub.glass = true
        hub.processEnergy = true
        hub.cleanupIdleDays = 14
        // The keys the hub used before this model existed, so a saved glass switch survives the upgrade.
        XCTAssertEqual(defaults.string(forKey: "hub.style"), "native")
        XCTAssertTrue(defaults.bool(forKey: "hub.glass"))
        XCTAssertTrue(defaults.bool(forKey: "hub.procs.energy"))
        XCTAssertEqual(defaults.integer(forKey: "hub.worktreeCleanup.olderThanDays"), 14)
        let reopened = preferences(defaults, name)
        XCTAssertEqual(reopened.style, .native)
        XCTAssertTrue(reopened.glass)
        XCTAssertTrue(reopened.processEnergy)
        XCTAssertEqual(reopened.cleanupIdleDays, 14)
    }

    func testTheAgentsListLandsMovedRowsInPlaceUntilTheSlideIsChosen() {
        let (defaults, name) = suite()
        defer { defaults.removePersistentDomain(forName: name) }
        XCTAssertEqual(preferences(defaults, name).agentsMotion, .inPlace)
        defaults.set("bounce", forKey: HubPreferences.Key.agentsMotion)
        XCTAssertEqual(preferences(defaults, name).agentsMotion, .inPlace)
        let hub = preferences(defaults, name)
        hub.agentsMotion = .slide
        XCTAssertEqual(defaults.string(forKey: "hub.agents.motion"), "slide")
        XCTAssertEqual(preferences(defaults, name).agentsMotion, .slide)
    }

    func testUnknownOrOutOfRangeStoredValuesReadAsTheDefaultsOrTheNearestLimit() {
        let (defaults, name) = suite()
        defer { defaults.removePersistentDomain(forName: name) }
        defaults.set("purple", forKey: HubPreferences.Key.style)
        defaults.set(500, forKey: HubPreferences.Key.cleanupIdleDays)
        XCTAssertEqual(preferences(defaults, name).style, .hub)
        XCTAssertEqual(preferences(defaults, name).cleanupIdleDays, HubPreferences.cleanupIdleDaysRange.upperBound)
        defaults.set(-3, forKey: HubPreferences.Key.cleanupIdleDays)
        XCTAssertEqual(preferences(defaults, name).cleanupIdleDays, 0)
    }

    func testHistoryKeepsTwoHundredPlacesAndAgentsNavigateUntilChanged() {
        let (defaults, name) = suite()
        defer { defaults.removePersistentDomain(forName: name) }
        let hub = preferences(defaults, name)
        XCTAssertEqual(hub.navigationLimit, 200)
        XCTAssertEqual(hub.agentNavigation, .navigate)
        hub.navigationLimit = 50
        hub.agentNavigation = .listOnly
        XCTAssertEqual(defaults.integer(forKey: "hub.nav.limit"), 50)
        XCTAssertEqual(defaults.string(forKey: "hub.nav.agentNavigation"), "listOnly")
        let reopened = preferences(defaults, name)
        XCTAssertEqual(reopened.navigationLimit, 50)
        XCTAssertEqual(reopened.agentNavigation, .listOnly)
        defaults.set(5, forKey: HubPreferences.Key.navigationLimit)
        defaults.set("steal", forKey: HubPreferences.Key.agentNavigation)
        XCTAssertEqual(preferences(defaults, name).navigationLimit, HubPreferences.navigationLimitRange.lowerBound)
        XCTAssertEqual(preferences(defaults, name).agentNavigation, .navigate)
    }

    func testAChangeInOneProcessReachesAnotherThroughTheDistributedNotification() async {
        let (defaults, name) = suite()
        defer { defaults.removePersistentDomain(forName: name) }
        let settingsWindow = preferences(defaults, name, broadcasts: true)
        let hub = preferences(defaults, name, observe: true)
        let arrived = expectation(description: "the hub reloads the style and glass")
        arrived.assertForOverFulfill = false
        let subscription = hub.objectWillChange.sink {
            DispatchQueue.main.async {
                if hub.style == .native && hub.glass { arrived.fulfill() }
            }
        }
        settingsWindow.glass = true
        settingsWindow.style = .native
        await fulfillment(of: [arrived], timeout: 3)
        withExtendedLifetime(subscription) {}
        XCTAssertEqual(hub.style, .native)
        XCTAssertTrue(hub.glass)
    }

    func testAScriptedRunsWriteStaysInItsOwnProcess() async throws {
        let (defaults, name) = suite()
        defer { defaults.removePersistentDomain(forName: name) }
        let scripted = preferences(defaults, name, broadcasts: false)
        let live = preferences(defaults, name, observe: true)
        scripted.style = .native
        try await Task.sleep(for: .milliseconds(400))
        XCTAssertEqual(live.style, .hub, "a scripted run must not move a running hub")
        // Positive control: the same observer does reload when it is told.
        live.reloadFromDefaults()
        XCTAssertEqual(live.style, .native)
    }

    func testAnExternalReloadDoesNotWriteOrBroadcastAgain() {
        let (defaults, name) = suite()
        defer { defaults.removePersistentDomain(forName: name) }
        let hub = preferences(defaults, name)
        defaults.set("native", forKey: HubPreferences.Key.style)
        defaults.set(7, forKey: HubPreferences.Key.cleanupIdleDays)
        hub.reloadFromDefaults()
        XCTAssertEqual(hub.style, .native)
        XCTAssertEqual(hub.cleanupIdleDays, 7)
        defaults.removeObject(forKey: HubPreferences.Key.style)
        // Reading back must not have stored the value a second time (a reload never persists).
        XCTAssertNil(defaults.string(forKey: HubPreferences.Key.style))
    }

    func testTheHubSectionSitsAfterWidgetsWithPageIDsNoOtherSectionUses() {
        let (defaults, name) = suite()
        defer { defaults.removePersistentDomain(forName: name) }
        let section = HubSettingsPages.section(preferences: preferences(defaults, name))
        XCTAssertEqual(section.title, "Hub")
        XCTAssertEqual(section.pages.map(\.id), [HubSettingsPages.appearancePageID, HubSettingsPages.panesPageID, HubSettingsPages.historyPageID])
        let appearance = NativeSettingsAppearance(defaults: defaults, notificationNamespace: name, observeExternalChanges: false)
        let clicky = ClickyModel(defaults: defaults, previewOnly: true, appearance: appearance, observeSystemEvents: false)
        let widget = WidgetModel(binaryPath: "/fixture/no-process", defaults: defaults, appearance: appearance)
        let catalog = ClickySettingsPages.sections(model: clicky)
            + WidgetFeatureSettings.sections(model: widget, modules: WidgetModuleChoice.builtins, openSession: { _ in })
            + [section]
        XCTAssertNil(NativeSettingsStore.validate(catalog))
        let store = NativeSettingsStore(sections: catalog, defaults: defaults, appearance: appearance)
        let order = store.sections.map(\.id)
        XCTAssertEqual(order.firstIndex(of: "hub"), order.firstIndex(of: "widgets").map { $0 + 1 })
    }

    /// A settings search result names its row by section and title (`row:<section>/<title>`), not by the control's
    /// identifier: option B's Panes page opens the tab of every row a search can jump to, Sessions included or not.
    func testASearchJumpOpensTheTabOfItsRowOnOptionBsPanesPage() {
        let rows: [(String, String, UsageSketchPaneTabB)] = [
            ("PRs", "PR rows show CI", .prs), ("Changes", "Diff layout", .changes),
            ("Sessions", "Hide what every session in a group shares", .sessions),
            ("Agents", "Measure energy impact of agent processes", .agents),
            ("Worktrees", "Removable after idle for", .worktrees),
            ("Every mode", "Show a Glass button beside Settings", .window),
        ]
        for (section, title, tab) in rows {
            let key = NativeSettingsSearchEntry(kind: .row, title: title, card: section).key
            let anchor = NativeSettingsSearch.anchor(page: "hub.panes", key: key)
            XCTAssertEqual(UsageSettingsSketchPanesB.tab(for: anchor), tab, anchor)
        }
        XCTAssertEqual(UsageSettingsSketchPanesB.tab(for: "lists"), .prs)
        XCTAssertNil(UsageSettingsSketchPanesB.tab(for: "search/hub.panes/row:Elsewhere/Diff layout"))
        XCTAssertNil(UsageSettingsSketchPanesB.tab(for: "hub.prs.rowCI"))
    }

    func testThePanesPageOpensOnSessionsUnlessTheLastTabIsChosen() {
        XCTAssertEqual(UsageSketchPanesOpening.stored("").tab(last: "prs"), .sessions, "Sessions is the default")
        XCTAssertEqual(UsageSketchPanesOpening.sessions.tab(last: "prs"), .sessions)
        XCTAssertEqual(UsageSketchPanesOpening.last.tab(last: "prs"), .prs)
        XCTAssertEqual(UsageSketchPanesOpening.last.tab(last: "gone"), .sessions, "a tab that no longer exists opens Sessions")
    }
}
