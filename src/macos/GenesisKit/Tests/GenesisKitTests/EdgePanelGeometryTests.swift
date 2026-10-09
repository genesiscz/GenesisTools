import SwiftUI
import XCTest

@testable import GenesisKit

final class EdgePanelGeometryTests: XCTestCase {
    private let screen = CGRect(x: -1600, y: 100, width: 1600, height: 1000)
    private let visible = CGRect(x: -1600, y: 150, width: 1600, height: 920)

    func testTopKeepsItsBezelAnchorAcrossSizes() {
        let compact = EdgePanelGeometry.frame(
            placement: .top, size: CGSize(width: 260, height: 36),
            screen: screen, visible: visible, sideCenterY: 600)
        let expanded = EdgePanelGeometry.frame(
            placement: .top, size: CGSize(width: 438, height: 490),
            screen: screen, visible: visible, sideCenterY: 600)
        for p in stride(from: 0.0, through: 1.0, by: 0.1) {
            let frame = EdgePanelGeometry.interpolate(from: compact, to: expanded, progress: p)
            XCTAssertEqual(frame.midX, screen.midX, accuracy: 0.01)
            XCTAssertEqual(frame.maxY, screen.maxY, accuracy: 0.01)
        }
    }

    func testSideFramesStayOnScreenIncludingNegativeOrigins() {
        for edge in [EdgePanelPlacement.left, .right] {
            let frame = EdgePanelGeometry.frame(
                placement: edge, size: CGSize(width: 440, height: 456),
                screen: screen, visible: visible, sideCenterY: 10_000)
            XCTAssertEqual(frame.maxY, visible.maxY)
            XCTAssertTrue(visible.contains(frame))
            if edge == .right {
                XCTAssertEqual(frame.maxX, visible.maxX)
            } else {
                XCTAssertEqual(frame.minX, visible.minX)
            }
        }
    }

    func testSmallDisplaysClampTheOpenSize() {
        let frame = EdgePanelGeometry.frame(
            placement: .right, size: CGSize(width: 3000, height: 3000),
            screen: screen, visible: visible, sideCenterY: 600)
        XCTAssertEqual(frame, visible)
    }

    func testSideJoinsPhysicalBezelWhenVisibleFrameIsInset() {
        let inset = CGRect(x: -1560, y: 150, width: 1520, height: 920)
        let right = EdgePanelGeometry.frame(
            placement: .right, size: CGSize(width: 38, height: 200),
            screen: screen, visible: inset, sideCenterY: 600)
        let left = EdgePanelGeometry.frame(
            placement: .left, size: CGSize(width: 38, height: 200),
            screen: screen, visible: inset, sideCenterY: 600)
        XCTAssertEqual(right.maxX, screen.maxX)
        XCTAssertEqual(left.minX, screen.minX)
        XCTAssertGreaterThanOrEqual(right.minY, inset.minY)
    }

    func testShapeJoinsBezelWithConcaveShoulders() {
        let rect = CGRect(x: 0, y: 0, width: 100, height: 200)
        let right = EdgePanelShape(placement: .right).path(in: rect)
        XCTAssertTrue(right.contains(CGPoint(x: 99.9, y: 5)))
        XCTAssertFalse(right.contains(CGPoint(x: 85, y: 5)))
        XCTAssertTrue(right.contains(CGPoint(x: 5, y: 100)))
        let left = EdgePanelShape(placement: .left).path(in: rect)
        XCTAssertTrue(left.contains(CGPoint(x: 0.1, y: 5)))
        XCTAssertFalse(left.contains(CGPoint(x: 15, y: 5)))
        let top = EdgePanelShape(placement: .top).path(in: rect)
        XCTAssertTrue(top.contains(CGPoint(x: 5, y: 0.1)))
        XCTAssertFalse(top.contains(CGPoint(x: 5, y: 15)))
    }

