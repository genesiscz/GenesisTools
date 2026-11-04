import AppKit
import SwiftUI
import XCTest
@testable import GenesisToolsRecorder

/// The timeline driven by real mouse events in an off-screen window: a click lands on what is drawn under the pointer.
@MainActor
final class RecorderTimelineTests: XCTestCase {
    private var folder: URL!
    private var windows: [NSWindow] = []

    override func setUp() async throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("timeline-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDown() async throws {
        for window in windows { window.orderOut(nil) }
        windows.removeAll()
        try? FileManager.default.removeItem(at: folder)
    }

    private func model(clips: [EditProject.Clip]? = nil, zooms: [EditProject.Zoom] = []) -> EditorModel {
        var project = EditProject.whole(video: folder.appendingPathComponent("none.mp4").path, durationUs: 10_000_000,
                                        width: 1920, height: 1080, cursor: nil, recording: nil)
        if let clips { project.clips = clips }
        project.zooms = zooms
        // Its own edit.json: every store watches its file, so a shared one let an earlier model's save land here.
        let own = folder.appendingPathComponent(UUID().uuidString)
        try? FileManager.default.createDirectory(at: own, withIntermediateDirectories: true)
        return EditorModel(project: project, store: ProjectStore(url: own.appendingPathComponent("edit.json")))
    }

    /// The timeline alone in a borderless window, never shown and never key.
    private func host(_ model: EditorModel, width: CGFloat) -> NSWindow {
        let height: CGFloat = 300
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: height), styleMask: [.borderless],
                              backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: TimelineView(model: model, viewportWidth: width)
            .frame(width: width, height: height, alignment: .topLeading))
        window.alphaValue = 0
        window.orderBack(nil)
        window.contentView?.layoutSubtreeIfNeeded()
        windows.append(window)
        pump(0.2)
        return window
    }

    private func pump(_ seconds: TimeInterval) {
        RunLoop.main.run(until: Date().addingTimeInterval(seconds))
    }

    /// A click at a point measured from the window's top left, as the timeline lays itself out.
    private func click(_ window: NSWindow, x: CGFloat, y: CGFloat) {
        let point = NSPoint(x: x, y: window.frame.height - y)
        for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
            let event = NSEvent.mouseEvent(with: type, location: point, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                           windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)
            window.sendEvent(try! XCTUnwrap(event))
            pump(0.03)
        }
        pump(0.15)
    }

    private var zoomLaneY: CGFloat { TimelineView.rulerHeight + 10 + TimelineView.zoomLaneHeight / 2 }

    /// The scale the timeline draws at for a viewport: fitted unless the model sets one.
    private func scale(_ model: EditorModel, width: CGFloat) -> TimelineScale {
        if model.pointsPerSecond > 0 { return TimelineScale(pointsPerSecond: model.pointsPerSecond) }
        let fit = Double(max(200, width - 2 * TimelineScale().inset)) / (Double(model.durationUs) / 1_000_000)
        return TimelineScale(pointsPerSecond: fit)
    }

    func testAClickOnTheZoomLaneStartsTheZoomUnderThePointer() {
        for (width, pointsPerSecond) in [(CGFloat(640), 0.0), (1000, 0), (1440, 0), (900, 120)] {
            let model = model()
            model.pointsPerSecond = pointsPerSecond
            let window = host(model, width: width)
            let scale = scale(model, width: width)
            let x = scale.x(3_000_000)
            click(window, x: x, y: zoomLaneY)
            XCTAssertEqual(model.project.zooms.count, 1, "width \(width): the click adds one zoom, got \(model.project.zooms.map { ($0.startUs, $0.endUs) })")
            guard let zoom = model.project.zooms.first else { continue }
            let drawnAt = scale.x(zoom.startUs)
            XCTAssertEqual(drawnAt, x, accuracy: 1, "width \(width), \(pointsPerSecond) pt/s: the zoom starts at the pointer, not \(drawnAt - x) pt right of it")
        }
    }
}
