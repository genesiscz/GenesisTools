import SwiftUI
import XCTest

@testable import GenesisKit

final class EdgePanelGeometryTests: XCTestCase {
    private let screen = CGRect(x: -1600, y: 100, width: 1600, height: 1000)
    private let visible = CGRect(x: -1600, y: 150, width: 1600, height: 920)

    func testTopWidthReservesRoomForTheCutoutAndEveryVisibleControl() {
        XCTAssertEqual(WidgetClusterGeometry.topWidth(cutout: 200, moduleCount: 1), 364)
        XCTAssertEqual(WidgetClusterGeometry.topWidth(cutout: 200, moduleCount: 6), 524)
        XCTAssertEqual(WidgetClusterGeometry.topWidth(cutout: 0, moduleCount: 6), 410)
        XCTAssertEqual(WidgetClusterGeometry.topWidth(cutout: 200, moduleCount: 12), 524)
    }

    func testShortDisplayReservesCompactRailsBeforeExpandingOneGroup() {
        let allocation = WidgetClusterGeometry.allocate(
            heights: [(189, 600), (100, 100), (108, 108)], visibleHeight: 500)
        XCTAssertEqual(allocation.heights, [268, 100, 108])
        XCTAssertEqual(allocation.gap, 12)
        let roomy = WidgetClusterGeometry.allocate(
            heights: [(189, 600), (100, 100), (108, 108)], visibleHeight: 1000)
        XCTAssertEqual(roomy.heights, [600, 100, 108])
        let overflowing = WidgetClusterGeometry.allocate(
            heights: [(318, 600), (106, 106), (108, 108)], visibleHeight: 350)
        XCTAssertEqual(overflowing.heights, [112, 106, 108], "Only the tall rail needs scrolling here")
    }

    func testOverflowClustersFitShortDisplaysWithoutOverlappingAtEitherDragLimit() {
        for available in [1.0, 20, 120, 240, 300, 500] {
            for requests: [(minimum: CGFloat, preferred: CGFloat)] in [
                [(318, 660)], [(288, 600), (100, 100), (108, 108)], [(318, 318), (318, 318), (318, 318)]
            ] {
                let allocation = WidgetClusterGeometry.allocate(heights: requests, visibleHeight: available)
                let visible = CGRect(x: -800, y: -400, width: 800, height: available)
                for position in [0.0, 0.5, 1.0] {
                    let centers = WidgetClusterGeometry.centers(
                        heights: allocation.heights, position: position, visible: visible, gap: allocation.gap)
                    var previousBottom = visible.maxY
                    for (index, height) in allocation.heights.enumerated() {
                        let top = centers[index] + height / 2
                        let bottom = centers[index] - height / 2
                        XCTAssertGreaterThanOrEqual(height, 0)
                        XCTAssertLessThanOrEqual(top, previousBottom + 0.001)
                        XCTAssertGreaterThanOrEqual(bottom, visible.minY - 0.001)
                        previousBottom = bottom - allocation.gap
                    }
                }
            }
        }
    }

    func testRoundedSurfacesKeepTheirFrameAndCutAllFourCorners() {
        let rect = CGRect(x: -400, y: 120, width: 44, height: 165)
        for edge in [EdgePanelPlacement.left, .right, .top] {
            let path = EdgePanelShape(placement: edge, corner: 20, joined: false).path(in: rect)
            XCTAssertEqual(path.boundingRect, rect)
            XCTAssertTrue(path.contains(CGPoint(x: rect.midX, y: rect.midY)))
            for x in [rect.minX + 1, rect.maxX - 1] {
                for y in [rect.minY + 1, rect.maxY - 1] {
                    XCTAssertFalse(path.contains(CGPoint(x: x, y: y)))
                }
            }
        }
    }

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
            try await Task.sleep(for: .milliseconds(100))
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

/// The local submission journal keeps submission order per conversation across a failed enqueue.
final class WidgetJournalTests: XCTestCase {
    @MainActor
    func testAFailedSubmissionHoldsBackLaterOnesToItsConversationOnly() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
            "widget-journal-" + UUID().uuidString)
        let journal = directory.appendingPathComponent("native-submissions")
        try FileManager.default.createDirectory(at: journal, withIntermediateDirectories: true)
        defer {
            do { try FileManager.default.removeItem(at: directory) } catch { XCTFail("Fixture cleanup: \(error)") }
        }
        let flag = directory.appendingPathComponent("refuse-first")
        let sent = directory.appendingPathComponent("sent.txt")
        let script = directory.appendingPathComponent("tools")
        try """
        #!/bin/sh
        while [ "$#" -gt 0 ]; do
          if [ "$1" = "--input" ]; then
            shift
            if [ -e '\(flag.path)' ] && grep -q 'first' "$1"; then echo refused >&2; exit 1; fi
            printf '%s\\n' "$(sed -n 's/.*"text":"\\([a-z-]*\\)".*/\\1/p' "$1")" >> '\(sent.path)'
          fi
          shift
        done
        printf '{}'
        """.write(to: script, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)
        try Data().write(to: flag)
        func submission(_ name: String, session: String, text: String) throws {
            let request = """
                {"action":"enqueue","target":{"hostId":"local","provider":"codex","sessionId":"\(session)",\
                "sourceHome":"","cwd":"/"},"payload":{"kind":"followup","text":"\(text)"}}
                """
            try request.write(to: journal.appendingPathComponent(name), atomically: true, encoding: .utf8)
        }
        try submission("1-a.json", session: "one", text: "first")
        try submission("2-b.json", session: "one", text: "second")
        try submission("3-c.json", session: "two", text: "other")

        let domain = "widget-tests." + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: domain))
        defer { defaults.removePersistentDomain(forName: domain) }
        let model = WidgetModel(
            binaryPath: script.path, stateRoot: directory.path, defaults: defaults,
            appearance: NativeSettingsAppearance(
                defaults: defaults, notificationNamespace: domain, observeExternalChanges: false))
        func remaining() throws -> [String] {
            try FileManager.default.contentsOfDirectory(atPath: journal.path).filter { $0.hasSuffix(".json") }.sorted()
        }
        func waitFor(_ condition: () throws -> Bool) async throws {
            let deadline = ContinuousClock.now + .seconds(5)
            while try !condition() && ContinuousClock.now < deadline {
                try await Task.sleep(for: .milliseconds(100))
            }
        }

        model.drainJournal()
        try await waitFor { try remaining() == ["1-a.json", "2-b.json"] && model.error != nil }
        XCTAssertEqual(try remaining(), ["1-a.json", "2-b.json"], "the later message to the same conversation waits")
        XCTAssertEqual(try String(contentsOf: sent, encoding: .utf8), "other\n", "another conversation still sends")

        try FileManager.default.removeItem(at: flag)
        model.drainJournal()
        try await waitFor { try remaining().isEmpty }
        XCTAssertEqual(try String(contentsOf: sent, encoding: .utf8), "other\nfirst\nsecond\n")
    }
}

