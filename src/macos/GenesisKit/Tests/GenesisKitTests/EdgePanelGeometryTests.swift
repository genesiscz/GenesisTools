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
