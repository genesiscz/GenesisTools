import GenesisKit
import XCTest
@testable import GenesisTools

/// How the window style, the glass switch and General → Theme combine into what the hub draws.
final class HubStyleTests: XCTestCase {
    func testTheHubStyleKeepsTodaysLookAndGlassAloneDecidesTheBlur() {
        for theme in NativeSettingsTheme.allCases {
            XCTAssertFalse(HubLook.resolve(style: .hub, glass: false, general: theme, reduceTransparency: false).seeThrough)
            XCTAssertTrue(HubLook.resolve(style: .hub, glass: true, general: theme, reduceTransparency: false).seeThrough)
        }
        // Reduce transparency never changed the Hub style's glass, and still does not.
        XCTAssertTrue(HubLook.resolve(style: .hub, glass: true, general: .solid, reduceTransparency: true).seeThrough)
    }

    func testTheNativeStyleFollowsGeneralOnlyWhateverTheGlassSwitchSays() {
        for glass in [false, true] {
            let gradient = HubLook.resolve(style: .native, glass: glass, general: .gradient, reduceTransparency: false)
            XCTAssertEqual(gradient.theme, .gradient, "a saved hub.glass = 1 must not hide the gradient")
            XCTAssertFalse(gradient.seeThrough)
            let solid = HubLook.resolve(style: .native, glass: glass, general: .solid, reduceTransparency: false)
            XCTAssertEqual(solid.theme, .solid)
            XCTAssertFalse(solid.seeThrough)
            let generalGlass = HubLook.resolve(style: .native, glass: glass, general: .glass, reduceTransparency: false)
            XCTAssertEqual(generalGlass.theme, .glass)
            XCTAssertTrue(generalGlass.seeThrough)
            for theme in NativeSettingsTheme.allCases {
                let look = HubLook.resolve(style: .native, glass: glass, general: theme, reduceTransparency: false)
                XCTAssertEqual(look.theme, theme)
                XCTAssertEqual(look.seeThrough, theme == .glass || theme == .smoked, theme.rawValue)
            }
        }
    }

    func testReduceTransparencyMakesTheNativeGlassThemeOpaque() {
        let look = HubLook.resolve(style: .native, glass: false, general: .glass, reduceTransparency: true)
        XCTAssertEqual(look.theme, .glass, "the chosen theme stays; the surfaces read it as solid")
        XCTAssertFalse(look.seeThrough)
        XCTAssertEqual(look.theme.effective(reduceTransparency: true, systemReduceTransparency: false), .solid)
        let smoked = HubLook.resolve(style: .native, glass: false, general: .smoked, reduceTransparency: true)
        XCTAssertFalse(smoked.seeThrough, "Smoked glass under Reduce transparency is Graphite: no desktop behind it")
    }

    func testThePaletteOffersGlassOnlyInTheHubStyleAndSaysWhyInTheNativeStyle() {
        let hub = HubPaletteEngine.suggestions(for: "glass ", context: HubPaletteContext(glassAvailable: true))
        XCTAssertEqual(hub.map(\.id), ["glass"])
        XCTAssertNotNil(hub.first?.action)
        let native = HubPaletteEngine.suggestions(for: "glass ", context: HubPaletteContext(glassAvailable: false))
        XCTAssertEqual(native.map(\.id), ["glass-native"])
        XCTAssertNil(native.first?.action, "the note runs nothing")
        let listed = HubPaletteEngine.suggestions(for: "", context: HubPaletteContext(glassAvailable: false)).map(\.id)
        XCTAssertFalse(listed.contains("kw-glass"))
        XCTAssertTrue(HubPaletteEngine.suggestions(for: "", context: HubPaletteContext()).map(\.id).contains("kw-glass"))
    }