/// A model over a fake `tools` that serves one snapshot (one session, key `k1`) and logs every action it receives.
final class WidgetConnectionTests: XCTestCase {
    private struct Fixture {
        let directory: URL
        let actions: URL
        let model: WidgetModel
        let domain: String
    }

    @MainActor
    private func fixture(watchExits: Bool = false) throws -> Fixture {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
            "widget-connection-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let snapshot = """
            {"version":1,"state":{"version":1,"revision":0,"preferences":{"excludedKeys":[],"projects":[],"sessions":[],"showChanges":false,"placement":"both","side":"right","quietSeconds":15,"voiceProvider":"xai","voiceLanguage":""},"assets":{},"drafts":{},"outgoing":[]},"sessions":[{"key":"k1","target":{"hostId":"local","provider":"codex","sessionId":"s1","sourceHome":"","cwd":"/"},"title":"Fixture","project":"Fixture","activityAt":1,"status":"recent","pinned":true,"visible":true,"hiddenByFilter":false}],"cards":[],"manifests":{},"errors":[]}
            """
        try snapshot.write(to: directory.appendingPathComponent("snapshot.json"), atomically: true, encoding: .utf8)
        let actions = directory.appendingPathComponent("actions.jsonl")
        let script = directory.appendingPathComponent("tools")
        let watch = watchExits ? "exit 3" : "cat > /dev/null; exit 0"
        try """
        #!/bin/sh
        case "$*" in
          *watch*) cat '\(directory.path)/snapshot.json'; printf '\\n'; \(watch) ;;
          *snapshot*) cat '\(directory.path)/snapshot.json'; exit 0 ;;
        esac
        while [ "$#" -gt 0 ]; do
          if [ "$1" = "--input" ]; then shift; cat "$1" >> '\(actions.path)'; printf '\\n' >> '\(actions.path)'; fi
          shift
        done
        printf '{}'
        """.write(to: script, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)
        let domain = "widget-tests." + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: domain))
        let model = WidgetModel(
            binaryPath: script.path, stateRoot: directory.path, defaults: defaults,
            appearance: NativeSettingsAppearance(
                defaults: defaults, notificationNamespace: domain, observeExternalChanges: false))
        return Fixture(directory: directory, actions: actions, model: model, domain: domain)
    }

    private func cleanUp(_ fixture: Fixture) {
        UserDefaults(suiteName: fixture.domain)?.removePersistentDomain(forName: fixture.domain)
        do { try FileManager.default.removeItem(at: fixture.directory) } catch { XCTFail("Fixture cleanup: \(error)") }
    }

    @MainActor
    private func waitFor(_ condition: () throws -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(5)
        while try !condition() && ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(100))
        }
    }

    private func actionNames(_ fixture: Fixture) throws -> [String] {
        guard FileManager.default.fileExists(atPath: fixture.actions.path) else { return [] }
        return try String(contentsOf: fixture.actions, encoding: .utf8).split(separator: "\n").map { line in
            let request = try JSONDecoder().decode(WidgetJSON.self, from: Data(line.utf8))
            guard case .object(let fields) = request, case .string(let name) = fields["action"] else { return "?" }
            return name
        }
    }

    /// Clearing the composer and pressing Edit at once: the debounced empty save must reach the hub before the
    /// edit, never after it, where it would wipe the restored message.
    @MainActor
    func testClearingTheDraftAndEditingAtOnceKeepsTheRestoredMessage() async throws {
        let fixture = try fixture()
        defer { cleanUp(fixture) }
        let model = fixture.model
        defer { model.stop() }
        model.startSettings()
        try await waitFor { model.selectedKey == "k1" }
        XCTAssertEqual(model.selectedKey, "k1")
        let message = try JSONDecoder().decode(
            WidgetOutgoing.self,
            from: Data(
                """
                {"id":"m1","target":{"hostId":"local","provider":"codex","sessionId":"s1","sourceHome":"","cwd":"/"},
                "payload":{"kind":"followup","text":"Restore me"},"assetIds":["a1"],"createdAt":1,"sequence":1,
                "state":"failed"}
                """.utf8))
        model.setText("")
        model.editOutgoing(message)
        try await waitFor { try self.actionNames(fixture).contains("edit") && model.notice != nil }
        try await Task.sleep(for: .milliseconds(500))
        XCTAssertEqual(try actionNames(fixture), ["draft-text", "edit"])
        XCTAssertEqual(model.drafts["k1"], WidgetDraft(text: "Restore me", assetIds: ["a1"]))
    }

    @MainActor
    func testAWatcherThatStopsLeavesReconnectAvailableBesideTheLastSnapshot() async throws {
        let fixture = try fixture(watchExits: true)
        defer { cleanUp(fixture) }
        let model = fixture.model
        defer { model.stop() }
        model.start()
        try await waitFor { model.connectionLost }
        XCTAssertTrue(model.connectionLost)
        XCTAssertNotNil(model.snapshot, "the stale snapshot stays, so the view cannot rely on snapshot == nil")
        model.error = nil
        XCTAssertTrue(model.connectionLost, "dismissing the error keeps Reconnect")

        try FileManager.default.setAttributes(
            [.posixPermissions: 0o644], ofItemAtPath: fixture.directory.appendingPathComponent("tools").path)
        model.start()
        XCTAssertNotNil(model.error, "the tools binary can no longer launch")
        XCTAssertTrue(model.connectionLost, "a reconnect that cannot launch keeps Reconnect beside the snapshot")
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

    /// Mirrors `changeOutgoing`: everything before delivery can be edited or cancelled, so a message held in
    /// preparation or review never leaves its conversation blocked without a way out.
    func testMessagesBeforeDeliveryCanBeWithdrawnAndStoppedOnesRecovered() throws {
        let withdrawable = try ["preparing", "review", "queued", "failed", "waiting-route"].map {
            try message(0, state: $0)
        }
        XCTAssertTrue(withdrawable.allSatisfy(\.isWithdrawable))
        let delivering = try ["dispatching", "sent", "cancelled", "unknown"].map { try message(0, state: $0) }
        XCTAssertFalse(delivering.contains(where: \.isWithdrawable))
        XCTAssertEqual(
            try ["preparing", "review", "queued", "failed", "waiting-route", "unknown", "sent"]
                .filter { try message(0, state: $0).needsRecovery },
            ["failed", "waiting-route", "unknown"])
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

final class AnimationTimingTests: XCTestCase {
    func testTimingReportsDriverGapsAndWorkSeparately() {
        var timing = AnimationTiming(at: 10)
        timing.record(startedAt: 10.010, finishedAt: 10.012)
        timing.record(startedAt: 10.026, finishedAt: 10.029)
        timing.record(startedAt: 10.090, finishedAt: 10.091)
        let result = timing.summary(at: 10.100, outcome: "interrupted")
        XCTAssertEqual(result.outcome, "interrupted")
        XCTAssertEqual(result.elapsedMs, 100, accuracy: 0.001)
        XCTAssertEqual(result.callbacks, 3)
        XCTAssertEqual(result.firstCallbackMs ?? -1, 10, accuracy: 0.001)
        XCTAssertEqual(result.gapP50Ms, 16, accuracy: 0.001)
        XCTAssertEqual(result.gapP95Ms, 64, accuracy: 0.001)
        XCTAssertEqual(result.gapMaxMs, 64, accuracy: 0.001)
        XCTAssertEqual(result.gapsOver50Ms, 1)
        XCTAssertEqual(result.workTotalMs, 6, accuracy: 0.001)
        XCTAssertEqual(result.workMaxMs, 3, accuracy: 0.001)
    }

    func testEmptyAndSingleCallbackTransitionsHaveNoInventedGaps() {
        var timing = AnimationTiming(at: 1)
        let empty = timing.summary(at: 1.1, outcome: "interrupted")
        XCTAssertEqual(empty.callbacks, 0)
        XCTAssertNil(empty.firstCallbackMs)
        XCTAssertEqual(empty.gapMaxMs, 0)
        timing.record(startedAt: 1.05, finishedAt: 1.05)
        let single = timing.summary(at: 1.1, outcome: "completed")
        XCTAssertEqual(single.callbacks, 1)
        XCTAssertEqual(single.gapP95Ms, 0)
        XCTAssertEqual(single.workTotalMs, 0)
    }
}

@MainActor
final class EdgePanelControllerTests: XCTestCase {
    private func controller() throws -> EdgePanelController<Color> {
        _ = NSApplication.shared
        let screen = try XCTUnwrap(NSScreen.screens.first)
        let value = EdgePanelController(
            placement: .right, screen: screen, compactSize: CGSize(width: 40, height: 100),
            expandedSize: CGSize(width: 340, height: 400), title: "Hidden animation test") { Color.black }
        value.panel.alphaValue = 0
        value.panel.level = NSWindow.Level(rawValue: -1000)
        return value
    }

    func testTopNotchReceivesPointerAboveTheMenuBarWithoutRaisingSidePanels() throws {
        _ = NSApplication.shared
        let screen = try XCTUnwrap(NSScreen.screens.first)
        for placement in [EdgePanelPlacement.top, .left, .right] {
            let value = EdgePanelController(
                placement: placement, screen: screen, compactSize: CGSize(width: 360, height: 36),
                expandedSize: CGSize(width: 432, height: 600), title: "Hidden layering test") { Color.black }
            defer { value.panel.close() }
            if placement == .top {
                XCTAssertGreaterThan(value.panel.level.rawValue, NSWindow.Level.mainMenu.rawValue,
                    "The menu bar otherwise intercepts the notch's agent buttons on displays without a camera cutout")
            } else {
                XCTAssertLessThan(value.panel.level.rawValue, NSWindow.Level.mainMenu.rawValue,
                    "Side widgets must not cover system menus")
            }
        }
    }

    func testReduceMotionAndHiddenPanelReachTheExactTargetWithoutCallbacks() throws {
        let value = try controller()
        defer { value.hide(); value.panel.close() }
        value.setPresentation(.expanded, reduceMotion: false)
        XCTAssertEqual(value.panel.frame.size, CGSize(width: 340, height: 400))
        XCTAssertNil(value.lastTransitionTiming)
        // Visible now, so only Reduce Motion keeps this change from animating.
        value.show()
        value.setPresentation(.compact, reduceMotion: true)
        XCTAssertEqual(value.panel.frame.size, CGSize(width: 40, height: 100))
        XCTAssertNil(value.lastTransitionTiming)
    }

    func testInterruptedOpenCloseReopenEndsAtItsLatestAnchor() async throws {
        let value = try controller()
        defer { value.hide(); value.panel.close() }
        value.show()
        value.setPresentation(.preview, reduceMotion: false)
        try await Task.sleep(for: .milliseconds(60))
        value.setPresentation(.compact, reduceMotion: false)
        XCTAssertEqual(value.lastTransitionTiming?.outcome, "interrupted")
        try await Task.sleep(for: .milliseconds(60))
        value.setPresentation(.expanded, reduceMotion: false)
        try await Task.sleep(for: .milliseconds(500))
        XCTAssertEqual(value.panel.frame.size, CGSize(width: 340, height: 400))
        XCTAssertEqual(value.panel.frame.maxX, try XCTUnwrap(NSScreen.screens.first).frame.maxX, accuracy: 0.5)
        XCTAssertEqual(value.lastTransitionTiming?.outcome, "completed")
        XCTAssertGreaterThan(value.lastTransitionTiming?.callbacks ?? 0, 1)
        let final = value.panel.frame
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(value.panel.frame, final, "A cancelled transition must not move the latest target")
    }

    func testFixedWidthContentCannotPushAnAnimatingPanelOffItsAnchor() async throws {
        _ = NSApplication.shared
        let screen = try XCTUnwrap(NSScreen.screens.first)
        let screenFrame = screen.frame
        for placement in [EdgePanelPlacement.right, .top] {
            let state = EdgeSizingFixtureState()
            let value = EdgePanelController(
                placement: placement, screen: screen, compactSize: CGSize(width: 40, height: 36),
                expandedSize: CGSize(width: 400, height: 300), title: "Hidden sizing test"
            ) { EdgeSizingFixtureContent(state: state) }
            value.panel.alphaValue = 0
            value.panel.level = NSWindow.Level(rawValue: -1000)
            var errors: [CGFloat] = []
            let observer = NotificationCenter.default.addObserver(
                forName: NSWindow.didResizeNotification, object: value.panel, queue: .main
            ) { _ in
                MainActor.assumeIsolated {
                    let frame = value.panel.frame
                    let error = placement == .right
                        ? abs(frame.maxX - screenFrame.maxX)
                        : max(abs(frame.maxY - screenFrame.maxY), abs(frame.midX - screenFrame.midX))
                    errors.append(error)
                }
            }
            defer {
                NotificationCenter.default.removeObserver(observer)
                value.hide()
                value.panel.close()
            }
            value.show()
            state.expanded = true
            value.setPresentation(.expanded, reduceMotion: false)
            try await Task.sleep(for: .milliseconds(60))
            state.expanded = false
            value.setPresentation(.compact, reduceMotion: false)
            try await Task.sleep(for: .milliseconds(60))
            state.expanded = true
            value.setPresentation(.expanded, reduceMotion: false)
            try await Task.sleep(for: .milliseconds(500))
            XCTAssertGreaterThan(errors.count, 1)
            XCTAssertLessThanOrEqual(errors.max() ?? .infinity, 0.5, "Hosting constraints must not resize the native frame")
            XCTAssertEqual(value.panel.frame.size, CGSize(width: 400, height: 300))
        }
    }

    func testHideCancelsItsTransitionBeforeAHiddenRetarget() async throws {
        let value = try controller()
        defer { value.hide(); value.panel.close() }
        value.show()
        value.setPresentation(.preview, reduceMotion: false)
        try await Task.sleep(for: .milliseconds(40))
        value.hide()
        XCTAssertFalse(value.panel.isVisible)
        XCTAssertEqual(value.lastTransitionTiming?.outcome, "interrupted")
        value.setPresentation(.compact, reduceMotion: false)
        let target = value.panel.frame
        try await Task.sleep(for: .milliseconds(350))
        XCTAssertEqual(value.panel.frame, target)
        XCTAssertEqual(target.size, CGSize(width: 40, height: 100))
    }
}

@MainActor
private final class EdgeSizingFixtureState: ObservableObject {
    @Published var expanded = false
}

private struct EdgeSizingFixtureContent: View {
    @ObservedObject var state: EdgeSizingFixtureState
    var body: some View {
        Color.black.frame(width: state.expanded ? 400 : 40, height: state.expanded ? 300 : 36)
    }
}

private actor WidgetHoverTranscriptProbe {
    private(set) var identities: [String] = []
    func load(_ query: SessionTranscriptCache.Query) -> TranscriptEnvelope {
        identities.append(query.identity)
        return TranscriptEnvelope(provider: query.provider, sessionId: query.identity, filePath: query.query,
            byteSize: 1, truncated: false, nextOffset: 0, turns: [])
    }
}

@MainActor
final class WidgetRosterTests: XCTestCase {
    private func fixtureSessions() -> [WidgetSession] {
        let statuses = ["waiting", "working", "finished", "recent", "idle", "unknown"]
        return (0..<757).map { index in
            WidgetSession(
                key: "fixture-\(index)",
                target: WidgetTarget(hostId: "local", provider: "codex", sessionId: "fixture-\(index)",
                                     sourceHome: "/fixture/home", cwd: "/fixture/project-\(index % 9)"),
                title: "Fixture session \(index)", project: "Project \(index % 9)",
                activityAt: 1_791_417_600_000 + Double(index / 9) * 1000,
                status: statuses[index % statuses.count], pinned: index % 5 == 0,
                visible: index % 7 != 0, hiddenByFilter: index % 7 == 0,
                parentSessionId: nil, agentId: nil, transcriptPath: nil)
        }
    }

    private func referencePreview(_ sessions: [WidgetSession]) -> [WidgetSession] {
        let rank = ["waiting": 0, "working": 1, "finished": 2, "recent": 3]
        return Array(sessions.filter(\.visible).sorted {
            let lhs = rank[$0.status] ?? 4
            let rhs = rank[$1.status] ?? 4
            return lhs == rhs ? $0.activityAt > $1.activityAt : lhs < rhs
        }.prefix(4))
    }

    private func withFixture(
        sessionCount: Int? = nil, sideStyle: String = "modular", transcriptCache: SessionTranscriptCache? = nil,
        _ body: (WidgetModel, URL, WidgetSnapshot) async throws -> Void
    ) async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("widget-roster-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer {
            do { try FileManager.default.removeItem(at: directory) } catch { XCTFail("Fixture cleanup: \(error)") }
        }
        let data = Data("""
        {"version":1,"state":{"version":1,"revision":0,"preferences":{"excludedKeys":[],"projects":[],"sessions":[],"showChanges":true,"placement":"both","side":"right","quietSeconds":15,"voiceProvider":"xai","voiceLanguage":""},"assets":{},"drafts":{},"outgoing":[]},"sessions":[],"cards":[],"manifests":{},"errors":[]}
        """.utf8)
        var snapshot = try JSONDecoder().decode(WidgetSnapshot.self, from: data)
        snapshot.sessions = sessionCount.map { Array(fixtureSessions().prefix($0)).map { session in
            var visible = session
            visible.visible = true
            return visible
        } } ?? fixtureSessions()
        snapshot.state.preferences.sideStyle = sideStyle
        let snapshotFile = directory.appendingPathComponent("snapshot.json")
        try JSONEncoder().encode(snapshot).write(to: snapshotFile, options: .atomic)
        let binary = directory.appendingPathComponent("tools")
        try "#!/bin/sh\ncat '\(snapshotFile.path)'\n".write(to: binary, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: binary.path)
        let domain = "widget-roster-tests." + UUID().uuidString
        let defaults = UserDefaults(suiteName: domain)!
        defer { defaults.removePersistentDomain(forName: domain) }
        let model = WidgetModel(
            binaryPath: binary.path, stateRoot: directory.path, defaults: defaults,
            appearance: NativeSettingsAppearance(defaults: defaults, notificationNamespace: domain, observeExternalChanges: false),
            transcriptCache: transcriptCache)
        defer { model.stop() }
        model.startSettings()
        let deadline = ContinuousClock.now + .seconds(5)
        while model.snapshot == nil && ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(100))
        }
        XCTAssertNotNil(model.snapshot)
        try await body(model, snapshotFile, snapshot)
    }

    func testHoverWarmsThePointedAgentWithoutChangingTheSelectedConversation() async throws {
        for edge in [EdgePanelPlacement.right, .top] {
            let probe = WidgetHoverTranscriptProbe()
            let cache = SessionTranscriptCache { await probe.load($0) }
            try await withFixture(sessionCount: 2, transcriptCache: cache) { model, _, original in
                let selected = original.sessions[0].key
                let pointed = original.sessions[1]
                let surface = WidgetSurfaceID(edge: edge)
                model.selectedKey = selected
                model.hover(surface, inside: true)
                model.hoverSession(pointed.key, on: surface, inside: true)
                let deadline = ContinuousClock.now + .seconds(2)
                while await probe.identities.isEmpty, ContinuousClock.now < deadline {
                    try await Task.sleep(for: .milliseconds(100))
                }
                let hovered = await probe.identities
                XCTAssertEqual(hovered, [pointed.key], "Hover must not warm the previously selected agent")
                model.hoverSession(pointed.key, on: surface, inside: false)
                model.hover(surface, inside: true)
                try await Task.sleep(for: .milliseconds(250))
                let afterReflow = await probe.identities
                XCTAssertEqual(afterReflow, [pointed.key], "Preview expansion must not switch a stationary pointer's preload back to the selected session")
                XCTAssertEqual(model.selectedKey, selected, "Pointer movement must not change the reply destination")
                _ = try await cache.value(for: .init(identity: pointed.key, query: pointed.target.sessionId, provider: "codex"))
                let opened = await probe.identities
                XCTAssertEqual(opened, [pointed.key], "Opening must reuse the hovered agent's load")
                model.hoverSession(pointed.key, on: surface, inside: false)
                model.hover(surface, inside: false)
                try await Task.sleep(for: .milliseconds(250))
                model.hover(surface, inside: true)
                try await Task.sleep(for: .milliseconds(250))
                let afterLeaving = await probe.identities
                XCTAssertEqual(afterLeaving, [pointed.key, selected], "Reentering the surface must not retain an old agent target")
            }
        }
    }

    func testSessionSwitchWaitsForItsMatchingInboxBeforeClaimingItIsEmpty() async throws {
        try await withFixture(sessionCount: 2) { model, _, original in
            var snapshot = original
            let first = snapshot.sessions[0].key
            let second = snapshot.sessions[1].key
            model.selectedKey = first
            snapshot.selectedKey = first
            model.receive([String(decoding: try JSONEncoder().encode(snapshot), as: UTF8.self)])
            XCTAssertFalse(model.inboxLoading, "An empty response for this session is a real empty inbox")

            model.select(second)
            XCTAssertTrue(model.inboxLoading, "The previous session's empty list says nothing about the new session")
            model.receive([String(decoding: try JSONEncoder().encode(snapshot), as: UTF8.self)])
            XCTAssertTrue(model.inboxLoading, "An in-flight old response must not show an empty result")

            snapshot.selectedKey = second
            model.receive([String(decoding: try JSONEncoder().encode(snapshot), as: UTF8.self)])
            XCTAssertFalse(model.inboxLoading, "The matching response ends the loading state even when empty")
            model.select(first)
            XCTAssertTrue(model.inboxLoading)
            model.error = "Fixture source failure"
            XCTAssertFalse(model.inboxLoading, "A failed request must leave an actionable error rather than an endless spinner")
        }
    }

    func testConversationStartsAtRecentMessagesAndKeepsOlderReadingPosition() async throws {
        guard #available(macOS 15, *) else { throw XCTSkip("Role-specific scroll anchors require macOS 15") }
        _ = NSApplication.shared
        try await withFixture(sessionCount: 1) { model, _, original in
            model.selectedKey = original.sessions[0].key
            model.section = "Conversation"
            func turn(_ index: Int) -> TranscriptTurn {
                TranscriptTurn(id: "turn-\(index)", role: "assistant",
                    at: ISO8601DateFormatter().string(from: Date(timeIntervalSince1970: 1_700_000_000 + Double(index))),
                    text: String(repeating: "Message \(index) fixture content. ", count: 30))
            }
            model.transcript = (0..<12).map(turn)
            let host = NSHostingView(rootView: LiveWidgetView(model: model, edge: .right, embedded: true))
            host.sizingOptions = []
            let window = NSWindow(contentRect: CGRect(x: -10000, y: -10000, width: 432, height: 600),
                styleMask: [.borderless], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            window.alphaValue = 0
            window.ignoresMouseEvents = true
            defer { window.close() }
            window.contentView = host
            window.orderBack(nil)
            host.layoutSubtreeIfNeeded()
            func scrollViews(_ view: NSView) -> [NSScrollView] {
                if let scroll = view as? NSScrollView { return [scroll] }
                return view.subviews.flatMap(scrollViews)
            }
            let scroll = try XCTUnwrap(scrollViews(host).first)
            let document = try XCTUnwrap(scroll.documentView)
            func settleAtEnd() async throws {
                let deadline = ContinuousClock.now + .seconds(2)
                repeat {
                    try await Task.sleep(for: .milliseconds(100))
                    host.layoutSubtreeIfNeeded()
                } while abs(scroll.contentView.bounds.maxY - document.bounds.maxY) > 2 && ContinuousClock.now < deadline
            }
            try await settleAtEnd()
            XCTAssertGreaterThan(scroll.contentView.bounds.minY, 0, "Conversation must open on recent messages")
            XCTAssertEqual(scroll.contentView.bounds.maxY, document.bounds.maxY, accuracy: 2)
            model.transcript.append(turn(12))
            try await settleAtEnd()
            XCTAssertEqual(scroll.contentView.bounds.maxY, document.bounds.maxY, accuracy: 2,
                "A reader at the end follows a newly arrived message")

            scroll.contentView.scroll(to: NSPoint(x: 0, y: 120))
            scroll.reflectScrolledClipView(scroll.contentView)
            try await Task.sleep(for: .milliseconds(100))
            host.layoutSubtreeIfNeeded()
            let readingY = scroll.contentView.bounds.minY
            XCTAssertLessThan(readingY, document.bounds.height / 2)
            model.transcript.append(turn(13))
            try await Task.sleep(for: .milliseconds(200))
            host.layoutSubtreeIfNeeded()
            XCTAssertEqual(scroll.contentView.bounds.minY, readingY, accuracy: 2,
                "An arriving message must not pull the reader away from older history")
        }
    }

    func testNewOutgoingMessageScrollsItsReceiptIntoTheViewport() async throws {
        _ = NSApplication.shared
        try await withFixture(sessionCount: 1) { model, _, original in
            var snapshot = original
            let session = try XCTUnwrap(snapshot.sessions.first)
            model.selectedKey = session.key
            model.section = "Inbox"
            func message(_ index: Int) -> WidgetOutgoing {
                WidgetOutgoing(id: "receipt-\(index)", target: session.target,
                    payload: ["kind": "followup", "text": .string(String(repeating: "Fixture message \(index). ", count: 30))],
                    assetIds: [], createdAt: Double(index), sequence: index, state: "sent")
            }
            snapshot.state.outgoing = (0..<8).map(message)
            model.receive([String(decoding: try JSONEncoder().encode(snapshot), as: UTF8.self)])
            let host = NSHostingView(rootView: LiveWidgetView(model: model, edge: .right, embedded: true))
            host.sizingOptions = []
            let window = NSWindow(contentRect: CGRect(x: -10000, y: -10000, width: 432, height: 600),
                styleMask: [.borderless], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            window.alphaValue = 0
            window.ignoresMouseEvents = true
            defer { window.close() }
            window.contentView = host
            window.orderBack(nil)
            host.layoutSubtreeIfNeeded()
            func scrollViews(_ view: NSView) -> [NSScrollView] {
                if let scroll = view as? NSScrollView { return [scroll] }
                return view.subviews.flatMap(scrollViews)
            }
            let scroll = try XCTUnwrap(scrollViews(host).first)
            let document = try XCTUnwrap(scroll.documentView)
            XCTAssertGreaterThan(document.bounds.height, scroll.contentView.bounds.height * 2)
            XCTAssertEqual(scroll.contentView.bounds.minY, 0, accuracy: 1)
            snapshot.state.outgoing.append(message(8))
            model.receive([String(decoding: try JSONEncoder().encode(snapshot), as: UTF8.self)])
            let deadline = ContinuousClock.now + .seconds(2)
            while abs(scroll.contentView.bounds.maxY - document.bounds.maxY) > 2 && ContinuousClock.now < deadline {
                try await Task.sleep(for: .milliseconds(100))
                host.layoutSubtreeIfNeeded()
            }
            XCTAssertGreaterThan(scroll.contentView.bounds.minY, 0, "Sending must reveal the new receipt below the history")
            XCTAssertEqual(scroll.contentView.bounds.maxY, document.bounds.maxY, accuracy: 2,
                "The new receipt must be inside the real native scrolling viewport")
        }
    }

    func testCompactSideHeightMatchesRealHostingLayoutForEachStyleAndSessionCount() async throws {
        _ = NSApplication.shared
        let groups = [[], ["shelf"], ["agents"], ["agents", "capture", "shelf", "tasks"]]
        for style in ["classic", "modular"] {
            for count in [0, 1, 4, 7] {
                try await withFixture(sessionCount: count, sideStyle: style) { model, _, _ in
                    let registry = WidgetModuleRegistry()
                    for id in groups.last! {
                        try registry.register(WidgetModuleDescriptor(
                            id: id, title: id, symbol: "circle", tint: .blue, summary: { "Fixture" }
                        ) { _ in EmptyView() })
                    }
                    for edge in [EdgePanelPlacement.left, .right] {
                        for ids in groups {
                            let metrics = WidgetSideStripMetrics(
                                classic: style == "classic", moduleIDs: ids, visibleSessionCount: model.sessions.count)
                            let root = WidgetHostView(
                                model: model, registry: registry, surface: WidgetSurfaceID(edge: edge),
                                moduleIDs: ids, cutout: 0, headerHeight: 36, visibleHeight: 900)
                            let host = NSHostingView(rootView: root.sideStripContents)
                            let measured = host.fittingSize
                            XCTAssertEqual(measured.width, 44, accuracy: 0.5)
                            XCTAssertEqual(measured.height, metrics.minimumHeight, accuracy: 0.5,
                                "Real SwiftUI layout differs: style=\(style), sessions=\(count), modules=\(ids)")
                            if ids.count == 4 && count >= 4 {
                                XCTAssertEqual(measured.height, style == "classic" ? 288 : 318, accuracy: 0.5)
                            }
                            if ids.isEmpty {
                                XCTAssertEqual(measured.height, style == "classic" ? 100 : 106, accuracy: 0.5)
                            }
                            print("SIDE_LAYOUT style=\(style) edge=\(edge) sessions=\(count) modules=\(ids.count) measured=\(measured.height) allocated=\(metrics.minimumHeight)")
                        }
                    }
                }
            }
        }
    }

    func testRailStaysAtBezelDuringInterruptedAnimation() async throws {
        _ = NSApplication.shared
        let screen = try XCTUnwrap(NSScreen.screens.first)
        for edge in [EdgePanelPlacement.left, .right] {
            try await withFixture(sessionCount: 4, sideStyle: "classic") { model, _, _ in
                let registry = WidgetModuleRegistry()
                try registry.register(WidgetModuleDescriptor(
                    id: "shelf", title: "Shelf", symbol: "tray", tint: .blue, summary: { "Fixture" }
                ) { _ in Color.blue })
                let surface = WidgetSurfaceID(edge: edge)
                let controller = EdgePanelController(
                    placement: edge, screen: screen, compactSize: CGSize(width: 44, height: 180),
                    expandedSize: CGSize(width: 476, height: 480), title: "Hidden rail animation fixture"
                ) {
                    WidgetHostView(model: model, registry: registry, surface: surface, moduleIDs: ["shelf"],
                        cutout: 0, headerHeight: 36, visibleHeight: screen.visibleFrame.height)
                }
                let panel = controller.panel
                panel.alphaValue = 0
                panel.level = NSWindow.Level(rawValue: -1000)
                defer { controller.hide(); panel.close() }
                controller.show()
                func handles(_ view: NSView) -> [ScreenVerticalDragView] {
                    if let handle = view as? ScreenVerticalDragView { return [handle] }
                    return view.subviews.flatMap(handles)
                }
                var sampledFrames: [CGRect] = []
                func sample() throws {
                    let host = try XCTUnwrap(panel.contentView)
                    host.layoutSubtreeIfNeeded()
                    let handle = try XCTUnwrap(handles(host).first)
                    let frame = panel.convertToScreen(handle.convert(handle.bounds, to: nil))
                    sampledFrames.append(frame)
                    let expectedX = edge == .right ? screen.frame.maxX - 42 : screen.frame.minX + 2
                    XCTAssertEqual(frame.minX, expectedX, accuracy: 0.5, "A growing content view moved the rail")
                    XCTAssertTrue(panel.frame.insetBy(dx: -0.5, dy: -0.5).contains(frame), "Handle escaped panel")
                }
                try sample()
                for opening in [true, false, true] {
                    if opening { model.openModule("shelf", on: surface) } else { model.collapse() }
                    controller.setPresentation(opening ? .expanded : .compact, reduceMotion: false)
                    // A bounded animation-frame sampler, not a production polling loop.
                    for _ in 0..<12 {
                        try await Task.sleep(for: .milliseconds(16))
                        try sample()
                    }
                }
                try await Task.sleep(for: .milliseconds(300))
                try sample()
                XCTAssertGreaterThan(sampledFrames.count, 30)
                let xs = sampledFrames.map { $0.minX }
                print("RAIL_FRAME_PROOF edge=\(edge) samples=\(xs.count) x-range=\(xs.max()! - xs.min()!)")
            }
        }
    }

    func testTopBarMeasuresChangingWingsAndReservesCutout() {
        for cutout: CGFloat in [0, 200] {
            for widths: (CGFloat, CGFloat) in [(70, 60), (120, 260)] {
                let host = NSHostingView(rootView: WidgetTopBarLayout(cutout: cutout) {
                    Color.red.frame(width: widths.0, height: 23)
                    Color.blue.frame(width: widths.1, height: 25)
                }.fixedSize())
                let expected = cutout > 0 ? max(widths.0, widths.1) * 2 + cutout + 16 : widths.0 + widths.1 + 16
                XCTAssertEqual(host.fittingSize.width, expected, accuracy: 0.5)
                XCTAssertEqual(host.fittingSize.height, 25, accuracy: 0.5)
            }
        }
    }

    func testScreenDragIgnoresMovingWindowAndEndsOnce() throws {
        _ = NSApplication.shared
        let view = ScreenVerticalDragView(frame: CGRect(x: 0, y: 0, width: 40, height: 21))
        let window = NSWindow(contentRect: CGRect(x: -10000, y: -10000, width: 44, height: 180),
            styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView?.addSubview(view)
        defer { window.close() }
        var pointer = CGPoint(x: 500, y: 600)
        view.pointer = { pointer }
        var received: [(CGFloat, Bool)] = []
        view.moved = { received.append(($0, $1)) }
        let event = try XCTUnwrap(NSEvent.mouseEvent(with: .leftMouseDown, location: .zero,
            modifierFlags: [], timestamp: 0, windowNumber: window.windowNumber, context: nil,
            eventNumber: 1, clickCount: 1, pressure: 1))
        view.mouseDown(with: event)
        pointer.y -= 120
        window.setFrameOrigin(CGPoint(x: -10000, y: -10120))
        view.mouseDragged(with: event)
        pointer.y += 40
        window.setFrameOrigin(CGPoint(x: -10000, y: -10080))
        view.mouseDragged(with: event)
        view.mouseUp(with: event)
        view.mouseUp(with: event)
        XCTAssertEqual(received.map { $0.0 }, [0, 120, 80, 80])
        XCTAssertEqual(received.map { $0.1 }, [false, false, false, true])
    }

    func testOverflowUsesARealScrollableViewportAndReachesDocumentEnd() async throws {
        _ = NSApplication.shared
        for style in ["classic", "modular"] {
            try await withFixture(sessionCount: 4, sideStyle: style) { model, _, _ in
                let ids = ["agents", "capture", "shelf", "tasks"]
                let registry = WidgetModuleRegistry()
                for id in ids {
                    try registry.register(WidgetModuleDescriptor(
                        id: id, title: id, symbol: "circle", tint: .blue, summary: { "Fixture" }
                    ) { _ in Color.clear })
                }
                for edge in [EdgePanelPlacement.left, .right] {
                    for height: CGFloat in [60, 120, 240] {
                        let surface = WidgetSurfaceID(edge: edge)
                        for expanded in [false, true] {
                            if expanded { model.openModule("shelf", on: surface) } else { model.collapse() }
                            let width: CGFloat = expanded ? 476 : 44
                            let root = WidgetHostView(
                                model: model, registry: registry, surface: surface, moduleIDs: ids,
                                cutout: 0, headerHeight: 36, visibleHeight: height)
                            let host = NSHostingView(rootView: root)
                            host.sizingOptions = []
                            let window = NSWindow(
                                contentRect: CGRect(x: -10000, y: -10000, width: width, height: height),
                                styleMask: [.borderless], backing: .buffered, defer: false)
                            window.isReleasedWhenClosed = false
                            defer { window.close() }
                            window.contentView = host
                            host.layoutSubtreeIfNeeded()
                            @MainActor func scrollViews(_ view: NSView) -> [NSScrollView] {
                                if let scroll = view as? NSScrollView { return [scroll] }
                                return view.subviews.flatMap(scrollViews)
                            }
                            let scroll = try XCTUnwrap(scrollViews(host).first,
                                "An undersized rail must have a native scrolling viewport")
                            let document = try XCTUnwrap(scroll.documentView)
                            XCTAssertLessThanOrEqual(scroll.bounds.height, height + 0.5)
                            XCTAssertGreaterThan(document.bounds.height, scroll.contentView.bounds.height)
                            XCTAssertTrue(host.bounds.insetBy(dx: -0.5, dy: -0.5).contains(host.convert(scroll.bounds, from: scroll)),
                                "Viewport escaped host: style=\(style), edge=\(edge), expanded=\(expanded), height=\(height), host=\(host.bounds), scroll=\(host.convert(scroll.bounds, from: scroll))")
                            if height >= 120 {
                                XCTAssertEqual(scroll.contentView.bounds.height, height - (style == "classic" ? 63 : 67), accuracy: 0.5,
                                    "The scrolling viewport must leave room for fixed settings and drag controls")
                            } else {
                                XCTAssertEqual(scroll.contentView.bounds.height, height, accuracy: 0.5)
                            }
                            document.scroll(CGPoint(x: 0, y: document.bounds.maxY))
                            host.layoutSubtreeIfNeeded()
                            XCTAssertEqual(scroll.contentView.bounds.maxY, document.bounds.maxY, accuracy: 0.5,
                                "Scrolling must reach the final control rather than clipping the document")
                            document.scroll(.zero)
                            host.layoutSubtreeIfNeeded()
                            XCTAssertEqual(scroll.contentView.bounds.minY, 0, accuracy: 0.5,
                                "The initial module must remain reachable after returning to the top")
                            XCTAssertFalse(window.isVisible, "The regression must never show a desktop window")
                            print("SIDE_OVERFLOW style=\(style) edge=\(edge) expanded=\(expanded) height=\(height) viewport=\(scroll.contentView.bounds.height) document=\(document.bounds.height)")
                        }
                    }
                }
            }
        }
    }

    func testInboxPrefetchIsReusedAndLeavingConversationStopsTail() async throws {
        try await withFixture { model, snapshotFile, _ in
            let directory = snapshotFile.deletingLastPathComponent()
            let calls = directory.appendingPathComponent("calls.txt")
            try Data().write(to: calls)
            let tailPID = directory.appendingPathComponent("tail.pid")
            let binary = directory.appendingPathComponent("tools")
            let script = """
            #!/bin/sh
            printf '%s\\n' "$*" >> '\(calls.path)'
            if [ "$1" = "ai" ]; then
                case " $* " in
                    *' --live '*) printf '%s' "$$" > '\(tailPID.path)'; exec /bin/sleep 30 ;;
                esac
                printf '%s\\n' '{"provider":"codex","sessionId":"fixture-0","filePath":"/fixture/session.jsonl","byteSize":1,"truncated":false,"nextOffset":1,"turns":[{"id":"fixture-turn","role":"user","text":"Fixture conversation","tools":[]}]}'
            else
                cat '\(snapshotFile.path)'
            fi
            """
            try script.write(to: binary, atomically: true, encoding: .utf8)
            try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: binary.path)
            model.select("fixture-0")
            model.open(.top)
            let preloadDeadline = ContinuousClock.now + .seconds(3)
            var inboxCalls = ""
            repeat {
                try await Task.sleep(for: .milliseconds(100))
                inboxCalls = try String(contentsOf: calls, encoding: .utf8)
            } while !inboxCalls.contains("ai sessions tail") && ContinuousClock.now < preloadDeadline
            XCTAssertEqual(inboxCalls.components(separatedBy: "ai sessions tail").count - 1, 1,
                "Opening Inbox must prepare one bounded transcript load; calls: \(inboxCalls)")
            XCTAssertFalse(FileManager.default.fileExists(atPath: tailPID.path), "Inbox must not start a live follow process")
            XCTAssertFalse(model.transcriptLoading)
            model.section = "Conversation"
            let deadline = ContinuousClock.now + .seconds(5)
            while (!FileManager.default.fileExists(atPath: tailPID.path) || model.transcript.isEmpty)
                && ContinuousClock.now < deadline {
                try await Task.sleep(for: .milliseconds(100))
            }
            XCTAssertEqual(model.transcript.first?.text, "Fixture conversation")
            let allCalls = try String(contentsOf: calls, encoding: .utf8)
            let initialLoads = allCalls.components(separatedBy: "\n").filter { $0.contains("ai sessions tail") && !$0.contains(" --live ") }
            XCTAssertEqual(initialLoads.count, 1, "Conversation must reuse the initial preload; calls: \(allCalls)")
            let pidText = try String(contentsOf: tailPID, encoding: .utf8)
            let pid = try XCTUnwrap(Int32(pidText))
            XCTAssertEqual(kill(pid, 0), 0, "The live follow process must have started")
            model.section = "Inbox"
            XCTAssertTrue(model.transcript.isEmpty)
            XCTAssertFalse(model.transcriptLoading)
            let exitDeadline = ContinuousClock.now + .seconds(5)
            while kill(pid, 0) == 0 && ContinuousClock.now < exitDeadline {
                try await Task.sleep(for: .milliseconds(100))
            }
            XCTAssertNotEqual(kill(pid, 0), 0, "Leaving Conversation must terminate its live tail")
        }
    }

    func testVisibleRosterAndRankedPreviewMatchTheOriginalComparator() async throws {
        try await withFixture { model, _, snapshot in
            XCTAssertEqual(model.sessions, snapshot.sessions.filter(\.visible))
            XCTAssertEqual(model.previewSessions, referencePreview(snapshot.sessions))
            XCTAssertEqual(model.previewHeight, 316)
            XCTAssertEqual(model.previewSessions.map(\.key), ["fixture-750", "fixture-738", "fixture-744", "fixture-732"])
        }
    }

    func testProjectionRefreshesContentVisibilityRankingAndSourceOrderTies() {
        var sessions = fixtureSessions()
        var roster = WidgetSessionRoster()
        XCTAssertTrue(roster.update(sessions))
        XCTAssertFalse(roster.update(sessions), "Identical session data must reuse the projection")
        XCTAssertEqual(roster.visible, sessions.filter(\.visible))
        XCTAssertEqual(roster.preview, referencePreview(sessions))
        XCTAssertEqual(roster.waiting, 108)

        sessions[750].title = "Updated title with unchanged identity"
        XCTAssertTrue(roster.update(sessions))
        XCTAssertEqual(roster.preview.first?.title, sessions[750].title)
        sessions[750].visible = false
        sessions[738].status = "working"
        sessions[12].activityAt = 2_000_000_000_000
        XCTAssertTrue(roster.update(sessions))
        XCTAssertEqual(roster.visible, sessions.filter(\.visible))
        XCTAssertEqual(roster.preview, referencePreview(sessions))
        XCTAssertEqual(roster.waiting, sessions.filter { $0.visible && $0.status == "waiting" }.count)
        sessions.reverse()
        XCTAssertTrue(roster.update(sessions))
        XCTAssertEqual(roster.preview, referencePreview(sessions), "Equal rank/date rows keep incoming source order")
        XCTAssertTrue(roster.update([]))
        XCTAssertTrue(roster.visible.isEmpty)
        XCTAssertTrue(roster.preview.isEmpty)
        XCTAssertEqual(roster.waiting, 0)
    }

    func testRailKeepsTargetsInPlaceAcrossActivityAndStatusRefreshes() {
        var sessions = Array(fixtureSessions().filter(\.visible).prefix(8))
        var roster = WidgetSessionRoster()
        roster.update(sessions)
        let original = roster.rail.map(\.key)
        sessions.reverse()
        sessions[0].status = "working"
        sessions[0].activityAt += 1_000_000
        sessions[1].status = "waiting"
        sessions[1].title = "Updated in place"
        roster.update(sessions)
        XCTAssertEqual(roster.rail.map(\.key), original, "A pointer target must not move when an agent becomes active")
        XCTAssertEqual(roster.rail.first(where: { $0.key == sessions[1].key })?.title, "Updated in place")
        let removed = sessions.removeFirst().key
        roster.update(sessions)
        XCTAssertEqual(roster.rail.map(\.key), original.filter { $0 != removed })
        var fresh = sessions[0]
        fresh.key = "new-arrival"
        fresh.activityAt += 2_000_000
        sessions.insert(fresh, at: 0)
        roster.update(sessions)
        XCTAssertEqual(roster.rail.last?.key, "new-arrival", "An incoming session cannot steal a hovered dot")
    }

    func testRosterReadBenchmark() async throws {
        guard ProcessInfo.processInfo.environment["WIDGET_ROSTER_BENCH"] == "1" else {
            throw XCTSkip("Run with WIDGET_ROSTER_BENCH=1 for the bounded 757-session projection benchmark")
        }
        try await withFixture { model, _, _ in
            func cpu() -> Double {
                var usage = rusage()
                getrusage(RUSAGE_SELF, &usage)
                return Double(usage.ru_utime.tv_sec + usage.ru_stime.tv_sec)
                    + Double(usage.ru_utime.tv_usec + usage.ru_stime.tv_usec) / 1_000_000
            }
            var checksum = 0
            for repetition in 0..<3 {
                let start = cpu()
                for _ in 0..<200 {
                    checksum += model.sessions.count + model.previewSessions.count + Int(model.previewHeight)
                    checksum += model.waitingSessionCount
                }
                print("ROSTER_BENCH repetition=\(repetition) reads=200 cpu-ms=\((cpu() - start) * 1000) checksum=\(checksum)")
            }
            XCTAssertGreaterThan(checksum, 0)
            let source = try XCTUnwrap(model.snapshot?.sessions)
            let equalCopy = try JSONDecoder().decode([WidgetSession].self, from: JSONEncoder().encode(source))
            var projection = WidgetSessionRoster()
            let buildStart = cpu()
            projection.update(source)
            let buildMs = (cpu() - buildStart) * 1000
            let equalityStart = cpu()
            for _ in 0..<200 { XCTAssertFalse(projection.update(equalCopy)) }
            print("ROSTER_UPDATE build-cpu-ms=\(buildMs) equal-snapshot-200-cpu-ms=\((cpu() - equalityStart) * 1000)")

            if let output = ProcessInfo.processInfo.environment["WIDGET_ROSTER_SNAPSHOT"] {
                _ = NSApplication.shared
                let window = NSPanel(contentRect: CGRect(x: 0, y: 0, width: 324, height: 316),
                                     styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
                window.isReleasedWhenClosed = false
                window.alphaValue = 0
                window.level = NSWindow.Level(rawValue: -1000)
                defer { window.close() }
                let host = NSHostingView(rootView: AgentWidgetPreview(model: model, surface: WidgetSurfaceID(edge: .right))
                    .frame(width: 324, height: 316).background(Color(white: 0.07)).preferredColorScheme(.dark))
                window.contentView = host
                window.order(.below, relativeTo: 0)
                host.layoutSubtreeIfNeeded()
                let bitmap = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
                host.cacheDisplay(in: host.bounds, to: bitmap)
                let png = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
                try png.write(to: URL(fileURLWithPath: output), options: .atomic)
                print("ROSTER_SNAPSHOT \(output)")
            }
        }
    }
}
