import AppKit
import SwiftUI
import XCTest
@testable import GenesisKit
import GenesisKitCatalog

/// The component catalog stays complete and drawable. A control added to `Controls/` needs a catalog entry,
/// unless it is a nonvisual helper listed below with its reason.
@MainActor
final class KitCatalogTests: XCTestCase {
    /// Files in `Controls/` that draw nothing of their own.
    static let notDrawn: [String: String] = [
        "AutocompleteFloatingList.swift": "the child window of AutocompleteField; its entry draws the floating list",
        "FailureCapture.swift": "captures a failure's machine facts when it happens",
        "FailureLog.swift": "reads the events and the headline out of a failure's log",
        "FailureNoticePanel.swift": "the window of FailureNoticeView; the failure-inline entry draws the view",
        "FailureReport.swift": "a failure's facts and their text forms",
        "IssueDraft.swift": "an issue draft's text and the command that posts it",
        "FrameProbe.swift": "reports a control's frame to a test",
        "GenRenderSwap.swift": "swaps content when it is ready",
        "GenResize.swift": "the state of a resize drag",
        "KitTextWidth.swift": "measures a label's width for a control that picks its shape",
        "LatestScrollAnchor.swift": "scroll behaviour",
        "MouseClick.swift": "reads the click count of an event",
        "NoticeStackInteraction.swift": "tracks input for NoticeStack without drawing a separate control",
        "NoticeStackLayer.swift": "hosts the catalogued NoticeStack above native content",
        "OverlayScrollViewport.swift": "a container",
        "ScrollViewPositioning.swift": "scroll behaviour",
        "WindowMoveGesture.swift": "a gesture",
        "WrapLayout.swift": "a layout",
    ]

