import AppKit
import XCTest
@testable import GenesisKit
import GenesisKitCatalog

/// The component catalog stays complete and drawable. A control added to `Controls/` needs an entry in
/// `KitCatalogEntries.swift`, or a line in one of the two lists here with the reason it has none.
@MainActor
final class KitCatalogTests: XCTestCase {
    /// Controls with a look of their own that the catalog does not draw yet. Remove a line when you add its entry.
    static let pending: [String: String] = [
        "CopyChip.swift": "tier 2, feedback and status",
        "EmptyState.swift": "tier 2, feedback and status",
        "ForgeBadge.swift": "tier 2, feedback and status",
        "InfoStrip.swift": "tier 2, feedback and status",
        "Kicker.swift": "tier 2, feedback and status",
        "MenuButton.swift": "tier 2, feedback and status",
        "NewItemsPill.swift": "tier 2, feedback and status",
        "NoticePill.swift": "tier 2, feedback and status",
        "NoticeStack.swift": "tier 2, feedback and status",
        "ProviderBadge.swift": "tier 2, feedback and status",
        "PulsingDots.swift": "tier 2, feedback and status",
        "RefreshingMark.swift": "tier 2, feedback and status",
        "Skeleton.swift": "tier 2, feedback and status",
        "SpinningArc.swift": "tier 2, feedback and status",
        "UserAvatar.swift": "tier 2, feedback and status",
        "AgentRosterRow.swift": "tier 3, inputs and rows",
        "AgentTextField.swift": "tier 3, inputs and rows",
        "FittedScroll.swift": "tier 3, inputs and rows",
        "GenScrollBars.swift": "tier 3, inputs and rows",
        "GrowingTextEditor.swift": "tier 3, inputs and rows",
        "HotkeyRecorder.swift": "tier 3, inputs and rows",
        "ScrollOverflowHints.swift": "tier 3, inputs and rows",
    ]

    /// Files in `Controls/` that draw nothing of their own.
    static let notDrawn: [String: String] = [
        "FrameProbe.swift": "reports a control's frame to a test",
        "GenRenderSwap.swift": "swaps content when it is ready",
        "GenResize.swift": "the state of a resize drag",
        "LatestScrollAnchor.swift": "scroll behaviour",
        "MouseClick.swift": "reads the click count of an event",
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
        let files = try folders.flatMap { folder in
            try FileManager.default.contentsOfDirectory(atPath: folder.path).filter { $0.hasSuffix(".swift") }
        }.sorted()
        XCTAssertGreaterThan(files.count, 20, "the Controls folder was not read: \(controls.path)")
        let catalogued = Set(KitCatalog.entries.flatMap { $0.source.components(separatedBy: " · ") }.map { ($0 as NSString).lastPathComponent })

        for file in files {
            let known = catalogued.contains(file) || Self.pending[file] != nil || Self.notDrawn[file] != nil
            XCTAssertTrue(known, "\(file) has no catalog entry. Add one to KitCatalogEntries.swift, or a line with the reason to KitCatalogTests.")
        }
        for file in Array(Self.pending.keys) + Array(Self.notDrawn.keys) {
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

    func testEveryEntryDraws() throws {
        let entries = KitCatalog.entries
        XCTAssertEqual(Set(entries.map(\.id)).count, entries.count, "two entries share an id")
        for entry in entries {
            XCTAssertFalse(entry.looks.isEmpty, "\(entry.id) has no look")
            XCTAssertFalse(entry.critique.isEmpty, "\(entry.id) has no critique")
            // One sheet per entry keeps the test short; the looks share the layout.
            let look = try XCTUnwrap(entry.looks.last)
            let data = try XCTUnwrap(KitCatalogRenderer.png(of: CatalogSheet(entry: entry, look: look), width: CatalogSheet.width, scale: 1),
                                     "\(entry.id) did not draw")
            let image = try XCTUnwrap(NSBitmapImageRep(data: data))
            XCTAssertEqual(image.pixelsWide, Int(CatalogSheet.width))
            XCTAssertGreaterThan(image.pixelsHigh, 200, "\(entry.id) drew an empty sheet")
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
