import AppKit
import SwiftUI
import XCTest

@testable import GenesisKitBase
@testable import GenesisKit

/// Pictures for a person to look at: written only when `GENESISKIT_SHOTS` names a folder. The tests assert on the
/// bitmap either way.
@MainActor
enum KitShots {
    static var folder: URL? {
        ProcessInfo.processInfo.environment["GENESISKIT_SHOTS"].map { URL(fileURLWithPath: $0, isDirectory: true) }
    }

    /// Hosts `view` off screen, lets it settle and returns its bitmap; writes `<name>.png` when a folder is set.
    static func render(_ view: some View, size: CGSize, name: String, settle: TimeInterval = 0.3) throws
        -> NSBitmapImageRep
    {
        let (window, host) = HostedShot.host(view, size: size)
        defer { window.close() }
        RunLoop.main.run(until: Date().addingTimeInterval(settle))
        let rep = try XCTUnwrap(HostedShot.bitmap(host))
        if let folder {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let url = folder.appendingPathComponent("\(name).png")
            try XCTUnwrap(rep.representation(using: .png, properties: [:])).write(to: url)
            print("shot \(url.path)")
        }
        return rep
    }

    /// The sRGB colour at a point given in view points from the top-left.
    static func color(_ rep: NSBitmapImageRep, at point: CGPoint, viewWidth: CGFloat) -> NSColor? {
        let scale = CGFloat(rep.pixelsWide) / viewWidth
        let x = Int(point.x * scale)
        let y = Int(point.y * scale)
        guard x >= 0, y >= 0, x < rep.pixelsWide, y < rep.pixelsHigh else { return nil }
        return rep.colorAt(x: x, y: y)?.usingColorSpace(.sRGB)
    }

    /// Mean brightness (0...1) of a rectangle in view points.
    static func brightness(_ rep: NSBitmapImageRep, in rect: CGRect, viewWidth: CGFloat) -> Double {
        let scale = CGFloat(rep.pixelsWide) / viewWidth
        var sum = 0.0
        var count = 0.0
        let minX = max(0, Int(rect.minX * scale))
        let maxX = min(rep.pixelsWide, Int(rect.maxX * scale))
        let minY = max(0, Int(rect.minY * scale))
        let maxY = min(rep.pixelsHigh, Int(rect.maxY * scale))
        guard minX < maxX, minY < maxY else { return 0 }
        for y in stride(from: minY, to: maxY, by: 2) {
            for x in stride(from: minX, to: maxX, by: 2) {
                guard let c = rep.colorAt(x: x, y: y)?.usingColorSpace(.sRGB) else { continue }
                sum += Double(c.redComponent + c.greenComponent + c.blueComponent) / 3
                count += 1
            }
        }
        return sum / max(count, 1)
    }
}

@MainActor
final class NativeSettingsRowsTests: XCTestCase {
    // MARK: Slider

    func testTheSliderSnapsToItsStepAndStaysInTheRange() {
        let range = 0.0...2.0
        XCTAssertEqual(NativeSettingsSliderMath.snapped(1.04, in: range, step: 0.25), 1.0, accuracy: 1e-9)
        XCTAssertEqual(NativeSettingsSliderMath.snapped(1.13, in: range, step: 0.25), 1.25, accuracy: 1e-9)
        XCTAssertEqual(NativeSettingsSliderMath.snapped(-3, in: range, step: 0.25), 0)
        XCTAssertEqual(NativeSettingsSliderMath.snapped(9, in: range, step: 0.25), 2)
        XCTAssertEqual(NativeSettingsSliderMath.snapped(1.234, in: range, step: nil), 1.234, accuracy: 1e-9)
        // A step that does not divide the range still reaches the top by clamping.
        XCTAssertEqual(NativeSettingsSliderMath.snapped(10, in: 0...10, step: 3), 9)
        XCTAssertEqual(NativeSettingsSliderMath.fraction(15, in: 10...20), 0.5, accuracy: 1e-9)
        XCTAssertEqual(NativeSettingsSliderMath.fraction(5, in: 5...5), 0)
    }

