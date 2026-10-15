import AppKit
import XCTest
@testable import GenesisKit

/// The markdown window's chrome: preview tabs, wrapped tabs, the hover preview's placement and link
/// targets, the contrast of secondary text, and the toolbar's label modes.
@MainActor
final class MarkdownChromeTests: XCTestCase {
    private var dir: URL!

    override func setUp() async throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("md-chrome-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    private func file(_ name: String, _ text: String = "# note\n\nbody\n") throws -> URL {
        let url = dir.appendingPathComponent(name)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try text.write(to: url, atomically: true, encoding: .utf8)
        return url.standardizedFileURL
    }

    private func configuration() -> GenesisKitMarkdownConfiguration {
        GenesisKitMarkdownConfiguration(defaults: UserDefaults(suiteName: "md-chrome-config-\(UUID().uuidString)")!)
    }

    private func model() -> MarkdownDocumentsModel {
        let model = MarkdownDocumentsModel(defaults: UserDefaults(suiteName: "md-chrome-\(UUID().uuidString)")!)
        model.configuration = configuration()
        return model
    }

    func testStatusBarUsesTheSharedEnglishFileSizeFormat() throws {
        let model = model()
        for size in [0, 1_000, 1_234_567] {
            let note = try file("size-\(size).md", String(repeating: "a", count: size))
            model.open([note])
            let doc = try XCTUnwrap(model.selected)
            XCTAssertEqual(doc.byteSize, size)
            let bar = MarkdownStatusBar(doc: doc, model: model)
            XCTAssertEqual(bar.byteText, ByteFormat.file(Int64(size)))
            XCTAssertFalse(bar.byteText.contains(","), "file sizes keep English decimal punctuation")
        }
    }

    // MARK: Preview tabs

    func testAPreviewTabIsReplacedInPlaceAndAKeptTabIsNot() throws {
        let a = try file("notes/a.md"), b = try file("notes/b.md"), c = try file("notes/c.md"), d = try file("notes/d.md")
        let model = model()

        model.openPreview(a)
        XCTAssertEqual(model.docs.map(\.id), [a.path])
        XCTAssertEqual(model.previewTabId, a.path)
        XCTAssertEqual(model.selectedId, a.path)

        model.openPreview(b)
        XCTAssertEqual(model.docs.map(\.id), [b.path], "the next single click reuses the preview tab")
        XCTAssertEqual(model.previewTabId, b.path)
        XCTAssertFalse(model.recentlyClosed.contains(a), "a replaced preview is no tab to reopen")

        model.open([c])
        XCTAssertEqual(model.docs.map(\.id), [b.path, c.path])
        XCTAssertEqual(model.previewTabId, b.path, "a normal open leaves the preview tab alone")

        model.openPreview(d)
        XCTAssertEqual(model.docs.map(\.id), [d.path, c.path], "replaced where it was, not moved to the end")
        XCTAssertEqual(model.previewTabId, d.path)

        model.openPreview(c)
        XCTAssertEqual(model.selectedId, c.path)
        XCTAssertEqual(model.docs.map(\.id), [d.path, c.path], "an open tab is only selected")
        XCTAssertEqual(model.previewTabId, d.path)
        XCTAssertTrue(model.isPreview(try XCTUnwrap(model.docs.first)))
    }

    func testKeepEditDoubleOpenAndCloseEachKeepThePreviewTab() throws {
        let a = try file("a.md"), b = try file("b.md"), c = try file("c.md"), d = try file("d.md")
        let model = model()

        model.openPreview(a)
        model.keep(try XCTUnwrap(model.previewTab))
        XCTAssertNil(model.previewTabId)
        model.openPreview(b)
        XCTAssertEqual(model.docs.map(\.id), [a.path, b.path], "a kept tab is not replaced")

        // An edit keeps it, and undoing the edit does not make it a preview again.
        let docB = try XCTUnwrap(model.previewTab)
        docB.edit("# changed\n")
        XCTAssertNil(model.previewTabId)
        docB.edit(docB.text)
        XCTAssertNil(model.previewTabId)

        // Opening the preview tab's own file on purpose (a double-click in the tree, a link) keeps it.
        model.openPreview(c)
        model.open([c])
        XCTAssertNil(model.previewTabId)
        XCTAssertEqual(model.docs.map(\.id), [a.path, b.path, c.path])

        // Closing the preview tab leaves no preview behind; the next one is a new tab at the end.
        model.openPreview(d)
        model.close(try XCTUnwrap(model.previewTab)) { _ in .discard }
        XCTAssertNil(model.previewTabId)
        model.openPreview(a)
        XCTAssertNil(model.previewTabId, "an open tab stays kept")
    }

