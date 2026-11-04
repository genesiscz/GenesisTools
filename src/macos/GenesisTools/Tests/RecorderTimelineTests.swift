import AppKit
import SwiftUI
import Vision
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
        // A real pointer arrives before it clicks, so a row that turns live under it is live before the press.
        for type in [NSEvent.EventType.mouseMoved, .leftMouseDown, .leftMouseUp] {
            let event = NSEvent.mouseEvent(with: type, location: point, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                           windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)
            window.sendEvent(try! XCTUnwrap(event))
            pump(0.03)
        }
        pump(0.15)
    }

    /// The middle of the first effect lane (the zoom lane), and of the lane `index` lanes below it.
    /// A press, three drag steps and a release, from one x to another at one y.
    private func drag(_ window: NSWindow, fromX: CGFloat, toX: CGFloat, y: CGFloat) {
        let flip = window.frame.height - y
        let steps = [fromX] + (1...3).map { fromX + (toX - fromX) * CGFloat($0) / 3 }
        for (index, x) in steps.enumerated() {
            let type: NSEvent.EventType = index == 0 ? .leftMouseDown : .leftMouseDragged
            let event = NSEvent.mouseEvent(with: type, location: NSPoint(x: x, y: flip), modifierFlags: [],
                                           timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                                           context: nil, eventNumber: 0, clickCount: 1, pressure: 1)
            window.sendEvent(try! XCTUnwrap(event))
            pump(0.03)
        }
        let up = NSEvent.mouseEvent(with: .leftMouseUp, location: NSPoint(x: toX, y: flip), modifierFlags: [],
                                    timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                                    context: nil, eventNumber: 0, clickCount: 1, pressure: 1)
        window.sendEvent(try! XCTUnwrap(up))
        pump(0.2)
    }

    private var zoomLaneY: CGFloat { laneY(0, in: nil) }

    private func laneY(_ index: Int, in model: EditorModel?) -> CGFloat {
        guard let model else { return TimelineView.effectsTop + EffectLaneMetrics.singleRowHeight / 2 }
        let above = model.effectLanes.prefix(index)
        return TimelineView.effectsTop + EffectLaneMetrics.contentHeight(Array(above)) + (index > 0 ? EffectLaneMetrics.laneGap : 0)
            + EffectLaneMetrics.height(rows: model.effectLanes[index].rowCount) / 2
    }

    private func clipLaneY(_ model: EditorModel) -> CGFloat { TimelineLayout(model: model).clipTop + TimelineView.clipLaneHeight / 2 }

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

    func testAClickOnAZoomSelectsItAndDeleteRemovesItWithUndo() {
        let zoom = EditProject.Zoom(id: "z1", startUs: 6_000_000, endUs: 8_000_000, scale: 1.5)
        let model = model(zooms: [zoom])
        model.tab = .clip
        let width: CGFloat = 1000
        let window = host(model, width: width)
        let scale = scale(model, width: width)
        click(window, x: scale.x(7_000_000), y: zoomLaneY)
        XCTAssertEqual(model.selection, .zoom("z1"), "a click on the zoom selects it")
        XCTAssertEqual(model.tab, .zoom, "and opens it in the Zoom panel")
        XCTAssertEqual(model.project.zooms.count, 1, "a click on a zoom never adds another")

        model.deleteSelection()
        XCTAssertTrue(model.project.zooms.isEmpty, "Delete removes the selected zoom")
        model.undo()
        XCTAssertEqual(model.project.zooms.map(\.id), ["z1"], "undo brings it back")
    }

    func testAClickBesideAZoomAddsOneThereInsteadOfSelectingIt() {
        let zoom = EditProject.Zoom(id: "z1", startUs: 6_000_000, endUs: 8_000_000, scale: 1.5)
        let model = model(zooms: [zoom])
        let width: CGFloat = 1000
        let window = host(model, width: width)
        let scale = scale(model, width: width)
        // Where the zoom's hit area sat before the fix: at the lane's start, not where the zoom is drawn.
        click(window, x: scale.x(500_000), y: zoomLaneY)
        XCTAssertNotEqual(model.selection, .zoom("z1"))
        XCTAssertEqual(model.project.zooms.count, 2)
    }

    func testAClickOnTheSecondClipSelectsThatClip() {
        let model = model(clips: [EditProject.Clip(id: "a", fromUs: 0, toUs: 4_000_000), EditProject.Clip(id: "b", fromUs: 4_000_000, toUs: 10_000_000)])
        let width: CGFloat = 1000
        let window = host(model, width: width)
        let scale = scale(model, width: width)
        click(window, x: scale.x(1_000_000), y: clipLaneY(model))
        XCTAssertEqual(model.selection, .clip("a"))
        click(window, x: scale.x(8_000_000), y: clipLaneY(model))
        XCTAssertEqual(model.selection, .clip("b"))
    }

    func testAClickOnAnAddedLaneAddsItsKindThereAndOnThatLane() {
        let model = model()
        model.addLane(kinds: [.hide, .spotlight])
        let lane = model.effectLanes[1].lane
        XCTAssertEqual(lane.kinds, [.hide, .spotlight])
        let width: CGFloat = 1000
        let window = host(model, width: width)
        let scale = scale(model, width: width)
        // Two kinds: a click asks which with a menu, so pick through the model the way the menu does.
        model.addEffect(.hide, fromOut: 2_000_000, toOut: nil, lane: lane.id)
        XCTAssertEqual(model.project.redactions?.first?.lane, lane.id)
        XCTAssertEqual(model.effectLanes[1].items.map(\.kind), [.hide])
        pump(0.2)
        // A click on the hidden part, where its lane draws it, selects it; twice, as the segment turns live under the
        // pointer after the first.
        for _ in 0..<2 {
            model.selection = .none
            click(window, x: scale.x(3_000_000), y: laneY(1, in: model))
            XCTAssertEqual(model.selection, .redaction(model.project.redactions?.first?.id ?? ""))
        }
        XCTAssertEqual(model.tab, .hide)
        model.undo()
        XCTAssertNil(model.project.redactions, "one undo takes the add back, lane and all")
    }

    func testADragOnTheFramesLaneSelectsTheRangeUnderThePointerAndItsActionsEditThere() {
        let model = model()
        let width: CGFloat = 1000
        let window = host(model, width: width)
        let scale = scale(model, width: width)
        drag(window, fromX: scale.x(2_000_000), toX: scale.x(5_000_000), y: clipLaneY(model))
        let range = try? XCTUnwrap(model.timelineRange)
        XCTAssertEqual(Double(range?.fromUs ?? 0), 2_000_000, accuracy: 20_000)
        XCTAssertEqual(Double(range?.toUs ?? 0), 5_000_000, accuracy: 20_000)
        XCTAssertEqual(model.selection, .none, "a drag selects a range, not the clip it started on")

        let exact = TimelineRange(fromUs: 2_000_000, toUs: 5_000_000)
        model.applyRange(.speed, exact, speed: 2)
        XCTAssertNil(model.timelineRange, "an action clears the range")
        XCTAssertEqual(model.project.outputDurationUs, 8_500_000)
        // The zoom over what now plays from 2 s to 3.5 s covers the whole sped-up source part, 2 s to 5 s.
        model.applyRange(.zoom, TimelineRange(fromUs: 2_000_000, toUs: 3_500_000))
        XCTAssertEqual(model.project.zooms.map { [$0.startUs, $0.endUs] }, [[2_000_000, 5_000_000]])
        model.applyRange(.cut, TimelineRange(fromUs: 0, toUs: 1_000_000))
        XCTAssertEqual(model.project.outputDurationUs, 7_500_000)
        model.applyRange(.text, TimelineRange(fromUs: 0, toUs: 500_000))
        XCTAssertEqual(model.project.texts?.first.map { [$0.startUs, $0.endUs] }, [1_000_000, 1_500_000])
    }

    func testTheRangePopoverListsEveryActionWithTheRangesTimes() throws {
        let view = RangeActionsView(model: model(), range: TimelineRange(fromUs: 1_500_000, toUs: 4_000_000))
            .background(Color(white: 0.15)).environment(\.colorScheme, .dark)
        let renderer = ImageRenderer(content: view)
        renderer.scale = 2
        let image = try XCTUnwrap(renderer.cgImage)
        let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])
        try png?.write(to: FileManager.default.temporaryDirectory.appendingPathComponent("recorder-range-popover.png"))
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        try VNImageRequestHandler(cgImage: image).perform([request])
        let text = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: " | ")
        // OCR reads a small "s" as "S" at this size, so the words compare without case.
        for word in ["00:01.5", "00:04.0", "2.5 s", "Cut", "Speed", "Zoom", "Hide a Part", "Spotlight", "Text", "Comment", "Export This Part"] {
            XCTAssertTrue(text.lowercased().contains(word.lowercased()), "\(word) missing from: \(text)")
        }
    }
}
