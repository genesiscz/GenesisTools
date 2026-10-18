import Foundation
import XCTest

@testable import GenesisKitBase
@testable import GenesisKit

@MainActor
final class NativeSettingsThemeTests: XCTestCase {
    func testEveryThemeIsStoredUnderItsRawValueAndReadBack() {
        let name = "dev.genesis.theme.test.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defer { defaults.removePersistentDomain(forName: name) }
        XCTAssertEqual(NativeSettingsTheme.allCases.map(\.rawValue),
                       ["glass", "solid", "gradient", "graphite", "midnight", "dusk"])
        // Backwards, so each write changes the stored value (Glass, the default, comes last).
        for theme in NativeSettingsTheme.allCases.reversed() {
            let writer = NativeSettingsAppearance(defaults: defaults, notificationNamespace: name, observeExternalChanges: false)
            writer.theme = theme
            XCTAssertEqual(defaults.string(forKey: "featureSettings.appearance.theme"), theme.rawValue)
            let reader = NativeSettingsAppearance(defaults: defaults, notificationNamespace: name, observeExternalChanges: false)
            XCTAssertEqual(reader.theme, theme)
        }
    }

    func testAStoredSmokedGlassIsReadAsGlassByTheSettingsAndByTheDecoder() throws {
        let name = "dev.genesis.theme.test.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defer { defaults.removePersistentDomain(forName: name) }
        defaults.set("smoked", forKey: "featureSettings.appearance.theme")
        let appearance = NativeSettingsAppearance(defaults: defaults, notificationNamespace: name, observeExternalChanges: false)
        XCTAssertEqual(appearance.theme, .glass)
        appearance.theme = .midnight
        defaults.set("smoked", forKey: "featureSettings.appearance.theme")
        appearance.reloadFromDefaults()
        XCTAssertEqual(appearance.theme, .glass)
        // The settings' default is Glass too, so these prove the migration itself: a mapped name, not a fallback.
        XCTAssertEqual(NativeSettingsTheme(stored: "smoked"), .glass)
        XCTAssertNil(NativeSettingsTheme(stored: "aurora"), "only a folded theme is migrated")
        XCTAssertNil(NativeSettingsTheme(rawValue: "smoked"))
        let decoded = try JSONDecoder().decode([NativeSettingsTheme].self, from: Data(#"["smoked","dusk"]"#.utf8))
        XCTAssertEqual(decoded, [.glass, .dusk])
        XCTAssertThrowsError(try JSONDecoder().decode([NativeSettingsTheme].self, from: Data(#"["aurora"]"#.utf8)))
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
            .glass: .graphite, .solid: .solid, .gradient: .solid,
            .graphite: .graphite, .midnight: .midnight, .dusk: .dusk,
        ]
        for theme in NativeSettingsTheme.allCases {
            XCTAssertEqual(theme.effective(reduceTransparency: false, systemReduceTransparency: false), theme)
            XCTAssertEqual(theme.effective(reduceTransparency: true, systemReduceTransparency: false), expected[theme])
            XCTAssertEqual(theme.effective(reduceTransparency: false, systemReduceTransparency: true), expected[theme])
            XCTAssertFalse(expected[theme]?.isSeeThrough ?? true, "Reduce transparency never shows the desktop")
        }
        XCTAssertEqual(NativeSettingsTheme.allCases.filter(\.isSeeThrough), [.glass])
    }

    func testEveryControlIsOpaqueUnderReduceTransparencyDuskIncluded() {
        for theme in NativeSettingsTheme.allCases {
            XCTAssertTrue(NativeGlassControl.isOpaque(theme: theme, reduceTransparency: true), "\(theme) under Reduce transparency")
        }
        XCTAssertFalse(NativeGlassControl.isOpaque(theme: .dusk, reduceTransparency: false), "Dusk's controls are glass otherwise")
        XCTAssertFalse(NativeGlassControl.isOpaque(theme: .glass, reduceTransparency: false))
        XCTAssertTrue(NativeGlassControl.isOpaque(theme: .solid, reduceTransparency: false))
    }

    func testThemeNamesAreSentenceCase() {
        XCTAssertEqual(NativeSettingsTheme.allCases.map(\.title),
                       ["Glass", "Solid", "Gradient", "Graphite", "Midnight", "Dusk"])
    }
}