    func testWithPreviewTabsOffEverySingleClickOpensAKeptTab() throws {
        let a = try file("a.md"), b = try file("b.md")
        let model = model()
        model.configuration.previewTabs = false
        model.openPreview(a)
        model.openPreview(b)
        XCTAssertEqual(model.docs.map(\.id), [a.path, b.path])
        XCTAssertNil(model.previewTabId)
        XCTAssertNil(model.previewTab)
    }

    // MARK: Wrapped tabs

    func testFlowBreaksRowsWhenTheNextTabWouldPassTheEdge() {
        let rows = { (widths: [CGFloat], max: CGFloat) in MarkdownTabFlow.rows(widths: widths, maxWidth: max, spacing: 2) }
        XCTAssertEqual(rows([], 100), [])
        XCTAssertEqual(rows([50, 50, 50], 154), [0..<3], "50 + 2 + 50 + 2 + 50 is exactly 154")
        XCTAssertEqual(rows([50, 50, 50], 153), [0..<2, 2..<3])
        XCTAssertEqual(rows([50, 50, 50], 60), [0..<1, 1..<2, 2..<3])
        XCTAssertEqual(rows([200, 50, 30], 100), [0..<1, 1..<3], "a tab wider than the row gets a row of its own")
        XCTAssertEqual(rows([30, 200, 30], 100), [0..<1, 1..<2, 2..<3])
        XCTAssertEqual(rows([40, 40, 40, 40, 40], .infinity), [0..<5])
        // Every tab is in exactly one row, in order.
        let widths: [CGFloat] = [120, 80, 64, 200, 90, 90, 90, 300, 20]
        let flat = rows(widths, 260).flatMap { Array($0) }
        XCTAssertEqual(flat, Array(widths.indices))
    }

    // MARK: Hover preview placement

    private let wanted = CGSize(width: 560, height: 440)
    private let screen = CGRect(x: 0, y: 0, width: 1440, height: 900)

    private func place(_ anchor: CGRect, in visible: CGRect? = nil, size: CGSize? = nil) -> CGRect? {
        MarkdownHoverPlacement.frame(size: size ?? wanted, anchor: anchor, visible: visible ?? screen)
    }

    func testPreviewOpensBelowRightAndFlipsAtTheRightAndBottomEdges() throws {
        let gap = MarkdownHoverPlacement.gap

        let middle = CGRect(x: 600, y: 500, width: 120, height: 30)
        XCTAssertEqual(place(middle), CGRect(x: middle.maxX + gap, y: middle.minY - gap - 440, width: 560, height: 440))

        let right = CGRect(x: 1300, y: 500, width: 120, height: 30)
        let flipped = try XCTUnwrap(place(right))
        XCTAssertEqual(flipped.maxX, right.minX - gap, "past the right edge it opens to the anchor's left")
        XCTAssertEqual(flipped.maxY, right.minY - gap)

        let bottom = CGRect(x: 600, y: 100, width: 120, height: 30)
        let above = try XCTUnwrap(place(bottom))
        XCTAssertEqual(above.minY, bottom.maxY + gap, "too close to the bottom: above the anchor")
        XCTAssertEqual(above.minX, bottom.maxX + gap)

        let corner = CGRect(x: 1350, y: 20, width: 80, height: 20)
        let up = try XCTUnwrap(place(corner))
        XCTAssertEqual(up.maxX, corner.minX - gap)
        XCTAssertEqual(up.minY, corner.maxY + gap)

        let topLeft = CGRect(x: 0, y: 860, width: 40, height: 30)
        XCTAssertEqual(place(topLeft), CGRect(x: topLeft.maxX + gap, y: topLeft.minY - gap - 440, width: 560, height: 440))
    }

