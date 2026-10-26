import AppKit
import CoreAudio
import SwiftUI
import XCTest

@testable import GenesisKit

/// Where Clicky plays: a picked device, a rule for the system output, or the system output; and which output the
/// late-output prompt offers.
@MainActor
final class ClickyOutputTests: XCTestCase {
    private let speakers = AudioOutputDevice(id: 1, uid: "BuiltInSpeakerDevice", name: "MacBook Pro Speakers",
                                              transport: kAudioDeviceTransportTypeBuiltIn, delay: 0.027)
    private let homePod = AudioOutputDevice(id: 2, uid: "airplay-work", name: "AirPlay",
                                             transport: kAudioDeviceTransportTypeAirPlay, delay: 2.012)
    private let monitor = AudioOutputDevice(id: 3, uid: "hdmi-monitor", name: "Monitor",
                                             transport: kAudioDeviceTransportTypeHDMI, delay: 0.019)
    private let loopback = AudioOutputDevice(id: 4, uid: "virtual", name: "Loopback",
                                              transport: kAudioDeviceTransportTypeVirtual, delay: 0.011)
    private var all: [AudioOutputDevice] { [speakers, homePod, monitor, loopback] }

    func testWithNoChoiceClickyFollowsTheSystemOutput() {
        let resolved = ClickyOutputRouting.resolve(preferences: ClickyPreferences(), outputs: all, systemID: homePod.id)
        XCTAssertNil(resolved.device)
        XCTAssertEqual(resolved.effective, homePod)
    }

    func testARuleForTheSystemOutputPlaysOnItsTarget() {
        var preferences = ClickyPreferences()
        preferences.outputRules = [ClickyOutputRule(whenUID: homePod.uid, whenName: homePod.name,
                                                    playOnUID: speakers.uid, playOnName: speakers.name)]
        XCTAssertEqual(ClickyOutputRouting.resolve(preferences: preferences, outputs: all, systemID: homePod.id).effective,
                       speakers)
        XCTAssertEqual(ClickyOutputRouting.resolve(preferences: preferences, outputs: all, systemID: monitor.id).effective,
                       monitor, "a rule applies only while the system plays on its output")
    }

    func testAPickedDeviceWinsOverRulesAndFallsBackWhenGone() {
        var preferences = ClickyPreferences()
        preferences.outputDeviceUID = monitor.uid
        preferences.outputDeviceName = monitor.name
        preferences.outputRules = [ClickyOutputRule(whenUID: homePod.uid, whenName: homePod.name,
                                                    playOnUID: speakers.uid, playOnName: speakers.name)]
        XCTAssertEqual(ClickyOutputRouting.resolve(preferences: preferences, outputs: all, systemID: homePod.id).effective,
                       monitor)
        let gone = ClickyOutputRouting.resolve(preferences: preferences, outputs: [speakers, homePod], systemID: homePod.id)
        XCTAssertEqual(gone.effective, homePod)
        XCTAssertTrue(gone.reason.contains("not connected"), gone.reason)
    }

    func testAcceptingFasterOutputReplacesTheActiveRuleOrDisconnectedPick() {
        var preferences = ClickyPreferences()
        preferences.outputRules = [ClickyOutputRule(whenUID: monitor.uid, whenName: monitor.name,
            playOnUID: homePod.uid, playOnName: homePod.name)]
        let routed = ClickyOutputRouting.resolve(preferences: preferences, outputs: all, systemID: monitor.id)
        let updated = ClickyOutputRouting.acceptingFasterOutput(speakers, preferences: preferences, resolution: routed)
        XCTAssertEqual(updated.outputRules.count, 1)
        XCTAssertEqual(updated.outputRules.first?.whenUID, monitor.uid)
        XCTAssertEqual(ClickyOutputRouting.resolve(preferences: updated, outputs: all, systemID: monitor.id).effective, speakers)

        preferences.outputDeviceUID = "disconnected"
        let fallback = ClickyOutputRouting.resolve(preferences: preferences, outputs: all, systemID: homePod.id)
        let picked = ClickyOutputRouting.acceptingFasterOutput(speakers, preferences: preferences, resolution: fallback)
        XCTAssertEqual(picked.outputDeviceUID, speakers.uid)
        XCTAssertEqual(ClickyOutputRouting.resolve(preferences: picked, outputs: all, systemID: homePod.id).effective, speakers)

        let system = ClickyOutputRouting.resolve(preferences: ClickyPreferences(), outputs: all, systemID: homePod.id)
        let followed = ClickyOutputRouting.acceptingFasterOutput(speakers, preferences: ClickyPreferences(), resolution: system)
        XCTAssertNil(followed.outputDeviceUID)
        XCTAssertEqual(ClickyOutputRouting.resolve(preferences: followed, outputs: all, systemID: homePod.id).effective, speakers)
    }

    func testTheSuggestionPrefersBuiltInSpeakersAndNeverAVirtualDevice() {
        XCTAssertEqual(AudioOutputs.suggestion(instead: homePod, outputs: all, limit: 0.15), speakers)
        XCTAssertEqual(AudioOutputs.suggestion(instead: homePod, outputs: [homePod, monitor, loopback], limit: 0.15),
                       monitor)
        XCTAssertNil(AudioOutputs.suggestion(instead: homePod, outputs: [homePod, loopback], limit: 0.15))
    }