    func testWideMediaStaysReachableBesideEitherScreenEdge() {
        for edge in [EdgePanelPlacement.left, .right, .top] {
            let anchor = EdgePanelGeometry.frame(
                placement: edge, size: CGSize(width: 432, height: 440),
                screen: screen, visible: visible, sideCenterY: 600)
            let media = EdgePanelGeometry.mediaFrame(anchor: anchor, visible: visible)
            XCTAssertTrue(visible.contains(media))
            XCTAssertEqual(media.width, 740)
        }
        let small = CGRect(x: -800, y: -500, width: 640, height: 480)
        XCTAssertTrue(small.contains(EdgePanelGeometry.mediaFrame(anchor: .zero, visible: small)))
    }

    func testMotionFinishesAtExactTargetAndClosingDoesNotOvershoot() {
        XCTAssertEqual(EdgePanelGeometry.motionProgress(0, opening: true), 0)
        XCTAssertEqual(EdgePanelGeometry.motionProgress(1, opening: true), 1)
        XCTAssertEqual(EdgePanelGeometry.motionProgress(1, opening: false), 1)
        for p in stride(from: 0.0, through: 1.0, by: 0.02) {
            let value = EdgePanelGeometry.motionProgress(p, opening: false)
            XCTAssertGreaterThanOrEqual(value, 0)
            XCTAssertLessThanOrEqual(value, 1)
        }
    }
}

final class WidgetSelectionTests: XCTestCase {
    func testPresentationMetadataDoesNotChangeConversationIdentity() {
        let target = WidgetTarget(
            hostId: "local", provider: "codex", sessionId: "fixture", sourceHome: "/fixture/home", cwd: "/old")
        var updated = target
        updated.cwd = "/new"
        XCTAssertTrue(target.hasSameIdentity(as: updated))
        updated.sourceHome = "/another/home"
        XCTAssertFalse(target.hasSameIdentity(as: updated))
    }

    func testRelaunchRestoresItsDestinationEvenWhenFilteredOrTemporarilyMissing() {
        XCTAssertEqual(
            WidgetSelection.initial(persisted: "local:codex:chosen:home", visibleKeys: ["another"]),
            "local:codex:chosen:home")
        XCTAssertEqual(WidgetSelection.initial(persisted: nil, visibleKeys: ["first", "second"]), "first")
        XCTAssertEqual(WidgetSelection.initial(persisted: nil, visibleKeys: []), "")
    }
}

final class WidgetModuleTests: XCTestCase {
    @MainActor
    func testBothSurfacesShareOneLifecycleAndCollapseOnlyAfterTheLastViewer() throws {
        let registry = WidgetModuleRegistry()
        var events: [WidgetModulePresentation?] = []
        try registry.register(
            WidgetModuleDescriptor(
                id: "fixture", title: "Fixture", symbol: "circle", tint: .blue,
                summary: { "Ready" }, visibilityChanged: { events.append($0) }
            ) { _ in EmptyView() })
        let top = WidgetSurfaceID(edge: .top)
        let side = WidgetSurfaceID(edge: .right, group: 1)
        registry.update(surface: top, moduleID: "fixture", presentation: .expanded)
        registry.update(surface: side, moduleID: "fixture", presentation: .expanded)
        registry.update(surface: top, moduleID: nil)
        XCTAssertEqual(events, [.expanded])
        registry.update(surface: side, moduleID: "fixture", presentation: .preview)
        registry.update(surface: side, moduleID: nil)
        XCTAssertEqual(events, [.expanded, .preview, nil])
        XCTAssertThrowsError(
            try registry.register(
                WidgetModuleDescriptor(
                    id: "fixture", title: "Again", symbol: "circle", tint: .blue, summary: { "" }
                ) { _ in EmptyView() }))
        XCTAssertEqual(registry.modules.count, 1)
    }

