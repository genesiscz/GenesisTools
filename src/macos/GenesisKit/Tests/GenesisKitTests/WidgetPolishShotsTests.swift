import AppKit
import SwiftUI
import XCTest

@testable import GenesisKit

/// The widget's Panel background setting and the inbox header's sort label (Martin, 2026-10-25), checked as values and
/// rendered for the report with `WIDGET_POLISH_SHOTS=<folder>`.
@MainActor
final class WidgetPolishShotsTests: XCTestCase {
    private let key = "local:claude:fixture-polish:"

    private func model(panelBackground: String?) throws -> WidgetModel {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "widget.polish." + UUID().uuidString))
        let model = WidgetModel(binaryPath: "/fixture/tools", stateRoot: FileManager.default.temporaryDirectory.path,
            defaults: defaults, appearance: NativeSettingsAppearance(defaults: defaults,
                notificationNamespace: "polish." + UUID().uuidString, observeExternalChanges: false))
        var preferences: [String: Any] = ["excludedKeys": [], "projects": [], "sessions": [], "showChanges": false,
            "placement": "both", "side": "right", "quietSeconds": 15, "voiceProvider": "openai", "voiceLanguage": "en",
            "previewSort": "recent"]
        if let panelBackground { preferences["panelBackground"] = panelBackground }
        let sessions: [[String: Any]] = ["Kalendora hotfix research", "gt-native-ux", "gt-fixes"].enumerated().map { index, title in
            ["key": key + "\(index)", "target": ["hostId": "local", "provider": "claude", "sessionId": "fixture-\(index)",
                "sourceHome": "", "cwd": "/fixture"], "title": title, "project": "Fixture",
             "activityAt": Date().timeIntervalSince1970 * 1000 - Double(index) * 60_000,
             "status": index == 0 ? "working" : "idle", "pinned": false, "visible": true, "hiddenByFilter": false]
        }
        let data = try JSONSerialization.data(withJSONObject: ["version": 1, "state": ["version": 1, "revision": 0,
            "selectedKey": key + "0", "preferences": preferences, "assets": [:], "drafts": [:], "outgoing": []],
            "sessions": sessions, "cards": [], "manifests": [:], "errors": [], "selectedKey": key + "0",
            "notifications": ["unread": 0, "needsAnswer": 1, "complete": true, "truncated": false,
                "sessions": [["key": key + "0", "unread": 0, "needsAnswer": 1, "pendingItem": Self.pending(key + "0"),
                              "items": [Self.pending(key + "0")]]]]])
        model.receive([String(decoding: data, as: UTF8.self)])
        return model
    }

    static func pending(_ key: String) -> [String: Any] {
        ["id": "decision:d10", "sourceId": "d10", "kind": "decision", "key": key, "at": Date().timeIntervalSince1970 * 1000,
         "needsAnswer": true, "number": 10, "title": "P8 scope: where \"no automatic failover, show the error\" applies",
         "options": ["a) only the fleet publisher", "b) every remote call", "c) the installer as well"], "recommended": "b",
         "revision": 1]
    }

    func testTheRecommendedOptionIsFoundByLetterOrText() {
        XCTAssertTrue(WidgetPeekOptions.isRecommended("b) every remote call", "b"))
        XCTAssertTrue(WidgetPeekOptions.isRecommended("keep", "keep"))
        XCTAssertFalse(WidgetPeekOptions.isRecommended("a) only the fleet publisher", "b"))
        XCTAssertFalse(WidgetPeekOptions.isRecommended("bigger", "b"))
    }

    func testThePanelIsDarkUnlessGlassOrTheAppThemeIsPicked() throws {
        XCTAssertEqual(try model(panelBackground: nil).panelTheme, .graphite, "an older snapshot reads as dark")
        XCTAssertEqual(try model(panelBackground: "dark").panelTheme, .graphite)
        XCTAssertEqual(try model(panelBackground: "glass").panelTheme, .glass)
        let themed = try model(panelBackground: "theme")
        XCTAssertEqual(themed.panelTheme, themed.appearance.theme)
    }

    func testTheSortButtonNamesTheOrderInOneWord() {
        XCTAssertEqual(WidgetPreviewChoices.shortTitle(sort: "attention"), "Waiting")
        XCTAssertEqual(WidgetPreviewChoices.shortTitle(sort: "recent"), "Newest")
        XCTAssertEqual(WidgetPreviewChoices.shortTitle(sort: "project"), "Project")
    }

    func testRendersTheSettingAndTheHeader() throws {
        guard let folder = ProcessInfo.processInfo.environment["WIDGET_POLISH_SHOTS"] else { return }
        let model = try model(panelBackground: "dark")
        defer { model.stop() }
        let general = try XCTUnwrap(WidgetFeatureSettings.sections(model: model, modules: WidgetModuleChoice.builtins,
            openSession: { _ in }).flatMap(\.pages).first { $0.id == "widgets.general" })
        let page = ScrollView { general.content().padding(24) }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .background(NativeThemePalette.graphiteBase)
            .environment(\.nativeSettingsTheme, .graphite)
            .environment(\.colorScheme, .dark)
        let pageShot = try KitShots.render(page, size: CGSize(width: 760, height: 1500), name: "widget-general", settle: 0.8)
        try XCTUnwrap(pageShot.representation(using: .png, properties: [:]))
            .write(to: URL(fileURLWithPath: folder).appendingPathComponent("widget-general-settings.png"))
        let preview = AgentWidgetPreview(model: model, surface: WidgetSurfaceID(edge: .right)).padding(10)
            .frame(width: 420, alignment: .top)
            .background(NativeThemePalette.graphiteBase)
            .environment(\.nativeSettingsTheme, model.panelTheme)
            .environment(\.colorScheme, .dark)
        let previewShot = try KitShots.render(preview, size: CGSize(width: 420, height: 320), name: "widget-preview", settle: 0.6)
        try XCTUnwrap(previewShot.representation(using: .png, properties: [:]))
            .write(to: URL(fileURLWithPath: folder).appendingPathComponent("widget-inbox-sort-label.png"))
        // The alert card at the size of Martin's screenshot (2026-10-25 18:47): the pane is as tall as the rail.
        let item = try XCTUnwrap(model.inboxFor(key + "0")?.pendingItem)
        let peek = WidgetPeekView(model: model, item: item).padding(WidgetPeekView.inset)
            .frame(width: 310, height: 290, alignment: .top)
            .background(NativeThemePalette.graphiteBase)
            .environment(\.nativeSettingsTheme, model.panelTheme)
            .environment(\.colorScheme, .dark)
        let peekShot = try KitShots.render(peek, size: CGSize(width: 310, height: 290), name: "widget-peek", settle: 0.6)
        try XCTUnwrap(peekShot.representation(using: .png, properties: [:]))
            .write(to: URL(fileURLWithPath: folder).appendingPathComponent("widget-alert-card.png"))
    }
}
