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
        }
    }

    func testReduceTransparencyMakesTheNativeGlassThemeOpaque() {
        let look = HubLook.resolve(style: .native, glass: false, general: .glass, reduceTransparency: true)
        XCTAssertEqual(look.theme, .glass, "the chosen theme stays; the surfaces read it as solid")
        XCTAssertFalse(look.seeThrough)
        XCTAssertEqual(look.theme.effective(reduceTransparency: true, systemReduceTransparency: false), .solid)
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

    func testEachLookMapsToOneStyleAndTheme() {
        XCTAssertEqual(HubLookChoice.allCases.map(\.title), ["Hub", "Native · Glass", "Native · Solid", "Native · Gradient"])
        XCTAssertEqual(HubLookChoice.hub.style, .hub)
        XCTAssertNil(HubLookChoice.hub.theme, "the Hub look leaves General → Theme alone")
        XCTAssertEqual(HubLookChoice.nativeGlass.style, .native)
        XCTAssertEqual(HubLookChoice.nativeGlass.theme, .glass)
        XCTAssertEqual(HubLookChoice.nativeSolid.theme, .solid)
        XCTAssertEqual(HubLookChoice.nativeGradient.theme, .gradient)
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
        HubLookChoice.nativeGradient.apply(preferences: preferences, appearance: appearance)
        XCTAssertEqual(preferences.style, .native)
        XCTAssertEqual(appearance.theme, .gradient)
        XCTAssertEqual(defaults.string(forKey: "hub.style"), "native")
        XCTAssertEqual(defaults.string(forKey: "featureSettings.appearance.theme"), "gradient", "the settings window reads this")
        HubLookChoice.hub.apply(preferences: preferences, appearance: appearance)
        XCTAssertEqual(preferences.style, .hub)
        XCTAssertEqual(appearance.theme, .gradient, "the Hub look leaves General → Theme alone")
    }

    func testThePaletteListsTheFourLooksAndChecksTheCurrentOne() {
        let rows = HubPaletteEngine.suggestions(for: "look ", context: HubPaletteContext(look: .nativeSolid))
        XCTAssertEqual(rows.map(\.id), ["look-hub", "look-native-glass", "look-native-solid", "look-native-gradient"])
        XCTAssertEqual(rows.map(\.action), HubLookChoice.allCases.map { .setLook($0) })
        XCTAssertEqual(rows.filter { $0.symbol == "checkmark" }.map(\.id), ["look-native-solid"])
        XCTAssertNil(rows[0].subtitle)
        XCTAssertEqual(rows[3].subtitle, HubLookChoice.generalNote)
        XCTAssertEqual(HubPaletteEngine.suggestions(for: "look grad", context: HubPaletteContext()).map(\.id), ["look-native-gradient"])
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