    func testLayoutsRetainFutureModulesAndDeduplicateOnlyWithinEachGroup() {
        let layout = WidgetLayoutConfiguration(
            topModules: ["agents", "future", "agents"],
            sideGroups: [["agents", "agents"], ["agents", "focus"], ["future"]],
            separated: true, sidePosition: 12)
        XCTAssertEqual(layout.topModules, ["agents", "future"])
        XCTAssertEqual(layout.top(available: ["agents"]), ["agents"])
        XCTAssertEqual(layout.groups(available: ["agents", "focus"]), [["agents"], ["agents", "focus"], []])
        XCTAssertEqual(layout.sidePosition, 1)
    }

    func testClusterDragUsesAvailableTravelAndKeepsAllPartsInsideTheDisplay() {
        let visible = CGRect(x: -1800, y: -300, width: 1800, height: 900)
        let heights: [CGFloat] = [200, 120, 48]
        for position in [0.0, 0.5, 1.0] {
            let centers = WidgetClusterGeometry.centers(heights: heights, position: position, visible: visible)
            for (index, center) in centers.enumerated() {
                XCTAssertLessThanOrEqual(center + heights[index] / 2, visible.maxY)
                XCTAssertGreaterThanOrEqual(center - heights[index] / 2, visible.minY)
            }
        }
        XCTAssertEqual(
            WidgetClusterGeometry.position(
                starting: 0.5, translationDown: 100, clusterHeight: 400, visibleHeight: 900), 0.7, accuracy: 0.0001)
        XCTAssertEqual(
            WidgetClusterGeometry.position(
                starting: 0.5, translationDown: -2000, clusterHeight: 400, visibleHeight: 900), 0)
    }
}

final class WidgetInteractionTests: XCTestCase {
    @MainActor
    private func model(defaults: UserDefaults) -> WidgetModel {
        WidgetModel(
            binaryPath: "/fixture/no-process", defaults: defaults,
            appearance: NativeSettingsAppearance(
                defaults: defaults, notificationNamespace: UUID().uuidString, observeExternalChanges: false))
    }

    @MainActor
    func testEachSurfaceRestoresItsOwnModuleAndRemovedModulesFallBack() {
        let domain = "widget-tests." + UUID().uuidString
        let defaults = UserDefaults(suiteName: domain)!
        defer { defaults.removePersistentDomain(forName: domain) }
        let value = model(defaults: defaults)
        let top = WidgetSurfaceID(edge: .top)
        let side = WidgetSurfaceID(edge: .right, group: 2)
        value.openModule("voice", on: side)
        XCTAssertEqual(value.activeModuleID, "voice")
        XCTAssertEqual(value.presentation(for: side), .expanded)
        XCTAssertEqual(value.presentation(for: top), .compact)
        value.openModule("tasks", on: top)
        XCTAssertEqual(value.presentation(for: side), .compact)
        XCTAssertEqual(value.activeModuleID, "tasks")
        value.collapse()

        let restored = model(defaults: defaults)
        XCTAssertEqual(restored.moduleSelections[top.key], "tasks")
        XCTAssertEqual(restored.moduleSelections[side.key], "voice")
        restored.resolveModules(["capture", "agents"], on: top)
        XCTAssertEqual(restored.moduleSelections[top.key], "capture")
        restored.resolveModules([], on: side)
        XCTAssertNil(restored.moduleSelections[side.key])
        value.stop()
        restored.stop()
    }