    func testOnAShortScreenThePreviewGoesBesideTheAnchorOrShrinksIntoTheRoomiestSide() throws {
        // Neither below nor above has 440 points, but the right side has the width: beside, full height.
        let short = CGRect(x: 0, y: 0, width: 1440, height: 600)
        let besideAnchor = CGRect(x: 300, y: 280, width: 100, height: 20)
        let beside = try XCTUnwrap(place(besideAnchor, in: short))
        XCTAssertEqual(beside.minX, besideAnchor.maxX + MarkdownHoverPlacement.gap)
        XCTAssertEqual(beside.size, wanted)

        // Small on both axes: shrunk into the side with the most room, never over the anchor.
        let small = CGRect(x: 0, y: 0, width: 800, height: 500)
        let anchor = CGRect(x: 300, y: 240, width: 100, height: 20)
        let shrunk = try XCTUnwrap(place(anchor, in: small))
        XCTAssertLessThan(shrunk.width, wanted.width)
        XCTAssertEqual(shrunk.height, 440)
        XCTAssertGreaterThanOrEqual(shrunk.minX, anchor.maxX)

        // No side has room for a readable preview: none.
        XCTAssertNil(place(CGRect(x: 0, y: 0, width: 800, height: 500), in: small))
        XCTAssertNil(place(anchor, in: CGRect(x: 0, y: 0, width: 150, height: 100)))
    }

    func testThePreviewStaysOnScreenAndOffTheAnchorEverywhere() {
        let screens = [
            screen,
            CGRect(x: 1440, y: -200, width: 1920, height: 1080), // a second display, below the first's origin
            CGRect(x: 0, y: 0, width: 1024, height: 640),
            CGRect(x: 0, y: 0, width: 700, height: 420),
        ]
        let anchors = [CGSize(width: 120, height: 30), CGSize(width: 260, height: 22), CGSize(width: 48, height: 16)]
        var placed = 0
        for visible in screens {
            let area = visible.insetBy(dx: MarkdownHoverPlacement.margin, dy: MarkdownHoverPlacement.margin)
            for size in anchors {
                for fx in stride(from: 0.0, through: 1.0, by: 0.1) {
                    for fy in stride(from: 0.0, through: 1.0, by: 0.1) {
                        let anchor = CGRect(
                            x: visible.minX + (visible.width - size.width) * fx,
                            y: visible.minY + (visible.height - size.height) * fy,
                            width: size.width, height: size.height
                        )
                        guard let frame = place(anchor, in: visible) else { continue }
                        placed += 1
                        let where_ = "anchor \(anchor) on \(visible) -> \(frame)"
                        XCTAssertTrue(area.insetBy(dx: -0.5, dy: -0.5).contains(frame), "off screen: \(where_)")
                        let overlap = frame.intersection(anchor)
                        XCTAssertTrue(overlap.isNull || overlap.width * overlap.height < 0.5, "covers the anchor: \(where_)")
                        XCTAssertGreaterThanOrEqual(frame.width, MarkdownHoverPlacement.minimumSize.width, where_)
                        XCTAssertGreaterThanOrEqual(frame.height, MarkdownHoverPlacement.minimumSize.height, where_)
                    }
                }
            }
        }
        XCTAssertGreaterThan(placed, 300, "nearly every anchor gets a preview")
    }