    private static var kitRoot: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    }

    func testEveryControlHasAnEntryOrAReason() throws {
        // The base's controls (GenesisKitBase/Controls) are held to the same rule.
        let folders = ["Sources/GenesisKit/Controls", "Sources/GenesisKitBase/Controls"].map { Self.kitRoot.appendingPathComponent($0) }
        let controls = folders[0]
        // Every level: a control in a folder of its own (Controls/FailureNotice/) is held to the rule too.
        let files = try folders.flatMap { folder in
            try FileManager.default.subpathsOfDirectory(atPath: folder.path).filter { $0.hasSuffix(".swift") }
                .map { ($0 as NSString).lastPathComponent }
        }.sorted()
        XCTAssertGreaterThan(files.count, 20, "the Controls folder was not read: \(controls.path)")
        let catalogued = Set(KitCatalog.entries.flatMap { $0.source.components(separatedBy: " · ") }.map { ($0 as NSString).lastPathComponent })

        for file in files {
            let known = catalogued.contains(file) || Self.notDrawn[file] != nil
            XCTAssertTrue(known, "\(file) has no catalog entry. Add one to KitCatalogEntries.swift, or a line with the reason to KitCatalogTests.")
        }
        for file in Self.notDrawn.keys {
            XCTAssertTrue(files.contains(file), "\(file) is listed here but is not in Controls/ any more: remove its line.")
            XCTAssertFalse(catalogued.contains(file), "\(file) has a catalog entry now: remove its line here.")
        }
        for entry in KitCatalog.entries {
            for source in entry.source.components(separatedBy: " · ") {
                let path = Self.kitRoot.appendingPathComponent("Sources").appendingPathComponent(source).path
                XCTAssertTrue(FileManager.default.fileExists(atPath: path), "\(entry.id) names a source that does not exist: \(source)")
            }
        }
    }

    /// A flag that takes a value refuses to go without one: a trailing `--only` drew the whole catalog and rewrote the
    /// manifest and the board, which `--only` promises never to write.
    func testTheCatalogToolRefusesAFlagWithoutItsValue() throws {
        XCTAssertEqual(try KitCatalogArguments.parse(["--out", "/tmp/catalog", "--only", "hues", "--only", "badges"]),
                       KitCatalogArguments(out: "/tmp/catalog", only: ["hues", "badges"]))
        let refused: [([String], KitCatalogArguments.Failure)] = [
            (["--out", "/tmp/catalog", "--only"], .missingValue("--only")),
            (["--only", "--out", "/tmp/catalog"], .missingValue("--only")),
            (["--out"], .missingValue("--out")),
            (["--probe"], .missingValue("--probe")),
            (["--draw"], .unknown("--draw")),
        ]
        for (arguments, failure) in refused {
            XCTAssertThrowsError(try KitCatalogArguments.parse(arguments), "\(arguments)") { error in
                XCTAssertEqual(error as? KitCatalogArguments.Failure, failure, "\(arguments)")
            }
        }
        XCTAssertTrue(try KitCatalogArguments.parse(["--help", "--draw"]).help, "--help ends the reading")
    }

    func testDisabledAgentFieldRejectsAccessibilityWrites() throws {
        var value = "Original"
        let root = NSHostingView(rootView: AgentTextField("Name", text: Binding(get: { value }, set: { value = $0 }))
            .disabled(true).frame(width: 220, height: 30))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 220, height: 30),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        defer { window.close() }
        window.contentView = root
        root.layoutSubtreeIfNeeded()
        _ = root.fittingSize
        func field(in view: NSView) -> AgentTextField.Field? {
            if let field = view as? AgentTextField.Field { return field }
            return view.subviews.compactMap { field(in: $0) }.first
        }
        let field = try XCTUnwrap(field(in: root))
        XCTAssertFalse(field.isEnabled)
        field.setAccessibilityValue("Changed")
        XCTAssertEqual(value, "Original")
        XCTAssertEqual(field.stringValue, "Original")
        field.isEnabled = true
        field.setAccessibilityValue("Enabled")
        XCTAssertEqual(value, "Enabled")
    }

    func testPulsingDotsStayVisibleAndStillWithReducedMotion() throws {
        let root = NSHostingView(rootView: PulsingDots(color: .blue)
            .environment(\.nativeSettingsReduceMotion, true).frame(width: 40, height: 12))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 40, height: 12),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        defer { window.close() }
        window.contentView = root
        root.layoutSubtreeIfNeeded()
        _ = root.fittingSize
        func dots(in view: NSView) -> PulsingDots.DotsView? {
            if let dots = view as? PulsingDots.DotsView { return dots }
            return view.subviews.compactMap { dots(in: $0) }.first
        }
        let view = try XCTUnwrap(dots(in: root))
        let layers = try XCTUnwrap(view.layer?.sublayers)
        XCTAssertEqual(layers.count, 3)
        XCTAssertTrue(layers.allSatisfy { ($0.animationKeys() ?? []).isEmpty })
        XCTAssertTrue(layers.allSatisfy { $0.opacity >= 0.7 })
    }

    func testEveryEntryDraws() async throws {
        let entries = KitCatalog.entries
        XCTAssertEqual(Set(entries.map(\.id)).count, entries.count, "two entries share an id")
        for entry in entries {
            XCTAssertFalse(entry.looks.isEmpty, "\(entry.id) has no look")
            XCTAssertFalse(entry.critique.isEmpty, "\(entry.id) has no critique")
            // One sheet per entry keeps the test short; the looks share the layout.
            let look = try XCTUnwrap(entry.looks.last)
            let rendered = await KitCatalogRenderer.png(of: CatalogSheet(entry: entry, look: look), width: CatalogSheet.width, scale: 1)
            let data = try XCTUnwrap(rendered, "\(entry.id) did not draw")
            let image = try XCTUnwrap(NSBitmapImageRep(data: data))
            XCTAssertEqual(image.pixelsWide, Int(CatalogSheet.width))
            XCTAssertGreaterThan(image.pixelsHigh, 200, "\(entry.id) drew an empty sheet")
            XCTAssertGreaterThan(image.colorAt(x: 10, y: 10)?.alphaComponent ?? 0, 0.99,
                                 "\(entry.id) lost its background while capturing native materials")
        }
    }

    /// `classic` is what the kit drew before looks existed: the exact values, not near ones.
    func testTheClassicLookKeepsTheOldValues() {
        let look = KitLook.classic
        XCTAssertEqual(look.radius(.thumb, height: 24, legacy: 6), 6)
        XCTAssertEqual(look.radius(.ghost, height: 26, legacy: 7), 7)
        XCTAssertEqual(look.wellInset, 2)
        XCTAssertNil(look.surface(.well).stroke)
        XCTAssertNil(look.surface(.thumb).shadow)
        XCTAssertEqual(look.surface(.primary, .hover).brightness, 0.08)
        XCTAssertEqual(look.surface(.primary, .pressed).brightness, -0.1)
    }
}