    @MainActor
    func testSliderBurstWritesOneMergedPreferenceAction() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
            "widget-preferences-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer {
            do { try FileManager.default.removeItem(at: directory) } catch { XCTFail("Fixture cleanup: \(error)") }
        }
        let snapshot = """
            {"version":1,"state":{"version":1,"revision":0,"preferences":{"excludedKeys":[],"projects":[],"sessions":[],"showChanges":true,"placement":"both","side":"right","quietSeconds":15,"voiceProvider":"xai","voiceLanguage":""},"assets":{},"drafts":{},"outgoing":[]},"sessions":[],"cards":[],"manifests":{},"errors":[]}
            """
        try snapshot.write(to: directory.appendingPathComponent("snapshot.json"), atomically: true, encoding: .utf8)
        let script = directory.appendingPathComponent("tools")
        let actions = directory.appendingPathComponent("actions.jsonl")
        try """
        #!/bin/sh
        case "$*" in
          *snapshot*) cat '\(directory.path)/snapshot.json'; exit 0 ;;
        esac
        while [ "$#" -gt 0 ]; do
          if [ "$1" = "--input" ]; then
            shift
            cat "$1" >> '\(actions.path)'
            printf '\\n' >> '\(actions.path)'
          fi
          shift
        done
        printf '{}'
        """.write(to: script, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)
        let domain = "widget-tests." + UUID().uuidString
        let defaults = UserDefaults(suiteName: domain)!
        defer { defaults.removePersistentDomain(forName: domain) }
        let value = WidgetModel(
            binaryPath: script.path, stateRoot: directory.path, defaults: defaults,
            appearance: NativeSettingsAppearance(
                defaults: defaults, notificationNamespace: domain, observeExternalChanges: false))
        defer { value.stop() }
        value.startSettings()
        let deadline = ContinuousClock.now + .seconds(5)
        while value.snapshot == nil && ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(100))
        }
        XCTAssertNotNil(value.snapshot)
        for step in 0...100 { value.updatePreferences(["sidePosition": .number(Double(step) / 100)]) }
        value.updatePreferences(["side": .string("left")])
        XCTAssertEqual(value.snapshot?.state.preferences.sidePosition, 1)
        XCTAssertEqual(value.snapshot?.state.preferences.side, "left")
        while !FileManager.default.fileExists(atPath: actions.path) && ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(100))
        }
        let rows = try String(contentsOf: actions, encoding: .utf8).split(separator: "\n")
        XCTAssertEqual(rows.count, 1)
        let request = try JSONDecoder().decode(WidgetJSON.self, from: Data(rows[0].utf8))
        guard case .object(let fields) = request, case .object(let patch) = fields["patch"] else {
            return XCTFail("Expected one preference patch")
        }
        XCTAssertEqual(patch["sidePosition"], .number(1))
        XCTAssertEqual(patch["side"], .string("left"))
    }

    @MainActor
    func testHoverStaysPassiveAndAnExplicitClickCancelsPendingHover() async throws {
        let domain = "widget-tests." + UUID().uuidString
        let defaults = UserDefaults(suiteName: domain)!
        defer { defaults.removePersistentDomain(forName: domain) }
        let value = model(defaults: defaults)
        defer { value.stop() }
        let top = WidgetSurfaceID(edge: .top)
        let side = WidgetSurfaceID(edge: .right)
        value.hover(side, inside: true)
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(value.presentation(for: side), .preview)
        XCTAssertNil(value.expanded)
        value.hover(top, inside: true)
        value.openModule("tasks", on: side)
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertNil(value.hoveredSurface)
        XCTAssertEqual(value.presentation(for: side), .expanded)
        XCTAssertEqual(value.presentation(for: top), .compact)
        value.collapse()
        XCTAssertNil(value.hoveredSurface)
        XCTAssertNil(value.expanded)
    }
}

/// "Show the widget": the coordinator builds and orders front edge panels only while the switch is on.
final class WidgetVisibilityTests: XCTestCase {
    private struct Fixture {
        let directory: URL
        let coordinator: WidgetCoordinator
        let defaults: UserDefaults
        let domain: String
    }