    func testALinkBoxFromThePageTurnsIntoTheViewsOwnCoordinates() {
        let box = CGRect(x: 10, y: 20, width: 30, height: 40)
        XCTAssertEqual(MarkdownHoverPlacement.localRect(ofTopLeft: box, height: 200, flipped: true), box)
        XCTAssertEqual(
            MarkdownHoverPlacement.localRect(ofTopLeft: box, height: 200, flipped: false),
            CGRect(x: 10, y: 140, width: 30, height: 40)
        )
    }

    // MARK: Hover preview targets

    func testALinkPreviewsTheNoteOrFileAClickWouldOpenAndNothingElse() throws {
        let plan = try file("notes/plan.md")
        let data = try file("notes/data.json", "{}")
        let code = try file("notes/tool.ts", "export {}")
        _ = try file("notes/photo.png", "png")
        try FileManager.default.createDirectory(at: dir.appendingPathComponent("notes/sub"), withIntermediateDirectories: true)
        let folder = dir.appendingPathComponent("notes")
        let text = "See [the plan][ref].\n\n[ref]: plan.md\n"
        let target = { (href: String) in
            MarkdownHoverTarget.url(forLink: href, folder: folder, text: text, vaultRoot: self.dir.path)?.standardizedFileURL.path
        }

        XCTAssertEqual(target("plan.md"), plan.path)
        XCTAssertEqual(target("plan"), plan.path, "a wikilink names the note without its extension")
        XCTAssertEqual(target("notes/plan#Heading"), plan.path, "vault-rooted, with a heading")
        XCTAssertEqual(target("./plan.md#L2-L4"), plan.path)
        XCTAssertEqual(target("ref"), plan.path, "a reference definition")
        XCTAssertEqual(target("genres://asset/plan.md"), plan.path, "a link the page resolved against its base")
        XCTAssertEqual(target("data.json"), data.path)
        XCTAssertEqual(target("tool.ts"), code.path, "code the viewer can show")
        XCTAssertEqual(target("file://\(plan.path)"), plan.path)

        XCTAssertNil(target("photo.png"), "not a file the viewer reads")
        XCTAssertNil(target("sub"), "a folder")
        XCTAssertNil(target("missing.md"))
        XCTAssertNil(target("#Heading"), "a heading in this note")
        XCTAssertNil(target("https://example.com/plan.md"), "a web address shows nothing")
        XCTAssertNil(target("mailto:alice@example.com"))
        XCTAssertNil(target("obsidian://open?vault=Brain"))
        XCTAssertNil(target(""))
    }

    func testTheControllerTracksTheAnchorAndRespectsTheSwitch() throws {
        let plan = try file("plan.md")
        let model = model()
        model.configuration.hoverPreviewDelay = 60
        let controller = MarkdownHoverPreviewController.shared
        let owner = UUID()

        controller.enter(owner: owner, url: plan, model: model, view: nil) { nil }
        XCTAssertEqual(controller.request?.url, plan)
        controller.exit(owner: UUID())
        XCTAssertEqual(controller.request?.owner, owner, "another anchor leaving does not cancel this one")
        controller.exit(owner: owner)
        XCTAssertNil(controller.request)

        controller.enter(owner: owner, url: dir, model: model, view: nil) { nil }
        XCTAssertNil(controller.request, "a folder has no preview")

        model.configuration.hoverPreview = false
        controller.enter(owner: owner, url: plan, model: model, view: nil) { nil }
        XCTAssertNil(controller.request, "hover previews off")
        controller.hide()
    }

    // MARK: Contrast