    func testAnArrowKeyMovesOneStepOrATwentiethOfAContinuousRange() {
        XCTAssertEqual(NativeSettingsSliderMath.nudge(30, by: 1, in: 5...120, step: 5), 35)
        XCTAssertEqual(NativeSettingsSliderMath.nudge(30, by: -10, in: 5...120, step: 5), 5)
        XCTAssertEqual(NativeSettingsSliderMath.nudge(1, by: 1, in: 0...2, step: nil), 1.1, accuracy: 1e-9)
    }

    func testADisabledSliderIsDrawnDimmer() throws {
        let slider = NativeSettingsSlider(
            "Intensity", identifier: "fixture.intensity", value: .constant(1.5), in: 0...2, step: 0.25,
            format: { String(format: "%.2f×", $0) })
        func accessory(_ view: some View) throws -> Double {
            let rep = try KitShots.render(
                view.padding(8).frame(width: 460, height: 56).background(Color.black)
                    .environment(\.colorScheme, .dark),
                size: CGSize(width: 460, height: 56), name: "slider-\(UUID().uuidString.prefix(4))", settle: 0.1)
            return KitShots.brightness(rep, in: CGRect(x: 200, y: 0, width: 260, height: 56), viewWidth: 460)
        }
        let enabled = try accessory(slider)
        let disabled = try accessory(slider.disabled(true))
        XCTAssertGreaterThan(enabled, 0.03, "the slider must draw at all")
        XCTAssertLessThan(disabled, enabled * 0.75, "enabled \(enabled), disabled \(disabled)")
    }

    // MARK: Byte threshold

    func testTheByteFieldStartsInTheLargestUnitTheValueFills() {
        typealias T = NativeSettingsByteThreshold
        XCTAssertEqual(T.bestUnit(for: 10_000_000_000, among: [.mb, .gb]), .gb)
        XCTAssertEqual(T.bestUnit(for: 500_000_000, among: [.mb, .gb]), .mb)
        XCTAssertEqual(T.bestUnit(for: 12, among: [.mb, .gb]), .mb)
        XCTAssertEqual(T.text(10_000_000_000, in: .gb), "10")
        XCTAssertEqual(T.text(1_500_000_000, in: .gb), "1.5")
        XCTAssertEqual(T.text(250_000_000, in: .gb), "0.25")
        XCTAssertEqual(T.text(300_000_000, in: .mb), "300")
    }

    func testTypedBytesAreReadInTheUnitAndClampedToTheRange() {
        typealias T = NativeSettingsByteThreshold
        let range: ClosedRange<Int64> = 100_000_000...500_000_000_000
        XCTAssertEqual(T.parse("2", unit: .gb, range: range), 2_000_000_000)
        XCTAssertEqual(T.parse("1,5", unit: .gb, range: range), 1_500_000_000, "a comma is a decimal point")
        XCTAssertEqual(T.parse(" 750 ", unit: .mb, range: range), 750_000_000)
        XCTAssertEqual(T.parse("2", unit: .mb, range: range), 100_000_000, "below the range clamps up")
        XCTAssertEqual(T.parse("9000", unit: .gb, range: range), 500_000_000_000, "above the range clamps down")
        XCTAssertNil(T.parse("ten", unit: .gb, range: range))
        XCTAssertNil(T.parse("", unit: .gb, range: range))
    }

    // MARK: Path list

    func testPathsShowTheHomeFolderAsATilde() {
        typealias P = NativeSettingsPathList
        XCTAssertEqual(P.display("/Users/alice/Projects/x", home: "/Users/alice"), "~/Projects/x")
        XCTAssertEqual(P.display("/Users/alice", home: "/Users/alice"), "~")
        XCTAssertEqual(P.display("/Users/alicex/y", home: "/Users/alice"), "/Users/alicex/y", "a prefix is not a parent")
        XCTAssertEqual(P.display("/tmp", home: "/Users/alice"), "/tmp")
    }