    /// A fake `tools` whose `hub widget watch` streams one saved snapshot, written before `showWidget` existed.
    @MainActor
    private func fixture(actionExit: Int = 0) throws -> Fixture {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
            "widget-visibility-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let saved = """
            {"version":1,"state":{"version":1,"revision":0,"preferences":{"excludedKeys":[],"projects":[],"sessions":[],"showChanges":true,"placement":"both","side":"right","quietSeconds":15,"voiceProvider":"xai","voiceLanguage":""},"assets":{},"drafts":{},"outgoing":[]},"sessions":[],"cards":[],"manifests":{},"errors":[]}
            """
        try saved.write(to: directory.appendingPathComponent("saved.json"), atomically: true, encoding: .utf8)
        let script = directory.appendingPathComponent("tools")
        try """
        #!/bin/sh
        case "$*" in
          *--input*) printf '{}'; exit \(actionExit) ;;
          *watch*) cat '\(directory.path)/saved.json'; printf '\\n'; cat > /dev/null; exit 0 ;;
          *) cat '\(directory.path)/saved.json'; exit 0 ;;
        esac
        """.write(to: script, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)
        let domain = "widget-tests." + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: domain))
        let model = WidgetModel(
            binaryPath: script.path, stateRoot: directory.path, defaults: defaults,
            appearance: NativeSettingsAppearance(
                defaults: defaults, notificationNamespace: domain, observeExternalChanges: false))
        let coordinator = WidgetCoordinator(
            binaryPath: script.path, stateRoot: directory.path, openHub: { _ in }, model: model)
        return Fixture(directory: directory, coordinator: coordinator, defaults: defaults, domain: domain)
    }

    private func cleanUp(_ fixture: Fixture) {
        fixture.defaults.removePersistentDomain(forName: fixture.domain)
        do { try FileManager.default.removeItem(at: fixture.directory) } catch { XCTFail("Fixture cleanup: \(error)") }
    }

    @MainActor
    private func waitFor(_ condition: () -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(5)
        while !condition() && ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(50))
        }
    }

    @MainActor
    func testAWidgetThatIsOffShowsNoPanelAndOpensTheSettingsInstead() async throws {
        let fixture = try fixture()
        defer { cleanUp(fixture) }
        let coordinator = fixture.coordinator
        var pages: [String] = []
        var ordered = 0
        coordinator.settingsPresenter = { pages.append($0) }
        coordinator.orderFront = { _ in
            ordered += 1
            XCTFail("A widget that is off ordered an edge panel front")
        }
        coordinator.start()
        defer { coordinator.stop() }
        try await waitFor { coordinator.model.snapshot != nil && !pages.isEmpty }

        XCTAssertNil(coordinator.model.snapshot?.state.preferences.showWidget, "an old state has no key")
        XCTAssertFalse(coordinator.panelsEnabled)
        XCTAssertEqual(pages, ["widgets.general"], "a bare --widget opens the settings when the widget is off")
        XCTAssertEqual(coordinator.panelCount, 0)
        XCTAssertFalse(coordinator.panelMonitorsInstalled)

        coordinator.openSession("fixture-session")
        XCTAssertEqual(pages, ["widgets.general", "widgets.general"])
        XCTAssertEqual(coordinator.model.selectedKey, "fixture-session")
        XCTAssertNil(coordinator.model.expanded)
        XCTAssertEqual(coordinator.panelCount, 0)
        XCTAssertEqual(ordered, 0)
    }

    @MainActor
    func testTurningTheSwitchOnShowsThePanelsAndTurningItOffHidesThem() async throws {
        try XCTSkipIf(NSScreen.screens.isEmpty, "Edge panels need a display")
        let fixture = try fixture()
        defer { cleanUp(fixture) }
        let coordinator = fixture.coordinator
        var ordered = 0
        coordinator.settingsPresenter = { _ in }
        coordinator.orderFront = { _ in ordered += 1 }
        coordinator.start(showSettings: true)
        defer { coordinator.stop() }
        try await waitFor { coordinator.model.snapshot != nil }
        XCTAssertEqual(coordinator.panelCount, 0)

        coordinator.model.updatePreferences(["showWidget": .bool(true)])
        XCTAssertTrue(coordinator.panelsEnabled)
        XCTAssertGreaterThan(coordinator.panelCount, 0)
        XCTAssertGreaterThan(ordered, 0, "the panels order front as soon as the switch turns on")
        XCTAssertTrue(coordinator.panelMonitorsInstalled)

        coordinator.model.updatePreferences(["showWidget": .bool(false)])
        XCTAssertEqual(coordinator.panelCount, 0)
        XCTAssertFalse(coordinator.panelMonitorsInstalled)
    }

    /// The settings face starts the widget face from `preferencesSaved`, so it must fire only once the hub stored
    /// the switch: a launch before that would read the switch as off.
    @MainActor
    func testASavedSwitchIsReportedOnlyAfterTheHubStoresIt() async throws {
        let fixture = try fixture()
        defer { cleanUp(fixture) }
        let model = fixture.coordinator.model
        defer { model.stop() }
        model.startSettings()
        try await waitFor { model.snapshot != nil }
        var saved: [[String: WidgetJSON]] = []
        model.preferencesSaved = { saved.append($0) }
        model.updatePreferences(["showWidget": .bool(true)])
        XCTAssertTrue(saved.isEmpty, "nothing is stored before the debounced write")
        try await waitFor { !saved.isEmpty }
        XCTAssertEqual(saved, [["showWidget": .bool(true)]])
    }

    @MainActor
    func testARefusedSwitchIsNeverReportedAsSaved() async throws {
        let fixture = try fixture(actionExit: 1)
        defer { cleanUp(fixture) }
        let model = fixture.coordinator.model
        defer { model.stop() }
        model.startSettings()
        try await waitFor { model.snapshot != nil }
        var saved: [[String: WidgetJSON]] = []
        model.preferencesSaved = { saved.append($0) }
        model.updatePreferences(["showWidget": .bool(true)])
        try await waitFor { model.error != nil }
        XCTAssertNotNil(model.error)
        XCTAssertTrue(saved.isEmpty)
    }

    @MainActor
    func testTheSettingsOfferExactlyTheModulesTheHostRegisters() throws {
        let fixture = try fixture()
        defer { cleanUp(fixture) }
        XCTAssertEqual(
            WidgetModuleChoice.builtins.map(\.id), fixture.coordinator.modules.modules.map(\.id),
            "a settings toggle for an unregistered module would silently do nothing")
    }
}

final class WidgetOutgoingTests: XCTestCase {
    private func message(_ index: Int, state: String, payload: String? = nil) throws -> WidgetOutgoing {
        let json = """
            {"id":"m\(index)","target":{"hostId":"local","provider":"codex","sessionId":"s","sourceHome":"","cwd":"/"},
            "payload":\(payload ?? #"{"kind":"followup","text":"message \#(index)"}"#),"assetIds":[],
            "createdAt":\(index),"sequence":\(index),"state":"\(state)"}
            """
        return try JSONDecoder().decode(WidgetOutgoing.self, from: Data(json.utf8))
    }

    func testAnOldBlockerStaysListedBehindMoreThanTwentyFollowUps() throws {
        let blocker = try message(0, state: "failed")
        let settled = try message(1, state: "sent")
        let queued = try (2..<32).map { try message($0, state: "queued") }
        let shown = WidgetOutgoing.shown([blocker, settled] + queued)
        XCTAssertEqual(shown.first?.id, "m0", "the failed message keeps its Retry and Edit controls")
        XCTAssertFalse(shown.contains { $0.id == "m1" }, "settled history is still bounded")
        XCTAssertEqual(shown.count, 31)

        let history = try (0..<30).map { try message($0, state: "sent") }
        XCTAssertEqual(WidgetOutgoing.shown(history).map(\.id), (10..<30).map { "m\($0)" })
    }

    func testAFormWithoutComposerTextKeepsItsLabel() throws {
        let blank = try message(0, state: "sent", payload: #"{"kind":"form","id":"f","text":"  ","answers":[]}"#)
        XCTAssertEqual(blank.text, "Form answer")
        let written = try message(1, state: "sent", payload: #"{"kind":"form","id":"f","text":"Why","answers":[]}"#)
        XCTAssertEqual(written.text, "Why")
        let decision = try message(
            2, state: "sent", payload: #"{"kind":"decision","id":"d","number":1,"expectedRevision":1,"text":""}"#)
        XCTAssertEqual(decision.text, "", "a decision without text stays empty, it is not a form")
    }
}