    func testHighContrastSecondaryAndMutedTextPassOnTheChromeAndThePage() {
        for palette in MarkdownTheme.Palette.allCases {
            let high = MarkdownTheme(palette: palette, contrast: .high)
            let standard = MarkdownTheme(palette: palette, contrast: .standard)
            for background in [high.chromeHex, high.pageHex] {
                let secondary = MarkdownTheme.contrastRatio(high.textSecondaryHex, background)
                let muted = MarkdownTheme.contrastRatio(high.textMutedHex, background)
                let text = MarkdownTheme.contrastRatio(high.textHex, background)
                XCTAssertGreaterThanOrEqual(secondary, 7, "\(palette) secondary \(secondary)")
                XCTAssertGreaterThanOrEqual(muted, 4.5, "\(palette) muted \(muted)")
                // Still an order of importance: text, then secondary, then muted.
                XCTAssertGreaterThan(text, secondary, "\(palette)")
                XCTAssertGreaterThan(secondary, muted, "\(palette)")
                // Brighter than the standard greys, and the light theme stays dark on light.
                XCTAssertGreaterThan(secondary, MarkdownTheme.contrastRatio(standard.textSecondaryHex, background), "\(palette)")
                XCTAssertGreaterThan(muted, MarkdownTheme.contrastRatio(standard.textMutedHex, background), "\(palette)")
            }
            XCTAssertEqual(
                MarkdownTheme.luminance(high.textSecondaryHex) < MarkdownTheme.luminance(high.chromeHex),
                palette == .light,
                "\(palette): dark text on light, light text on dark"
            )
            // The page uses the same values as the chrome.
            XCTAssertEqual(high.cssVariables["--dd-text-dim"], MarkdownTheme.css(high.textSecondaryHex))
            XCTAssertEqual(high.cssVariables["--dd-text-faint"], MarkdownTheme.css(high.textMutedHex))
            XCTAssertEqual(standard.cssVariables["--dd-text-dim"], MarkdownTheme.css(standard.textSecondaryHex))
        }
        // The standard greys are the originals.
        XCTAssertEqual(MarkdownTheme(palette: .genesis, contrast: .standard).cssVariables["--dd-text-dim"], "#8b96a0")
        XCTAssertEqual(MarkdownTheme(palette: .light, contrast: .standard).cssVariables["--dd-text-faint"], "#656d76")
        XCTAssertEqual(MarkdownTheme.contrastRatio(0x000000, 0xffffff), 21, accuracy: 0.001)
    }

    func testTheWindowsThemeCarriesTheConfiguredContrastAndHighIsTheDefault() {
        let model = model()
        XCTAssertEqual(model.configuration.contrast, .high)
        XCTAssertEqual(model.theme.contrast, .high)
        model.configuration.contrast = .standard
        XCTAssertEqual(model.theme.contrast, .standard)
        model.cycleTheme()
        XCTAssertEqual(model.theme.contrast, .standard, "a new palette keeps the contrast")
        XCTAssertEqual(MarkdownTheme(rawValue: "obsidian", contrast: .standard)?.next, MarkdownTheme(palette: .light, contrast: .standard))
        XCTAssertNil(MarkdownTheme(rawValue: "sepia"))
    }

    // MARK: Toolbar and status bar

    func testToolbarLabelModesOfferTheRowsViewThatFitsChoosesFrom() {
        XCTAssertEqual(MarkdownToolbarLabels.whenRoom.candidates, [true, false], "labels first, icons when they do not fit")
        XCTAssertEqual(MarkdownToolbarLabels.always.candidates, [true])
        XCTAssertEqual(MarkdownToolbarLabels.never.candidates, [false])
        XCTAssertEqual(configuration().toolbarLabels, .whenRoom)
        // Changes is offered only for a file in a git repository (MarkdownDocumentToolbar.modes).
        XCTAssertEqual(MarkdownViewMode.allCases.map(\.shortLabel), ["Read", "Split", "Source", "Changes"])
    }

    func testTheSavedTimeReadsAsAnAge() {
        let saved = Date(timeIntervalSince1970: 1_000_000)
        XCTAssertEqual(LiveTimeFormat.text(.ago, saved, now: saved.addingTimeInterval(3 * 60 + 20)), "3m ago")
        XCTAssertEqual(LiveTimeFormat.text(.ago, saved, now: saved.addingTimeInterval(4)), "just now")
        // The label wakes when its text changes, not on a fixed tick: a minute after "3m ago".
        XCTAssertEqual(
            LiveTimeFormat.nextChange(.ago, saved, after: saved.addingTimeInterval(200)),
            saved.addingTimeInterval(240)
        )
    }
}