    func testAPathRowUsesPathLabelForThePath() throws {
        let source = try String(contentsOf: URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/GenesisKit/Settings/NativeSettingsPathList.swift"), encoding: .utf8)
        let start = try XCTUnwrap(source.range(of: "private func row"))
        let end = try XCTUnwrap(source.range(of: "private func choose"))
        let row = String(source[start.lowerBound..<end.lowerBound])
        XCTAssertTrue(row.contains("PathLabel("))
        XCTAssertTrue(row.contains("showIcons: false"))
        XCTAssertFalse(row.contains("Text(verbatim:"))
        XCTAssertTrue(row.contains("arrow.up.forward.square"))
    }

    func testAddingFoldersKeepsTheOrderAndSkipsDuplicates() {
        let merged = NativeSettingsPathList.merging(["/a", "/b"], adding: ["/b/", "/c", "/c", "/a"])
        XCTAssertEqual(merged, ["/a", "/b", "/c"])
        XCTAssertEqual(NativeSettingsPathList.merging([], adding: ["/"]), ["/"])
    }

    // MARK: Channel matrix

    func testAMatrixCellSwitchesOnlyItself() {
        let start: [String: Set<String>] = ["warn": ["banner"]]
        let on = NativeSettingsChannelMatrix.toggling(start, tier: "warn", channel: "sound")
        XCTAssertEqual(on["warn"], ["banner", "sound"])
        let off = NativeSettingsChannelMatrix.toggling(on, tier: "warn", channel: "banner")
        XCTAssertEqual(off["warn"], ["sound"])
        let other = NativeSettingsChannelMatrix.toggling(start, tier: "critical", channel: "voice")
        XCTAssertEqual(other["critical"], ["voice"])
        XCTAssertEqual(other["warn"], ["banner"])
    }

    func testAColumnHeaderTurnsTheChannelOnEverywhereThenOff() {
        let start: [String: Set<String>] = ["warn": ["glow"], "critical": []]
        let on = NativeSettingsChannelMatrix.togglingColumn(start, channel: "glow", tiers: ["warn", "critical"])
        XCTAssertEqual(on["warn"], ["glow"])
        XCTAssertEqual(on["critical"], ["glow"])
        let off = NativeSettingsChannelMatrix.togglingColumn(on, channel: "glow", tiers: ["warn", "critical"])
        XCTAssertEqual(off["warn"], [])
        XCTAssertEqual(off["critical"], [])
    }

    func testATierHeaderFillsItsRowThenEmptiesIt() {
        let start: [String: Set<String>] = ["warn": ["banner"]]
        let full = NativeSettingsChannelMatrix.togglingRow(start, tier: "warn", channels: ["banner", "sound"])
        XCTAssertEqual(full["warn"], ["banner", "sound"])
        let empty = NativeSettingsChannelMatrix.togglingRow(full, tier: "warn", channels: ["banner", "sound"])
        XCTAssertEqual(empty["warn"], [])
    }

    func testAccessibilitySuffixesAreStable() {
        enum Style: Hashable { case vignette, edgeGlow }
        XCTAssertEqual(GenAccessibilityID.suffix(Style.vignette), "vignette")
        XCTAssertEqual(GenAccessibilityID.suffix(Style.edgeGlow), "edgeGlow")
        XCTAssertEqual(GenAccessibilityID.suffix("Main Display"), "main-Display")
        XCTAssertEqual(GenAccessibilityID.suffix(42), "42")
        XCTAssertEqual(GenAccessibilityID.suffix(""), "none")
    }

    // MARK: Review fixes (2026-10-13)

    func testTabbingThroughTheByteFieldWritesNothing() {
        typealias Field = NativeSettingsByteThreshold
        let bytes: Int64 = 1_234_567_890
        let shown = Field.text(bytes, in: .gb)
        XCTAssertEqual(shown, "1.23")
        XCTAssertNil(Field.committed(shown, shown: shown, unit: .gb, range: 0...Int64.max, bytes: bytes),
                     "an untouched field keeps the exact bytes")
        XCTAssertEqual(Field.committed("2", shown: shown, unit: .gb, range: 0...Int64.max, bytes: bytes), 2_000_000_000)
        XCTAssertEqual(Field.committed("abc", shown: shown, unit: .gb, range: 0...Int64.max, bytes: bytes), bytes)
    }

    func testPickingAUnitConvertsUnlessANumberWasTyped() {
        typealias Field = NativeSettingsByteThreshold
        let bytes: Int64 = 10_000_000_000
        let shown = Field.text(bytes, in: .gb)
        XCTAssertEqual(Field.picked(shown, shown: shown, unit: .mb, range: 1...Int64.max, bytes: bytes), bytes)
        XCTAssertEqual(Field.text(bytes, in: .mb), "10000")
        XCTAssertEqual(Field.picked("2", shown: shown, unit: .mb, range: 1...Int64.max, bytes: bytes), 2_000_000)
    }

    func testARangeUpToInt64MaxNeverTraps() {
        XCTAssertEqual(NativeSettingsByteThreshold.parse("99999999", unit: .tb, range: 0...Int64.max), Int64.max)
        XCTAssertEqual(NativeSettingsByteThreshold.parse("-5", unit: .tb, range: Int64.min...Int64.max), -5_000_000_000_000)
        XCTAssertEqual(NativeSettingsByteThreshold.parse("1", unit: .kb, range: 0...Int64.max), 1_000)
    }

    func testAnActionRunsOncePerIdentifierAndOutlivesItsView() async throws {
        let runs = NativeSettingsActionRuns()
        var calls = 0
        let gate = AsyncStream<Void>.makeStream()
        XCTAssertTrue(runs.start("rescan") {
            calls += 1
            for await _ in gate.stream { break }
        })
        XCTAssertFalse(runs.start("rescan") { calls += 1 }, "a second press while it runs starts nothing")
        XCTAssertTrue(runs.isRunning("rescan"))
        gate.continuation.yield()
        for _ in 0..<50 where runs.isRunning("rescan") { try await Task.sleep(nanoseconds: 10_000_000) }
        XCTAssertFalse(runs.isRunning("rescan"))
        XCTAssertEqual(calls, 1)
        struct Broken: LocalizedError { var errorDescription: String? { "The disk is gone." } }
        runs.start("rescan") { throw Broken() }
        for _ in 0..<50 where runs.isRunning("rescan") { try await Task.sleep(nanoseconds: 10_000_000) }
        XCTAssertEqual(runs.failure("rescan"), "The disk is gone.")
    }

    func testTheMatrixShowsAndKeepsTheFallbackOfAnAlertMatrix() {
        let matrix = AlertChannelMatrix(routes: ["critical": ["banner", "sound"]], fallback: ["menu"])
        let shown = NativeSettingsChannelMatrix.materialised(matrix, tiers: ["warn", "critical"])
        XCTAssertEqual(shown, ["warn": ["menu"], "critical": ["banner", "sound"]], "a missing tier shows its fallback")
        let clicked = NativeSettingsChannelMatrix.toggling(shown, tier: "warn", channel: "banner")
        let next = NativeSettingsChannelMatrix.applying(clicked, to: matrix)
        XCTAssertEqual(next.channels(for: "warn"), ["menu", "banner"], "the fallback channel stays on after a click")
        XCTAssertEqual(next.fallback, ["menu"])
    }

    func testATildePathIsTheHomeFolderAndIsNotAddedTwice() {
        let home = "/Users/alice"
        XCTAssertEqual(NativeSettingsPathList.expanded("~/Movies", home: home), "/Users/alice/Movies")
        XCTAssertEqual(NativeSettingsPathList.expanded("~", home: home), home)
        XCTAssertEqual(NativeSettingsPathList.expanded("/tmp/~x", home: home), "/tmp/~x")
        XCTAssertEqual(
            NativeSettingsPathList.merging(["~/Movies"], adding: ["/Users/alice/Movies/", "/Users/alice/Music"], home: home),
            ["~/Movies", "/Users/alice/Music"])
    }

    func testMatrixIdentifiersUseTheKitSpelling() {
        XCTAssertEqual(GenAccessibilityID.suffix("Edge glow"), "edge-glow")
    }

    // MARK: A whole card, as a settings page draws it

    func testEveryNewRowDrawsInASettingsCard() throws {
        let rep = try KitShots.render(SettingsRowsGallery(), size: CGSize(width: 640, height: 980), name: "settings-rows", settle: 0.5)
        // Accent fills on the right half, counted per card: the first card's (slider, segment pill, preview button)
        // and the second card's (matrix cells), so the matrix alone cannot pass for both.
        var top = 0
        var bottom = 0
        let split = rep.pixelsHigh * 2 / 5
        for y in stride(from: 0, to: rep.pixelsHigh, by: 3) {
            for x in stride(from: rep.pixelsWide / 2, to: rep.pixelsWide, by: 3) {
                guard let c = rep.colorAt(x: x, y: y)?.usingColorSpace(.sRGB) else { continue }
                if c.saturationComponent > 0.45, c.brightnessComponent > 0.45 {
                    if y < split { top += 1 } else { bottom += 1 }
                }
            }
        }
        XCTAssertGreaterThan(top, 20, "the first card's accent fills (slider, segment, button) must be drawn")
        XCTAssertGreaterThan(bottom, 20, "the matrix cells must be drawn")
        let text = KitShots.brightness(rep, in: CGRect(x: 30, y: 30, width: 200, height: 900), viewWidth: 640)
        XCTAssertGreaterThan(text, 0.05, "row titles must be drawn")
    }
}

/// Every new settings row on one card, in the dark settings look.
struct SettingsRowsGallery: View {
    enum Style: Hashable { case vignette, transparent, sepia, blur, dim }
    @State private var intensity = 1.0
    @State private var style = Style.vignette
    @State private var target = "all"
    @State private var floor: Int64 = 10_000_000_000
    @State private var paths = ["/Users/Shared", "/tmp/never-here-\(UUID().uuidString.prefix(6))"]
    @State private var matrix: [String: Set<String>] = ["warn": ["banner"], "critical": ["banner", "sound", "glow"]]

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            NativeSettingsCard("Slouch effect", subtitle: "How the screen reacts while you slouch.") {
                NativeSettingsPicker(
                    "Effect style", detail: "The look of the screen while you slouch.", identifier: "shot.style",
                    options: [
                        .init(.vignette, "Vignette", detail: "Darkens the edges of every screen.", symbol: "circle.dashed"),
                        .init(.transparent, "Transparent", detail: "Only the message and the camera bubble.", symbol: "rectangle.dashed"),
                        .init(.sepia, "Sepia", detail: "A warm tint over everything.", symbol: "camera.filters"),
                    ], selection: $style)
                Divider()
                NativeSettingsSlider(
                    "Effect intensity", detail: "How strong the overlay should feel.", identifier: "shot.intensity",
                    value: $intensity, in: 0...2, step: 0.05, ticks: [0, 0.5, 1, 1.5, 2],
                    format: { String(format: "%.2f×", $0) })
                Divider()
                NativeSettingsSegmented(
                    "Overlay target", identifier: "shot.target",
                    options: [.init("all", "All screens", detail: "Every display shows the effect."),
                              .init("main", "Main"), .init("cursor", "With cursor")],
                    selection: $target)
                Divider()
                NativeSettingsActionRow(
                    "Preview effect", detail: "Shows the effect for five seconds.", identifier: "shot.preview",
                    buttonTitle: "Preview", symbol: "play.fill", role: .prominent) {}
            }
            NativeSettingsCard("Alerts") {
                NativeSettingsByteThreshold(
                    "Warn below", detail: "Free space that starts the warning tier.", identifier: "shot.floor",
                    bytes: $floor, range: 100_000_000...500_000_000_000)
                Divider()
                NativeSettingsChannelMatrix(
                    identifier: "shot.matrix",
                    tiers: [.init(id: "warn", title: "Warning", detail: "Under 10 GB", tint: KitPalette.modified),
                            .init(id: "critical", title: "Critical", detail: "Under 1 GB", tint: KitPalette.removed)],
                    channels: [.init(id: "banner", title: "Banner", symbol: "bell.badge"),
                               .init(id: "sound", title: "Sound", symbol: "speaker.wave.2"),
                               .init(id: "voice", title: "Voice", symbol: "waveform"),
                               .init(id: "glow", title: "Edge glow", symbol: "rectangle.inset.filled")],
                    selection: $matrix)
                Divider()
                NativeSettingsPathList("Watched folders", detail: "New big files here show in the radar.", identifier: "shot.paths", paths: $paths)
                Divider()
                NativeSettingsActionRow(
                    "Reset history", identifier: "shot.reset", buttonTitle: "Reset", symbol: "trash", role: .destructive,
                    confirmation: "Delete the free-space history?") {}
            }
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        // Graphite: a test bitmap (`cacheDisplay`) skips the layers Liquid Glass is made of, so a glass card draws
        // nothing at all there; the live window is not affected.
        .background(NativeThemePalette.graphiteBase)
        .environment(\.nativeSettingsTheme, .graphite)
        .environment(\.colorScheme, .dark)
        .preferredColorScheme(.dark)
    }
}
