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

    func testTheNativeStyleFollowsGeneralUntilGlassPicksTheGlassTheme() {
        let gradient = HubLook.resolve(style: .native, glass: false, general: .gradient, reduceTransparency: false)
        XCTAssertEqual(gradient.theme, .gradient)
        XCTAssertFalse(gradient.seeThrough)
        let solid = HubLook.resolve(style: .native, glass: false, general: .solid, reduceTransparency: false)
        XCTAssertEqual(solid.theme, .solid)
        XCTAssertFalse(solid.seeThrough)
        let generalGlass = HubLook.resolve(style: .native, glass: false, general: .glass, reduceTransparency: false)
        XCTAssertTrue(generalGlass.seeThrough)
        let switched = HubLook.resolve(style: .native, glass: true, general: .gradient, reduceTransparency: false)
        XCTAssertEqual(switched.theme, .glass)
        XCTAssertTrue(switched.seeThrough)
    }

    func testReduceTransparencyMakesTheNativeStyleOpaqueEvenWithGlassOn() {
        let look = HubLook.resolve(style: .native, glass: true, general: .glass, reduceTransparency: true)
        XCTAssertEqual(look.theme, .glass, "the chosen theme stays; the surfaces read it as solid")
        XCTAssertFalse(look.seeThrough)
        XCTAssertEqual(look.theme.effective(reduceTransparency: true, systemReduceTransparency: false), .solid)
    }

    @MainActor
    func testAScriptedRunReadsItsScratchCopyAndNeverTheLiveDomain() {
        HubDefaults.isolate()
        XCTAssertTrue(HubDefaults.isolated)
        XCTAssertFalse(HubDefaults.preferences === HubPreferences.shared)
        XCTAssertFalse(HubDefaults.appearance === NativeSettingsAppearance.shared)
    }
}
