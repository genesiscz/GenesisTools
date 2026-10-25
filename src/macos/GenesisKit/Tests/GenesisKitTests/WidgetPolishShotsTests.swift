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
            "notifications": ["unread": 0, "needsAnswer": 0, "complete": true, "truncated": false, "sessions": []]])
        model.receive([String(decoding: data, as: UTF8.self)])
        return model
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
    }
}
