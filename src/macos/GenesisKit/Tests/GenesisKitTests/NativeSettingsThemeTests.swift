import Foundation
import XCTest

@testable import GenesisKit

@MainActor
final class NativeSettingsThemeTests: XCTestCase {
    func testEveryThemeIsStoredUnderItsRawValueAndReadBack() {
        let name = "dev.genesis.theme.test.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defer { defaults.removePersistentDomain(forName: name) }
        XCTAssertEqual(NativeSettingsTheme.allCases.map(\.rawValue),
                       ["glass", "solid", "gradient", "graphite", "midnight", "smoked", "dusk"])
        // Backwards, so each write changes the stored value (Glass, the default, comes last).
        for theme in NativeSettingsTheme.allCases.reversed() {
            let writer = NativeSettingsAppearance(defaults: defaults, notificationNamespace: name, observeExternalChanges: false)
            writer.theme = theme
            XCTAssertEqual(defaults.string(forKey: "featureSettings.appearance.theme"), theme.rawValue)
            let reader = NativeSettingsAppearance(defaults: defaults, notificationNamespace: name, observeExternalChanges: false)
            XCTAssertEqual(reader.theme, theme)
        }
    }

    func testAnUnknownStoredThemeStillReadsAsGlass() {
        let name = "dev.genesis.theme.test.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defer { defaults.removePersistentDomain(forName: name) }
        defaults.set("aurora", forKey: "featureSettings.appearance.theme")
        XCTAssertEqual(NativeSettingsAppearance(defaults: defaults, notificationNamespace: name, observeExternalChanges: false).theme, .glass)
    }

    func testReduceTransparencyKeepsTheLightThemesSolidAndTheDarkThemesDark() {
        let expected: [NativeSettingsTheme: NativeSettingsTheme] = [
            .glass: .solid, .solid: .solid, .gradient: .solid,
            .graphite: .graphite, .midnight: .midnight, .smoked: .graphite, .dusk: .dusk,
        ]
        for theme in NativeSettingsTheme.allCases {
            XCTAssertEqual(theme.effective(reduceTransparency: false, systemReduceTransparency: false), theme)
            XCTAssertEqual(theme.effective(reduceTransparency: true, systemReduceTransparency: false), expected[theme])
            XCTAssertEqual(theme.effective(reduceTransparency: false, systemReduceTransparency: true), expected[theme])
            XCTAssertFalse(expected[theme]?.isSeeThrough ?? true, "Reduce transparency never shows the desktop")
        }
        XCTAssertEqual(NativeSettingsTheme.allCases.filter(\.isSeeThrough), [.glass, .smoked])
    }

    func testThemeNamesAreSentenceCase() {
        XCTAssertEqual(NativeSettingsTheme.allCases.map(\.title),
                       ["Glass", "Solid", "Gradient", "Graphite", "Midnight", "Smoked glass", "Dusk"])
    }
}
