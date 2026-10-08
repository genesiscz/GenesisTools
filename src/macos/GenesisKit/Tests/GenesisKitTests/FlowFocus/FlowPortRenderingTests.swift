import AppKit
import SwiftUI
import XCTest
@testable import GenesisKit

@MainActor
final class FlowPortRenderingTests: XCTestCase {
    func testRenderThePreservedFeatureSurfaces() throws {
        let env = ProcessInfo.processInfo.environment
        guard let directory = env["FLOW_PORT_SCREENSHOT_DIR"] else { throw XCTSkip("Set FLOW_PORT_SCREENSHOT_DIR for off-screen visual parity") }
        let prefix = env["FLOW_PORT_SCREENSHOT_PREFIX"] ?? "Flow"
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("flow-port-render-\(UUID())")
        let store = try ActivityStore(path: root.appendingPathComponent("activity.db").path)
        let now = ISO8601DateFormatter().date(from: "2026-10-07T09:00:00Z")!
        let start = Int64(now.addingTimeInterval(-7200).timeIntervalSince1970 * 1000)
        let session = try store.startSession(.init(kind: "flow", plannedSec: 1500, startedMs: start,
                                                   state: "done", cycleIndex: 1, tag: "Shared library",
                                                   note: "Preserve the working feature", interruptions: 1))
        try store.endSession(id: session, at: start + 1_500_000, state: .done)
        for (index, app) in [("Editor", "com.example.editor"), ("Documentation", "com.example.browser"),
                             ("Terminal", "com.example.terminal")].enumerated() {
            let durations: [Int64] = [300_000, 500_000, 700_000]
            let offset = durations.prefix(index).reduce(0, +)
            let segment = try store.openSegment(.init(startedMs: start + offset, endedMs: start + offset + durations[index],
                                                      sessionId: session, appBundle: app.1, appName: app.0,
                                                      windowTitle: "Shared feature port", urlHost: index == 1 ? "example.com" : nil,
                                                      project: "Shared library"))
            try store.appendInput(bucketMs: start + offset, segmentId: segment,
                                  counts: .init(keys: 80 + index * 20, clicks: 12, scrolls: 8, px: 120))
        }
        let model = FocusStudioModel(store: store)
        model.range = FocusRange.make(.day, containing: now)
        model.reload(now: now)
        for tab in FocusStudioModel.Tab.allCases {
            model.tab = tab
            try render(FocusStudioView(model: model), width: 1080, height: 760,
                       to: URL(fileURLWithPath: directory).appendingPathComponent("\(prefix)-FocusStudio-\(tab.rawValue).png"))
        }
        let detail = FocusSessionDetailModel(store: store, sessionId: session)
        detail.reload(now: now)
        try render(FocusSessionDetailView(model: detail), width: 920, height: 800,
                   to: URL(fileURLWithPath: directory).appendingPathComponent("\(prefix)-FocusSession.png"))
        let engine = PomodoroEngine(store: store)
        engine.start(.flow, seconds: 1500, tag: "Shared library")
        defer { engine.stop() }
        let recorder = ActivityRecorder(store: store)
        try render(FocusHUDView(engine: engine, recorder: recorder), width: 340, height: 420,
                   to: URL(fileURLWithPath: directory).appendingPathComponent("\(prefix)-FocusHUD.png"))
        try render(FlowHistoryHeader(search: .constant("")).background(Color.settingsBackground),
                   width: 700, height: 100,
                   to: URL(fileURLWithPath: directory).appendingPathComponent("\(prefix)-DictationHeader.png"))
    }

    private func render<V: View>(_ view: V, width: CGFloat, height: CGFloat, to url: URL) throws {
        let host = NSHostingView(rootView: view.environment(\.colorScheme, .dark))
        host.frame = NSRect(x: 0, y: 0, width: width, height: height)
        host.layoutSubtreeIfNeeded()
        let bitmap = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        host.cacheDisplay(in: host.bounds, to: bitmap)
        let png = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
        try png.write(to: url)
        XCTAssertGreaterThan(png.count, 10_000, "a blank view is not a rendered surface")
    }
}
