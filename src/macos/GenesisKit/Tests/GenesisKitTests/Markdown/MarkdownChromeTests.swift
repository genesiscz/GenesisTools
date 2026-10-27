import AppKit
import SwiftUI
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

    func testAnUnpinnedTreeRetargetsGitWhenTheSelectedTabChangesRepository() async throws {
        let first = try file("repo-a/first.md"), second = try file("repo-b/second.md")
        for note in [first, second] {
            let result = try GenesisKitGTCLIProvider().git(["init", "-q"], in: note.deletingLastPathComponent())
            XCTAssertEqual(result.status, 0)
        }
        let model = model()
        model.configuration.git = true
        model.configuration.gitTreeDecorations = true
        model.filesRoot = ""
        model.open([first, second])
        model.select(first.path)
        let gitTree = GitTreeDecorationsModel()
        let host = NSHostingView(rootView: MarkdownFileTreeView(model: model, gitTree: gitTree).frame(width: 300, height: 500))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 300, height: 500), styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = host
        defer { window.contentView = nil; gitTree.follow(nil) }
        host.layoutSubtreeIfNeeded()
        func waitForMark(_ note: URL) async {
            let end = Date().addingTimeInterval(5)
            while gitTree.decorations.change(for: note.path) == nil, Date() < end {
                try? await Task.sleep(for: .milliseconds(100))
            }
            XCTAssertEqual(gitTree.decorations.change(for: note.path), .untracked)
        }
        await waitForMark(first)
        model.select(second.path)
        host.layoutSubtreeIfNeeded()
        await waitForMark(second)
        XCTAssertNil(gitTree.decorations.change(for: first.path))
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
        let photo = try file("notes/photo.png", "png")
        _ = try file("notes/archive.zip", "zip")
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

        XCTAssertEqual(target("photo.png"), photo.path, "a picture previews as itself")
        XCTAssertNil(target("archive.zip"), "not a file the viewer reads, and no picture")
        XCTAssertNil(target("sub"), "a folder")
        XCTAssertNil(target("missing.md"))
        XCTAssertNil(target("#Heading"), "a heading in this note")
        XCTAssertNil(target("https://example.com/plan.md"), "a web address shows nothing")
        XCTAssertNil(target("mailto:alice@example.com"))
        XCTAssertNil(target("obsidian://open?vault=Brain"))
        XCTAssertNil(target(""))
    }

    func testPendingNameOnlyHoverRetriesAfterTheIndexScan() async throws {
        let note = try file("Clients/Acme/Plan.md")
        let folder = dir.appendingPathComponent("Clients/Acme/Design")
        let release = DispatchSemaphore(value: 0)
        let index = VaultFileIndex(root: dir) { _ in
            _ = release.wait(timeout: .now() + 5)
            return .init(paths: [], attachmentFolder: nil, notes: ["Clients/Acme/Plan.md"])
        }
        let ready = expectation(description: "hover can retry")
        XCTAssertNil(MarkdownHoverTarget.url(forLink: "Plan", folder: folder, text: "", vaultRoot: dir.path,
                                             index: index, onIndexReady: { ready.fulfill() }))
        release.signal()
        await fulfillment(of: [ready], timeout: 5)
        XCTAssertEqual(MarkdownHoverTarget.url(forLink: "Plan", folder: folder, text: "", vaultRoot: dir.path,
                                               index: index)?.path, note.path)
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

        let photo = try file("photo.png", "png")
        controller.enter(owner: owner, url: photo, model: model, view: nil) { nil }
        XCTAssertEqual(controller.request?.url, photo, "a picture has one")
        controller.exit(owner: owner)

        model.configuration.hoverPreview = false
        controller.enter(owner: owner, url: plan, model: model, view: nil) { nil }
        XCTAssertNil(controller.request, "hover previews off")
        controller.hide()
    }

    // MARK: Hover preview of an image

    /// 240 × 160: blue, with a yellow disc on the left. Invented.
    static let svgFixture = """
    <svg xmlns="http://www.w3.org/2000/svg" width="240" height="160" viewBox="0 0 240 160">
      <rect width="240" height="160" rx="16" fill="#2563eb"/>
      <circle cx="60" cy="80" r="36" fill="#facc15"/>
    </svg>
    """

    /// A 400 × 300 red PNG and the 240 × 160 SVG.
    private func imageFixtures() throws -> (png: URL, svg: URL) {
        let png = dir.appendingPathComponent("pictures/red.png")
        try FileManager.default.createDirectory(at: png.deletingLastPathComponent(), withIntermediateDirectories: true)
        try MediaThumbnailCacheTests.writePNG(png, width: 400, height: 300, color: CGColor(srgbRed: 0.9, green: 0.1, blue: 0.1, alpha: 1))
        return (png.standardizedFileURL, try file("pictures/badge.svg", Self.svgFixture))
    }

    /// The red, green and blue of `image` at a point given as fractions of its size, top left origin.
    private func rgb(_ image: CGImage, x: CGFloat, y: CGFloat) throws -> (CGFloat, CGFloat, CGFloat) {
        let rep = NSBitmapImageRep(cgImage: image)
        let color = try XCTUnwrap(rep.colorAt(x: Int(CGFloat(rep.pixelsWide) * x), y: Int(CGFloat(rep.pixelsHigh) * y))?.usingColorSpace(.sRGB))
        return (color.redComponent, color.greenComponent, color.blueComponent)
    }

    private func picture(_ url: URL, draft: String? = nil) async throws -> MediaThumbnail {
        let result = await MarkdownHoverImage.picture(url: url, pixels: 1120, draft: draft)
        guard case .ready(let thumbnail) = result else {
            XCTFail("no picture of \(url.lastPathComponent): \(result)")
            throw CancellationError()
        }
        return thumbnail
    }

    func testAnSVGAndAPNGPreviewAsTheirPicturesWithTheirSizeAndABrokenOneSaysWhatFailed() async throws {
        let (png, svg) = try imageFixtures()
        XCTAssertTrue(MarkdownHoverTarget.isPreviewable(png))
        XCTAssertTrue(MarkdownHoverTarget.isPreviewable(svg))
        XCTAssertFalse(MarkdownHoverImage.hasSource(png), "a raster picture has no code to show")
        XCTAssertTrue(MarkdownHoverImage.hasSource(svg))

        let raster = try await picture(png)
        XCTAssertEqual(raster.sourceSize, CGSize(width: 400, height: 300))
        XCTAssertFalse(raster.isIcon)
        let vector = try await picture(svg)
        XCTAssertEqual(vector.sourceSize, CGSize(width: 240, height: 160), "the SVG's own size")
        XCTAssertGreaterThanOrEqual(vector.image.width, 1120, "drawn at the panel's pixels, not at its own 240")
        let (r, g, b) = try rgb(vector.image, x: 0.5, y: 0.5)
        XCTAssertTrue(b > 0.7 && r < 0.4 && g < 0.6, "the SVG's blue, got \(r) \(g) \(b)")
        let (dr, dg, db) = try rgb(vector.image, x: 0.25, y: 0.5)
        XCTAssertTrue(dr > 0.8 && dg > 0.6 && db < 0.4, "its yellow disc, got \(dr) \(dg) \(db)")

        XCTAssertEqual(MarkdownHoverImage.caption(url: png, size: raster.sourceSize, bytes: nil), "PNG · 400 × 300 px")
        XCTAssertEqual(MarkdownHoverImage.caption(url: svg, size: vector.sourceSize, bytes: 2048), "SVG · 240 × 160 px · \(ByteFormat.file(2048))")

        // An SVG open as a tab with unsaved edits: the picture of the draft, as the tab shows it.
        let draft = try await picture(svg, draft: Self.svgFixture.replacingOccurrences(of: "#2563eb", with: "#16a34a"))
        let (gr, gg, gb) = try rgb(draft.image, x: 0.5, y: 0.5)
        XCTAssertTrue(gg > 0.5 && gr < 0.3 && gb < 0.5, "the draft's green, got \(gr) \(gg) \(gb)")

        let brokenSVG = try file("pictures/broken.svg", "not an svg <<<")
        guard case .failed(let svgReason) = await MarkdownHoverImage.picture(url: brokenSVG, pixels: 1120, draft: nil) else {
            return XCTFail("a broken SVG has no picture")
        }
        XCTAssertEqual(svgReason, MediaThumbnailCache.unreadableSVG)
        let brokenPNG = try file("pictures/broken.png", "not a png")
        guard case .failed(let pngReason) = await MarkdownHoverImage.picture(url: brokenPNG, pixels: 1120, draft: nil) else {
            return XCTFail("a broken PNG has no picture")
        }
        XCTAssertEqual(pngReason, "The image could not be read.")
    }

    /// The card in a panel that is never ordered front, rendered natively (a web view draws nothing here).
    /// `clickable`: SwiftUI's buttons take a click only in a window that is ordered in (a probe on 2026-10-13: a
    /// never-ordered window ignored it, the same panel ordered back took it, key or not), so the panel goes behind
    /// every window, off every screen, transparent and blind to the real pointer.
    private func hostedCard(_ url: URL, text: String, state: MarkdownHoverCardState, theme: MarkdownTheme,
                            clickable: Bool = false) -> MarkdownHoverPanel
    {
        let panel = MarkdownHoverPanel(
            contentRect: CGRect(x: 0, y: 0, width: 560, height: 440), styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered, defer: false)
        panel.isReleasedWhenClosed = false
        panel.appearance = NSAppearance(named: theme.isDark ? .darkAqua : .aqua)
        if clickable {
            panel.alphaValue = 0
            panel.ignoresMouseEvents = true
            panel.setFrameOrigin(CGPoint(x: -10000, y: -10000))
            panel.orderBack(nil)
            addTeardownBlock { @MainActor in panel.orderOut(nil) }
        }
        let card = MarkdownHoverCard(
            content: MarkdownHoverPreviewController.content(url: url, text: text), theme: theme, renderer: .native,
            zoom: 1, vaultRoot: nil, proxy: MarkdownWebProxy(), state: state)
        let hosting = NSHostingView(rootView: card)
        hosting.frame = panel.container.bounds
        hosting.autoresizingMask = [.width, .height]
        panel.container.addSubview(hosting)
        return panel
    }

    private func settle(_ panel: NSPanel) async {
        for _ in 0..<6 {
            panel.contentView?.layoutSubtreeIfNeeded()
            try? await Task.sleep(for: .milliseconds(25))
        }
    }

    /// A press and release at `point` (window coordinates), delivered as the window server would.
    private func click(_ panel: NSPanel, at point: CGPoint) throws {
        for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
            let event = try XCTUnwrap(NSEvent.mouseEvent(
                with: type, location: point, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                windowNumber: panel.windowNumber, context: nil, eventNumber: 0, clickCount: 1,
                pressure: type == .leftMouseDown ? 1 : 0))
            panel.sendEvent(event)
        }
    }

    private func imageState(_ thumbnail: MediaThumbnail, source: Bool) -> MarkdownHoverCardState {
        MarkdownHoverCardState(picture: .ready(thumbnail), bytes: 1234, hasSource: source) { .ready(thumbnail) }
    }

    func testTheSwitchShowsTheSVGCodeAndBackWhileAClickAnywhereElseOpensTheFile() async throws {
        let (png, svg) = try imageFixtures()
        let state = imageState(try await picture(svg), source: true)
        let panel = hostedCard(svg, text: Self.svgFixture, state: state, theme: MarkdownTheme(palette: .genesis, contrast: .standard),
                               clickable: true)
        var opened = 0
        panel.onClick = { opened += 1 }
        await settle(panel)
        XCTAssertEqual(MarkdownHoverMarker.rects(.picture, in: panel.container).count, 1, "the picture shows first")
        XCTAssertFalse(state.showsPage)

        let toggle = try XCTUnwrap(MarkdownHoverMarker.rects(.control, in: panel.container).first, "the switch is there")
        try click(panel, at: CGPoint(x: toggle.midX, y: toggle.midY))
        await settle(panel)
        XCTAssertTrue(state.showsSource, "the switch got the click")
        XCTAssertTrue(state.showsPage, "the page with the code shows")
        XCTAssertTrue(MarkdownHoverMarker.rects(.picture, in: panel.container).isEmpty, "the picture is gone")
        XCTAssertEqual(opened, 0, "a click on the switch does not open the file")

        try click(panel, at: CGPoint(x: 40, y: 40))
        XCTAssertEqual(opened, 1, "a click on the page opens the file")

        let back = try XCTUnwrap(MarkdownHoverMarker.rects(.control, in: panel.container).first)
        try click(panel, at: CGPoint(x: back.midX, y: back.midY))
        await settle(panel)
        XCTAssertFalse(state.showsSource)
        XCTAssertEqual(MarkdownHoverMarker.rects(.picture, in: panel.container).count, 1, "and back to the picture")
        XCTAssertEqual(opened, 1)

        // A raster picture has no code: no switch, and a click views it.
        let raster = hostedCard(png, text: "", state: imageState(try await picture(png), source: false), theme: MarkdownTheme(palette: .light, contrast: .standard))
        await settle(raster)
        XCTAssertTrue(MarkdownHoverMarker.rects(.control, in: raster.container).isEmpty, "no switch for a PNG")
        XCTAssertEqual(MarkdownHoverMarker.rects(.picture, in: raster.container).count, 1)
    }

    func testThePictureIsDrawnOnTheCardInDarkAndLight() async throws {
        let (png, svg) = try imageFixtures()
        // GENESIS_HOVER_SHOTS=<folder> also saves each card as a PNG there, for a person to look at.
        let shots = ProcessInfo.processInfo.environment["GENESIS_HOVER_SHOTS"].map { URL(fileURLWithPath: $0) }
        let stamp: String = {
            let format = DateFormatter()
            format.dateFormat = "yyyy-MM-dd-HHmm"
            return format.string(from: Date())
        }()
        func snapshot(_ panel: MarkdownHoverPanel, _ name: String) throws -> NSBitmapImageRep {
            let view = panel.container
            let rep = try XCTUnwrap(view.bitmapImageRepForCachingDisplay(in: view.bounds))
            view.cacheDisplay(in: view.bounds, to: rep)
            if let shots {
                let data = try XCTUnwrap(rep.representation(using: .png, properties: [:]))
                try data.write(to: shots.appendingPathComponent("\(stamp)-markdown-hover-image-\(name).png"))
            }
            return rep
        }
        for theme in [MarkdownTheme(palette: .genesis, contrast: .standard), MarkdownTheme(palette: .light, contrast: .standard)] {
            let shade = theme.isDark ? "dark" : "light"
            for (name, url, blue) in [("svg", svg, true), ("png", png, false)] {
                let state = imageState(try await picture(url), source: url == svg)
                let panel = hostedCard(url, text: url == svg ? Self.svgFixture : "", state: state, theme: theme)
                await settle(panel)
                let rect = try XCTUnwrap(MarkdownHoverMarker.rects(.picture, in: panel.container).first)
                let rep = try snapshot(panel, "\(name)-\(shade)")
                let scale = CGFloat(rep.pixelsWide) / panel.container.bounds.width
                let color = try XCTUnwrap(rep.colorAt(
                    x: Int(rect.midX * scale), y: Int((panel.container.bounds.height - rect.midY) * scale))?.usingColorSpace(.sRGB))
                if blue {
                    XCTAssertTrue(color.blueComponent > 0.7 && color.redComponent < 0.4, "\(name) \(shade): the picture's blue, got \(color)")
                } else {
                    XCTAssertTrue(color.redComponent > 0.7 && color.greenComponent < 0.3, "\(name) \(shade): the picture's red, got \(color)")
                }
                if url == svg {
                    state.toggleSource()
                    await settle(panel)
                    _ = try snapshot(panel, "svg-code-\(shade)")
                }
            }
        }
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