    func testEachLookMapsToOneStyleAndThemeAndEveryThemeHasALook() {
        XCTAssertEqual(HubLookChoice.allCases.map(\.title), [
            "Hub", "Native · Glass", "Native · Solid", "Native · Gradient", "Native · Graphite", "Native · Midnight",
            "Native · Smoked glass", "Native · Dusk",
        ])
        XCTAssertEqual(HubLookChoice.allCases.compactMap(\.theme), NativeSettingsTheme.allCases, "a new theme needs no menu edit")
        XCTAssertEqual(HubLookChoice.hub.style, .hub)
        XCTAssertNil(HubLookChoice.hub.theme, "the Hub look leaves General → Theme alone")
        XCTAssertEqual(HubLookChoice.native(.glass).style, .native)
        XCTAssertEqual(HubLookChoice.native(.dusk).theme, .dusk)
        XCTAssertEqual(Set(HubLookChoice.allCases.map(\.id)).count, HubLookChoice.allCases.count)
        for choice in HubLookChoice.allCases where choice != .hub {
            XCTAssertEqual(HubLookChoice.current(style: choice.style, theme: choice.theme ?? .glass), choice)
        }
        for theme in NativeSettingsTheme.allCases {
            XCTAssertEqual(HubLookChoice.current(style: .hub, theme: theme), .hub)
        }
    }

    @MainActor
    func testPickingALookWritesTheStyleAndGeneralThemeThroughTheSharedModels() {
        let name = "dev.genesis.hub.look.test.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defer { defaults.removePersistentDomain(forName: name) }
        let preferences = HubPreferences(defaults: defaults, notificationNamespace: name, broadcasts: false, observeExternalChanges: false)
        let appearance = NativeSettingsAppearance(defaults: defaults, notificationNamespace: name, observeExternalChanges: false)
        appearance.theme = .solid
        HubLookChoice.native(.gradient).apply(preferences: preferences, appearance: appearance)
        XCTAssertEqual(preferences.style, .native)
        XCTAssertEqual(appearance.theme, .gradient)
        XCTAssertEqual(defaults.string(forKey: "hub.style"), "native")
        XCTAssertEqual(defaults.string(forKey: "featureSettings.appearance.theme"), "gradient", "the settings window reads this")
        HubLookChoice.hub.apply(preferences: preferences, appearance: appearance)
        XCTAssertEqual(preferences.style, .hub)
        XCTAssertEqual(appearance.theme, .gradient, "the Hub look leaves General → Theme alone")
    }

    func testThePaletteListsEveryLookAndChecksTheCurrentOne() {
        let rows = HubPaletteEngine.suggestions(for: "look ", context: HubPaletteContext(look: .native(.midnight)))
        XCTAssertEqual(rows.map(\.id), HubLookChoice.allCases.map { "look-\($0.id)" })
        XCTAssertEqual(rows.map(\.action), HubLookChoice.allCases.map { .setLook($0) })
        XCTAssertEqual(rows.filter { $0.symbol == "checkmark" }.map(\.id), ["look-native-midnight"])
        XCTAssertNil(rows[0].subtitle)
        XCTAssertTrue(rows.dropFirst().allSatisfy { $0.subtitle == HubLookChoice.generalNote })
        func ids(_ input: String) -> [String] { HubPaletteEngine.suggestions(for: input, context: HubPaletteContext()).map(\.id) }
        XCTAssertEqual(ids("look grad"), ["look-native-gradient"])
        XCTAssertEqual(ids("look graphite"), ["look-native-graphite"])
        XCTAssertEqual(ids("look midnight"), ["look-native-midnight"])
        XCTAssertEqual(ids("look smoked"), ["look-native-smoked"])
        XCTAssertEqual(ids("look dusk"), ["look-native-dusk"])
        XCTAssertEqual(ids("look native-dusk"), ["look-native-dusk"], "the row's own completion finds it again")
        XCTAssertEqual(ids("theme hub"), ["look-hub"])
    }

    @MainActor
    func testTheGlassSwitchDoesNothingInTheNativeStyle() {
        HubDefaults.isolate()
        let preferences = HubDefaults.preferences
        let saved = (preferences.style, preferences.glass)
        defer { (preferences.style, preferences.glass) = saved }
        preferences.style = .native
        preferences.glass = true
        HubGlassSwitch.toggle()
        XCTAssertTrue(preferences.glass)
        preferences.style = .hub
        HubGlassSwitch.toggle()
        XCTAssertFalse(preferences.glass)
    }

    @MainActor
    func testAScriptedRunReadsItsScratchCopyAndNeverTheLiveDomain() {
        HubDefaults.isolate()
        XCTAssertTrue(HubDefaults.isolated)
        XCTAssertFalse(HubDefaults.preferences === HubPreferences.shared)
        XCTAssertFalse(HubDefaults.appearance === NativeSettingsAppearance.shared)
    }
}