    func testPreferencesSavedBeforeOutputsKeepTheirValues() throws {
        let old = #"{"selectedSwitch":"ember","volume":0.8,"releaseSounds":false,"randomizedPitch":true,"spatialAudio":true,"repeatSounds":false,"quietHours":false,"quietStart":1320,"quietEnd":480,"excludedApplications":[],"visualizer":true,"notifications":false,"collectStats":true,"reduceMotion":false,"reduceTransparency":false}"#
        let decoded = try JSONDecoder().decode(ClickyPreferences.self, from: Data(old.utf8))
        XCTAssertEqual(decoded.selectedSwitch, .ember)
        XCTAssertEqual(decoded.volume, 0.8)
        XCTAssertFalse(decoded.releaseSounds)
        XCTAssertNil(decoded.outputDeviceUID)
        XCTAssertTrue(decoded.delayWarning)
        XCTAssertEqual(decoded.delayWarningMilliseconds, 150)
        XCTAssertEqual(decoded.delayPromptSeconds, 45)
        var changed = decoded
        changed.delayPromptSeconds = 0
        changed.outputRules = [ClickyOutputRule(whenUID: "a", whenName: "A", playOnUID: "b", playOnName: "B")]
        let again = try JSONDecoder().decode(ClickyPreferences.self, from: JSONEncoder().encode(changed))
        XCTAssertEqual(again, changed)
    }

    func testPromptDurationNormalizesAndKeepsUntilDismissed() {
        var preferences = ClickyPreferences()
        preferences.delayPromptSeconds = -1
        preferences.normalize()
        XCTAssertEqual(preferences.delayPromptSeconds, 0)
        preferences.delayPromptSeconds = 900
        preferences.normalize()
        XCTAssertEqual(preferences.delayPromptSeconds, 300)
        preferences.delayPromptSeconds = 120
        preferences.normalize()
        XCTAssertEqual(preferences.delayPromptSeconds, 120)
    }

    func testDelayText() {
        XCTAssertEqual(homePod.delayText, "2.0 s late")
        XCTAssertEqual(speakers.delayText, "27 ms late")
    }

    /// Renders the prompt for the report: `CLICKY_PROMPT_SHOT=<png path>`.
    @MainActor
    func testThePromptRendersItsQuestion() throws {
        let view = ClickyDelayPromptView(late: homePod, suggestion: speakers, onSwitch: {}, onKeep: {}, onClose: {})
            .environment(\.colorScheme, .dark)
        let host = NSHostingView(rootView: view)
        host.frame = CGRect(origin: .zero, size: host.fittingSize)
        XCTAssertGreaterThan(host.fittingSize.height, 80)
        guard let path = ProcessInfo.processInfo.environment["CLICKY_PROMPT_SHOT"] else { return }
        let window = NSWindow(contentRect: CGRect(x: -3000, y: -3000, width: host.frame.width + 40, height: host.frame.height + 40),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.backgroundColor = NSColor(white: 0.18, alpha: 1)
        let container = NSView(frame: CGRect(origin: .zero, size: window.frame.size))
        host.frame.origin = CGPoint(x: 20, y: 20)
        container.addSubview(host)
        window.contentView = container
        window.orderFront(nil)
        defer { window.close() }
        container.layoutSubtreeIfNeeded()
        let rep = try XCTUnwrap(container.bitmapImageRepForCachingDisplay(in: container.bounds))
        container.cacheDisplay(in: container.bounds, to: rep)
        try XCTUnwrap(rep.representation(using: .png, properties: [:])).write(to: URL(fileURLWithPath: path))
    }

    /// Renders the settings card with this Mac's real outputs: `CLICKY_OUTPUT_CARD_SHOT=<png path>`.
    @MainActor
    func testTheOutputCardRendersTheDevicesAndARule() throws {
        guard let path = ProcessInfo.processInfo.environment["CLICKY_OUTPUT_CARD_SHOT"] else { return }
        let suite = "dev.genesis.clicky.output.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let appearance = NativeSettingsAppearance(defaults: defaults, notificationNamespace: suite, observeExternalChanges: false)
        let model = ClickyModel(defaults: defaults, appearance: appearance, observeSystemEvents: false)
        model.refreshOutput()
        if let system = model.output?.system,
           let faster = AudioOutputs.suggestion(instead: system, outputs: model.outputs, limit: .infinity) {
            model.setRule(when: system, playOn: faster)
        }
        let view = ClickyOutputCard(model: model).padding(24)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .background(NativeThemePalette.graphiteBase)
            .environment(\.nativeSettingsTheme, .graphite)
            .environment(\.colorScheme, .dark)
        let rep = try KitShots.render(view, size: CGSize(width: 680, height: 560), name: "clicky-output-card", settle: 0.6)
        try XCTUnwrap(rep.representation(using: .png, properties: [:])).write(to: URL(fileURLWithPath: path))
    }
}
