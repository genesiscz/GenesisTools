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
