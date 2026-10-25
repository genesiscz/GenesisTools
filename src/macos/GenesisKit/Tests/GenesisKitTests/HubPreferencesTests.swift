import Combine
import Foundation
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
}
