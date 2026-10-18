import AppKit
import ImageIO
import UniformTypeIdentifiers
import XCTest
@testable import GenesisKitBase
@testable import GenesisKit

/// The wall-clock limits below hold on an idle machine and fail on a loaded one with correct code, so they are checked
/// only in a timing run (`IMAGE_VIEWER_PERF=1`). The functional checks and the printed numbers run every time.
private let timingRun = ProcessInfo.processInfo.environment["IMAGE_VIEWER_PERF"] == "1"

final class ImageZoomMathTests: XCTestCase {
    func testTheFitShowsTheWholePictureAndNeverGoesPast100Percent() {
        // A 4112 × 2580 Retina screenshot in a 1100 × 700 viewport: width decides, 1100 / 4112.
        let fit = ImageZoomMath.fitScale(content: CGSize(width: 4112, height: 2580), viewport: CGSize(width: 1100, height: 700),
                                         backingScale: 2)
        XCTAssertEqual(fit, 1100 / 4112, accuracy: 0.0001)
        // A small picture fits at 100 %: one pixel per display pixel, half a point on Retina.
        let small = ImageZoomMath.fitScale(content: CGSize(width: 200, height: 100), viewport: CGSize(width: 1100, height: 700),
                                           backingScale: 2)
        XCTAssertEqual(small, 0.5)
        XCTAssertEqual(ImageZoomMath.percent(scale: small, backingScale: 2), 100)
    }

    func testAZoomKeepsThePixelUnderTheAnchorInPlace() {
        let content = CGSize(width: 4112, height: 2580)
        let viewport = CGSize(width: 1100, height: 700)
        let fitted = ImageZoomMath.fitted(content: content, viewport: viewport, backingScale: 2)
        let anchor = CGPoint(x: 820, y: 410)
        let pixel = fitted.contentPoint(anchor)
        let zoomed = ImageZoomMath.zoomed(fitted, to: 0.5, anchor: anchor, content: content, viewport: viewport,
                                          limits: ImageZoomMath.limits(fit: fitted.scale, actual: 0.5))
        XCTAssertEqual(zoomed.scale, 0.5)
        XCTAssertEqual(zoomed.viewPoint(pixel).x, anchor.x, accuracy: 0.001)
        XCTAssertEqual(zoomed.viewPoint(pixel).y, anchor.y, accuracy: 0.001)
        // Out again past the fit: the limit holds and the picture is centred, not left where the anchor pulled it.
        let back = ImageZoomMath.zoomed(zoomed, to: 0.01, anchor: CGPoint(x: 10, y: 10), content: content, viewport: viewport,
                                        limits: ImageZoomMath.limits(fit: fitted.scale, actual: 0.5))
        XCTAssertEqual(back, fitted)
    }

    func testPanStopsAtTheEdgesAndAnAxisThatFitsStaysCentred() {
        let content = CGSize(width: 1000, height: 200)
        let viewport = CGSize(width: 400, height: 300)
        let zoom = ImageZoom(scale: 1, origin: .zero)
        let left = ImageZoomMath.panned(zoom, by: CGSize(width: 5000, height: 80), content: content, viewport: viewport)
        XCTAssertEqual(left.origin, CGPoint(x: 0, y: 50), "x stops at the left edge, y stays centred")
        let right = ImageZoomMath.panned(zoom, by: CGSize(width: -5000, height: 0), content: content, viewport: viewport)
        XCTAssertEqual(right.origin.x, -600, "the right edge meets the viewport's right edge")
    }

    func testZoomStepsLandOnTheLadderAndTheFit() {
        let actual: CGFloat = 0.5
        let fit: CGFloat = 0.13
        // The 25 % stop lies under the fit, so the first stop up is 33 %, and down from it is the fit again.
        XCTAssertEqual(ImageZoomMath.step(from: fit, up: true, fit: fit, actual: actual), 0.33 * actual)
        XCTAssertEqual(ImageZoomMath.step(from: 0.33 * actual, up: false, fit: fit, actual: actual), fit)
        XCTAssertEqual(ImageZoomMath.step(from: actual, up: true, fit: fit, actual: actual), 1.5 * actual)
        XCTAssertEqual(ImageZoomMath.step(from: 32 * actual, up: true, fit: fit, actual: actual), 32 * actual)
        XCTAssertEqual(ImageZoomMath.step(from: fit, up: false, fit: fit, actual: actual), fit)
    }

    func testDoubleClickTogglesBetweenTheFitAnd100Percent() {
        XCTAssertEqual(ImageZoomMath.toggleTarget(current: 0.13, fit: 0.13, actual: 0.5), 0.5)
        XCTAssertEqual(ImageZoomMath.toggleTarget(current: 0.5, fit: 0.13, actual: 0.5), 0.13)
        XCTAssertEqual(ImageZoomMath.toggleTarget(current: 2, fit: 0.13, actual: 0.5), 0.13)
        // A picture that already shows at 100 % goes to 200 %.
        XCTAssertEqual(ImageZoomMath.toggleTarget(current: 0.5, fit: 0.5, actual: 0.5), 1)
    }
}

final class CompareLayoutTests: XCTestCase {
    func testBIsScaledToAsWidthAndTheTopsLineUp() {
        let layout = CompareLayout.make(a: CGSize(width: 4112, height: 2580), b: CGSize(width: 2056, height: 1400))
        XCTAssertEqual(layout.bScale, 2)
        XCTAssertEqual(layout.b, CGRect(x: 0, y: 0, width: 4112, height: 2800))
        XCTAssertEqual(layout.content, CGSize(width: 4112, height: 2800), "the taller B extends below A")
        XCTAssertEqual(layout.note(aPixels: CGSize(width: 4112, height: 2580), bPixels: CGSize(width: 2056, height: 1400)),
                       "B is scaled to A's width (2056 × 1400 → 4112 × 2800)")
    }

    func testPicturesOfOneWidthNeedNoNote() {
        let layout = CompareLayout.make(a: CGSize(width: 2056, height: 1290), b: CGSize(width: 2056, height: 1100))
        XCTAssertFalse(layout.scalesB)
        XCTAssertNil(layout.note(aPixels: .zero, bPixels: .zero))
        XCTAssertEqual(layout.content, CGSize(width: 2056, height: 1290))
    }
}

final class WebImageRectTests: XCTestCase {
    /// The numbers measured on a real WKWebView (2026-10-11): a red box at CSS (150, 420, 100 × 60), found in the
    /// web view's own snapshot.
    func testCSSRectsMapToTheWebViewPointsMeasuredOnARealPage() {
        XCTAssertEqual(WebImageRect.viewRect(css: CGRect(x: 150, y: 420, width: 100, height: 60), pageZoom: 1, magnification: 1),
                       CGRect(x: 150, y: 420, width: 100, height: 60))
        // Text zoom 1.25, page scrolled by 300: getBoundingClientRect said (150, 120).
        XCTAssertEqual(WebImageRect.viewRect(css: CGRect(x: 150, y: 120, width: 100, height: 60), pageZoom: 1.25, magnification: 1),
                       CGRect(x: 187.5, y: 150, width: 125, height: 75))
        // Text zoom 0.8 and a pinch to 1.5: drawn at (180, 504), 120 × 72.
        let pinched = WebImageRect.viewRect(css: CGRect(x: 150, y: 420, width: 100, height: 60), pageZoom: 0.8, magnification: 1.5)
        XCTAssertEqual(pinched.minX, 180, accuracy: 0.001)
        XCTAssertEqual(pinched.minY, 504, accuracy: 0.001)
        XCTAssertEqual(pinched.width, 120, accuracy: 0.001)
        XCTAssertEqual(pinched.height, 72, accuracy: 0.001)
    }

    func testAPictureMostlyScrolledAwayIsNotZoomedInto() {
        let page = CGRect(x: 0, y: 0, width: 800, height: 600)
        XCTAssertTrue(WebImageRect.isVisible(CGRect(x: 100, y: 500, width: 200, height: 160), in: page))
        XCTAssertFalse(WebImageRect.isVisible(CGRect(x: 100, y: 560, width: 200, height: 160), in: page))
        XCTAssertFalse(WebImageRect.isVisible(CGRect(x: 100, y: 700, width: 200, height: 160), in: page))
        XCTAssertEqual(WebImageRect.visibleFraction(of: .zero, in: page), 0)
    }
}

final class ImageViewerOrderingTests: XCTestCase {
    /// Two table rows of before | after, then a picture outside any table, then a repeat of one file.
    private let items = [
        ImageViewerItem(id: "0", path: "/v/01-before.png", group: "r0"),
        ImageViewerItem(id: "1", path: "/v/01-after.png", group: "r0"),
        ImageViewerItem(id: "2", path: "/v/02-before.png", group: "r1"),
        ImageViewerItem(id: "3", path: "/v/02-after.png", group: "r1"),
        ImageViewerItem(id: "4", path: "/v/diagram.png"),
        ImageViewerItem(id: "5", path: "/v/01-after.png"),
    ]

    func testTheAfterInTheSameRowComesFirstThenTheRestInDocumentOrder() {
        let picks = ImageViewerOrdering.compareCandidates(items, current: items[2])
        XCTAssertEqual(picks.sameRow.map(\.id), ["3"])
        XCTAssertEqual(picks.others.map(\.id), ["0", "1", "4"], "the current file and a repeated file are left out")
        let outside = ImageViewerOrdering.compareCandidates(items, current: items[4])
        XCTAssertEqual(outside.sameRow.map(\.id), [])
        XCTAssertEqual(outside.others.map(\.id), ["0", "1", "2", "3"])
    }

    func testArrowsMoveAPairToTheNextRowKeepingEachPicturesPlace() {
        XCTAssertTrue(ImageViewerOrdering.stepPair(items, a: 0, b: 1, by: 1)! == (2, 3))
        XCTAssertTrue(ImageViewerOrdering.stepPair(items, a: 3, b: 2, by: -1)! == (1, 0), "after | before stays after | before")
        XCTAssertNil(ImageViewerOrdering.stepPair(items, a: 2, b: 3, by: 1), "no later row has both places")
        // A pair from different rows moves A and keeps B.
        XCTAssertTrue(ImageViewerOrdering.stepPair(items, a: 0, b: 3, by: 1)! == (1, 3))
        XCTAssertNil(ImageViewerOrdering.stepPair(items, a: 5, b: 3, by: 1))
    }
}

@MainActor
final class ImageViewerKeysTests: XCTestCase {
    private func viewerKeys() -> Keymap {
        Keymap(library: ImageViewerKeymap.library, store: nil, layout: TableKeyLayout.us)
    }

    private func action(_ code: UInt16, _ chars: String? = nil, _ flags: NSEvent.ModifierFlags = [], picking: Bool = false,
                        comparing: Bool = false) -> ImageViewerAction?
    {
        ImageViewerKeys.action(keyCode: code, characters: chars, modifiers: flags, picking: picking, comparing: comparing,
                               keymap: viewerKeys())
    }

    func testTheViewerKeys() {
        XCTAssertEqual(action(53), .dismiss)
        XCTAssertEqual(action(123), .previous)
        XCTAssertEqual(action(124), .next)
        XCTAssertEqual(action(24, "=", .command), .zoomIn)
        XCTAssertEqual(action(24, "+", [.command, .shift]), .zoomIn)
        XCTAssertEqual(action(27, "-", .command), .zoomOut)
        XCTAssertEqual(action(29, "0", .command), .fit)
        XCTAssertEqual(action(18, "1", .command), .actualSize)
        XCTAssertEqual(action(8, "c", .command), .copy)
        // Czech: the 1 key prints "+" (zoom in, as printed), the 0 key prints "é" (fit, by its place).
        XCTAssertEqual(action(18, "+", .command), .zoomIn)
        XCTAssertEqual(action(29, "é", .command), .fit)
        XCTAssertNil(action(123, nil, .option), "⌥← moves the divider only while comparing")
        XCTAssertEqual(action(123, nil, .option, comparing: true), .divider(-0.05))
        XCTAssertEqual(action(124, nil, [.option, .shift], comparing: true), .divider(0.01))
        XCTAssertNil(action(0, "a"), "other keys stay with the app")
    }

    func testThePickerTakesTheArrowsAndReturn() {
        XCTAssertEqual(action(125, picking: true), .pickerMove(dx: 0, dy: 1))
        XCTAssertEqual(action(123, picking: true), .pickerMove(dx: -1, dy: 0))
        XCTAssertEqual(action(36, picking: true), .pickerChoose)
        XCTAssertEqual(action(53, picking: true), .dismiss)
    }

    func testTheViewerKeysHaveNoConflictOnACzechOrAUSKeyboard() {
        let czech = TableKeyLayout(
            [30: ")", 33: "ú", 18: "+", 19: "ě", 27: "=", 44: "-", 29: "é"],
            shifted: [30: "(", 33: "/", 18: "1", 29: "0"])
        XCTAssertEqual(Keymap(library: ImageViewerKeymap.library, store: nil, layout: czech).conflicts(), [])
        XCTAssertEqual(Keymap(library: ImageViewerKeymap.library, store: nil, layout: TableKeyLayout.us).conflicts(), [])
    }

    /// Command on the Czech "+" key zooms in. Shift Command on that key types "1", which is 100 %.
    func testCzechPlusZoomsInAndShiftedOneIsActualSize() {
        let czech = TableKeyLayout(
            [18: "+", 29: "é"],
            shifted: [18: "1", 29: "0"])
        let keys = Keymap(library: ImageViewerKeymap.library, store: nil, layout: czech)
        let plus = KeyStroke(keyCode: 18, character: "+", modifiers: .command)
        XCTAssertEqual(keys.commands(for: plus, in: [.window]).map(\.id), [ImageViewerKeymap.zoomIn])
        let one = KeyStroke(keyCode: 18, character: "1", modifiers: [.command, .shift])
        XCTAssertEqual(keys.commands(for: one, in: [.window]).map(\.id), [ImageViewerKeymap.actualSize])
        XCTAssertEqual(action(18, "+", .command), .zoomIn)
        XCTAssertEqual(action(18, "1", [.command, .shift]), .actualSize)
    }

    /// Shift on a picker key still moves it. Command stays on the window's keys. Shift on Escape still goes back.
    func testShiftOnAPickerKeyStillMovesAndCommandDoesNot() {
        XCTAssertEqual(action(123, nil, .shift, picking: true), .pickerMove(dx: -1, dy: 0))
        XCTAssertEqual(action(125, nil, .shift, picking: true), .pickerMove(dx: 0, dy: 1))
        XCTAssertNil(action(123, nil, .command, picking: true), "Command stays with the window keys")
        XCTAssertEqual(action(53, nil, .shift, picking: true), .dismiss)
    }

    /// Copy is also the US position of C, so a layout that types something else there still copies.
    func testCopyMatchesTheCKeyByPosition() {
        XCTAssertEqual(action(8, "x", .command), .copy)
    }

    /// Shift does not count for a digit. Shift Command 1 is 100 %, Shift Command 0 is fit.
    func testShiftCommandOnADigitIsTheSameAsCommand() {
        XCTAssertEqual(action(18, "1", [.command, .shift]), .actualSize)
        XCTAssertEqual(action(29, "0", [.command, .shift]), .fit)
    }

    func testEscStepsBackOneLayer() {
        let cache = MediaThumbnailCache(concurrency: 1, deadline: .seconds(1)) { _, _, _ in .failed("none") }
        let model = ImageViewerModel(
            items: [ImageViewerItem(id: "a", path: "/tmp/image-viewer-a.png"),
                    ImageViewerItem(id: "b", path: "/tmp/image-viewer-b.png")],
            selectedID: "a", cache: cache)
        var closed = 0
        model.onDismiss = { closed += 1 }

        model.openPicker()
        model.perform(.dismiss)
        XCTAssertFalse(model.picking, "Esc closes the picker first")
        XCTAssertEqual(closed, 0)

        model.compare(with: ImageViewerItem(id: "b", path: "/tmp/image-viewer-b.png"))
        model.perform(.dismiss)
        XCTAssertNil(model.compare, "the next Esc ends the compare")
        XCTAssertEqual(closed, 0)

        model.perform(.dismiss)
        XCTAssertEqual(closed, 1, "the next Esc closes the window")
    }

    /// Close is the window. It does not step back through the picker or the compare, which is Back.
    func testCloseDismissesTheWindowAndLeavesTheOpenLayer() {
        let cache = MediaThumbnailCache(concurrency: 1, deadline: .seconds(1)) { _, _, _ in .failed("none") }
        let model = ImageViewerModel(
            items: [ImageViewerItem(id: "a", path: "/tmp/image-viewer-a.png"),
                    ImageViewerItem(id: "b", path: "/tmp/image-viewer-b.png")],
            selectedID: "a", cache: cache)
        var closed = 0
        model.onDismiss = { closed += 1 }

        model.openPicker()
        model.perform(.close)
        XCTAssertTrue(model.picking, "Close leaves the picker open")
        XCTAssertEqual(closed, 1, "Close dismisses the window")

        model.compare(with: ImageViewerItem(id: "b", path: "/tmp/image-viewer-b.png"))
        model.perform(.close)
        XCTAssertNotNil(model.compare, "Close leaves the compare")
        XCTAssertEqual(closed, 2)
    }
}

final class ImageViewerPlacementTests: XCTestCase {
    func testTheRememberedSizeIsKeptWithinTheScreenAndCentred() {
        let visible = CGRect(x: 0, y: 25, width: 1728, height: 1092)
        let frame = ImageViewerPlacement.frame(remembered: CGSize(width: 1200, height: 800), visible: visible)
        XCTAssertEqual(frame.size, CGSize(width: 1200, height: 800))
        XCTAssertEqual(frame.midX, visible.midX, accuracy: 1)
        XCTAssertEqual(frame.midY, visible.midY, accuracy: 1)
        let huge = ImageViewerPlacement.frame(remembered: CGSize(width: 5000, height: 3000), visible: visible)
        XCTAssertEqual(huge.size, CGSize(width: 1648, height: 1012))
        let tiny = ImageViewerPlacement.frame(remembered: CGSize(width: 100, height: 100), visible: visible)
        XCTAssertEqual(tiny.size, ImageViewerPlacement.minSize)
        XCTAssertEqual(ImageViewerPlacement.frame(remembered: nil, visible: visible).width, (1728 * 0.82).rounded())
    }
}

final class MediaDataURLTests: XCTestCase {
    private let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

    func testOnlyBase64ImagesOfAnAllowedTypeAreDecoded() throws {
        let decoded = try XCTUnwrap(MediaDataURL.decode("data:image/png;base64,\(png)"))
        XCTAssertEqual(decoded.ext, "png")
        XCTAssertEqual(decoded.data.prefix(4), Data([0x89, 0x50, 0x4E, 0x47]))
        XCTAssertNotNil(MediaDataURL.decode("DATA:Image/PNG;charset=x;BASE64,\(png)"))
        XCTAssertNil(MediaDataURL.decode("data:text/html;base64,PHNjcmlwdD4="), "not an image")
        XCTAssertNil(MediaDataURL.decode("data:image/png,\(png)"), "not base64")
        XCTAssertNil(MediaDataURL.decode("data:image/x-icon;base64,\(png)"), "a type the host did not allow")
        XCTAssertNil(MediaDataURL.decode("https://example.org/x.png"))
        XCTAssertNil(MediaDataURL.decode("data:image/png;base64,\(png)", maxBytes: 10), "over the byte cap")
    }

    func testAnEmbeddedPictureIsWrittenOnceToAPrivateFile() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("imageviewer-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: folder) }
        let first = try XCTUnwrap(MediaDataURL.materialize("data:image/png;base64,\(png)", folder: folder))
        let again = try XCTUnwrap(MediaDataURL.materialize("data:image/png;base64,\(png)", folder: folder))
        XCTAssertEqual(first, again)
        XCTAssertEqual(first.pathExtension, "png")
        let mode = try XCTUnwrap(FileManager.default.attributesOfItem(atPath: first.path)[.posixPermissions] as? NSNumber)
        XCTAssertEqual(mode.intValue & 0o777, 0o600)
        XCTAssertNil(MediaDataURL.materialize("data:text/plain;base64,aGk=", folder: folder))
    }
}

/// Pictures the viewer tests draw: a tinted field with a grid and a label, so a snapshot shows which is which.
enum ImageViewerFixtures {
    static let folder: URL = {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("genesiskit-imageviewer-fixtures")
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }()

    /// The A picture: a 4112 × 2580 blue "before" (a Retina screenshot's size).
    static var before: URL { picture("before", width: 4112, height: 2580, tint: (0.16, 0.36, 0.78), label: "A · before") }
    /// The B picture: half the width and a little taller, in orange, so the compare scales it.
    static var after: URL { picture("after", width: 2056, height: 1340, tint: (0.86, 0.45, 0.14), label: "B · after") }
    static var diagram: URL { picture("diagram", width: 1200, height: 800, tint: (0.2, 0.6, 0.4), label: "diagram") }
    static var second: URL { picture("second-before", width: 2056, height: 1290, tint: (0.45, 0.3, 0.7), label: "second") }
    /// Two different screenshots of one size, as a note's before and after usually are.
    static var sameSizeOne: URL { picture("same-size-one", width: 3000, height: 2000, tint: (0.8, 0.2, 0.2), label: "one") }
    static var sameSizeTwo: URL { picture("same-size-two", width: 3000, height: 2000, tint: (0.2, 0.7, 0.3), label: "two") }

    static func picture(_ name: String, width: Int, height: Int, tint: (CGFloat, CGFloat, CGFloat), label: String) -> URL {
        let url = folder.appendingPathComponent("\(name)-\(width)x\(height).png")
        if FileManager.default.fileExists(atPath: url.path) { return url }
        let space = CGColorSpace(name: CGColorSpace.sRGB)!
        guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: space,
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return url }
        context.setFillColor(CGColor(red: tint.0, green: tint.1, blue: tint.2, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        context.setStrokeColor(CGColor(red: 1, green: 1, blue: 1, alpha: 0.18))
        context.setLineWidth(2)
        for x in stride(from: 0, to: width, by: 128) {
            context.stroke(CGRect(x: x, y: -2, width: 0, height: height + 4))
        }
        for y in stride(from: 0, to: height, by: 128) {
            context.stroke(CGRect(x: -2, y: y, width: width + 4, height: 0))
        }
        // A white band across the top third, so "top" is visible in a shot (CG draws bottom-up).
        context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 0.85))
        context.fill(CGRect(x: 0, y: CGFloat(height) * 0.86, width: CGFloat(width), height: CGFloat(height) * 0.14))
        let graphics = NSGraphicsContext(cgContext: context, flipped: false)
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = graphics
        let font = NSFont.systemFont(ofSize: CGFloat(height) * 0.09, weight: .bold)
        NSAttributedString(string: label, attributes: [.font: font, .foregroundColor: NSColor.black])
            .draw(at: CGPoint(x: CGFloat(width) * 0.04, y: CGFloat(height) * 0.875))
        NSGraphicsContext.restoreGraphicsState()
        if let image = context.makeImage(),
           let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)
        {
            CGImageDestinationAddImage(destination, image, nil)
            CGImageDestinationFinalize(destination)
        }
        return url
    }

    /// Two rows of before | after, then a diagram, in document order. `IMAGE_VIEWER_SNAPSHOT_IMAGES` (comma-separated
    /// paths, before and after alternating) replaces the drawn pictures with real ones for a visual check.
    static func items() -> [ImageViewerItem] {
        if let list = ProcessInfo.processInfo.environment["IMAGE_VIEWER_SNAPSHOT_IMAGES"], !list.isEmpty {
            let paths = list.split(separator: ",").map(String.init)
            return paths.enumerated().map { index, path in
                ImageViewerItem(id: "\(index)", path: path, group: "r\(index / 2)")
            }
        }
        return [
            ImageViewerItem(id: "0", path: before.path, name: "01-hub-before.png", group: "r0"),
            ImageViewerItem(id: "1", path: after.path, name: "01-hub-after.png", group: "r0"),
            ImageViewerItem(id: "2", path: second.path, name: "02-hub-before.png", group: "r1"),
            ImageViewerItem(id: "3", path: diagram.path, name: "02-hub-after.png", group: "r1"),
            ImageViewerItem(id: "4", path: diagram.path, name: "diagram.png"),
        ]
    }
}

final class ImageViewerDecodeTests: XCTestCase {
    func testTheViewerSeesARetinaScreenshotAtItsFullSizeWhileTilesKeepTheirCeiling() async throws {
        let path = ImageViewerFixtures.before.path
        let cache = MediaThumbnailCache(byteLimit: 256 << 20)
        guard case .ready(let full) = await cache.thumbnail(path: path, maxPixels: 4112, kind: .image,
                                                            ceiling: MediaThumbnailCache.largestCeiling) else {
            return XCTFail("the picture must decode")
        }
        XCTAssertEqual(full.image.width, 4112, "the 8192 bucket decodes the real pixels, never upscaled")
        XCTAssertEqual(full.sourceSize, CGSize(width: 4112, height: 2580))
        let tiles = MediaThumbnailCache(byteLimit: 256 << 20)
        guard case .ready(let tile) = await tiles.thumbnail(path: path, maxPixels: 90_000, kind: .image) else {
            return XCTFail("the picture must decode")
        }
        XCTAssertEqual(tile.image.width, 4096, "a caller that does not ask stays at the 4096 ceiling")
        XCTAssertEqual(MediaThumbnailCache.bucket(forPixels: 90_000, ceiling: 100_000), 8192)
    }
}

@MainActor
final class ImageViewerSnapshotTests: XCTestCase {
    private func color(_ result: ImageViewerSnapshot.Result, x: CGFloat, y: CGFloat) -> NSColor? {
        let scale = CGFloat(result.bitmap.pixelsWide) / result.bitmap.size.width
        return result.bitmap.colorAt(x: Int(x * scale), y: Int(y * scale))?.usingColorSpace(.sRGB)
    }

    private func isBlue(_ color: NSColor?) -> Bool {
        guard let color else { return false }
        return color.blueComponent > color.redComponent + 0.25
    }

    private func isOrange(_ color: NSColor?) -> Bool {
        guard let color else { return false }
        return color.redComponent > color.blueComponent + 0.3
    }

    /// Writes the PNG when `IMAGE_VIEWER_SNAPSHOT_DIR` is set: the way to look at each state without a window.
    private func write(_ result: ImageViewerSnapshot.Result, _ name: String) throws {
        guard let dir = ProcessInfo.processInfo.environment["IMAGE_VIEWER_SNAPSHOT_DIR"], !dir.isEmpty else { return }
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        let data = try XCTUnwrap(result.bitmap.representation(using: .png, properties: [:]))
        try data.write(to: URL(fileURLWithPath: dir).appendingPathComponent("image-viewer-\(name).png"))
    }

    private var drawnFixtures: Bool { ProcessInfo.processInfo.environment["IMAGE_VIEWER_SNAPSHOT_IMAGES"] == nil }

    private func shot(_ items: [ImageViewerItem], _ state: ImageViewerSnapshot.State) async throws -> ImageViewerSnapshot.Result {
        let result = await ImageViewerSnapshot.render(items: items, selectedID: "0", state: state)
        return try XCTUnwrap(result, "the viewer rendered \(state)")
    }

    func testSingleZoomedPickerAndCompareStatesRender() async throws {
        let items = ImageViewerFixtures.items()

        let single = try await shot(items, .single)
        try write(single, "1-single")
        XCTAssertTrue(single.titlebar.line.hasSuffix("; ok"), single.titlebar.line)
        XCTAssertTrue(single.titlebar.runs.contains { $0.kind == .content }, "the controls sit in the title bar: \(single.titlebar.line)")
        XCTAssertTrue(single.titlebar.runs.contains { $0.kind == .zone }, "the empty strip zooms and drags: \(single.titlebar.line)")
        XCTAssertEqual(single.model.readout.isFit, true)
        let picture = try XCTUnwrap(single.pictureA)
        XCTAssertGreaterThan(picture.width, single.canvas.width * 0.8, "a wide screenshot fills the canvas width")
        if drawnFixtures {
            XCTAssertTrue(isBlue(color(single, x: picture.minX + picture.width * 0.2, y: picture.minY + picture.height * 0.7)))
            // The white band is the picture's top: the canvas draws it the right way up.
            let top = color(single, x: picture.midX, y: picture.minY + picture.height * 0.03)
            XCTAssertGreaterThan(top?.greenComponent ?? 0, 0.7, "the top band is at the top")
        }

        let zoomed = try await shot(items, .zoomed(multiple: 1, anchor: CGPoint(x: 0.3, y: 0.4)))
        try write(zoomed, "2-zoomed-100")
        XCTAssertEqual(zoomed.model.readout.percent, 100)
        let big = try XCTUnwrap(zoomed.pictureA)
        let backing = CGFloat(zoomed.bitmap.pixelsWide) / zoomed.bitmap.size.width
        XCTAssertEqual(big.width, 4112 / backing, accuracy: 1, "100 % is one image pixel per display pixel")

        let picker = try await shot(items, .picker)
        try write(picker, "3-picker")
        XCTAssertTrue(picker.model.picking)
        XCTAssertEqual(picker.model.pickerItems.sameRow.map(\.id), ["1"], "the after of the same row comes first")

        let slider = try await shot(items, .compare(bID: "1", mode: .slider, divider: 0.5))
        try write(slider, "4-compare-slider")
        XCTAssertEqual(slider.model.compare?.mode, .slider)
        if drawnFixtures {
            XCTAssertNotNil(slider.model.compareNote, "B is half A's width, so the bar says it is scaled")
            let mid = slider.canvas.midY + 60
            XCTAssertTrue(isBlue(color(slider, x: slider.canvas.minX + slider.canvas.width * 0.25, y: mid)), "A left of the divider")
            XCTAssertTrue(isOrange(color(slider, x: slider.canvas.minX + slider.canvas.width * 0.75, y: mid)), "B right of it")
        }

        let sideBySide = try await shot(items, .compare(bID: "1", mode: .sideBySide, divider: 0.5))
        try write(sideBySide, "5-compare-side-by-side")
        if drawnFixtures {
            let mid = sideBySide.canvas.midY + 30
            XCTAssertTrue(isBlue(color(sideBySide, x: sideBySide.canvas.minX + sideBySide.canvas.width * 0.25, y: mid)))
            XCTAssertTrue(isOrange(color(sideBySide, x: sideBySide.canvas.minX + sideBySide.canvas.width * 0.75, y: mid)))
        }
    }

    /// How many points of `region` (top-left, in the bitmap's points) are not the canvas colour: ink of any kind.
    private func inkCount(_ result: ImageViewerSnapshot.Result, in region: CGRect) -> Int {
        let canvas = result.canvas
        guard let background = color(result, x: canvas.midX + canvas.width * 0.25, y: canvas.maxY - 30) else { return 0 }
        var count = 0
        for y in stride(from: region.minY, to: region.maxY, by: 1) {
            for x in stride(from: region.minX, to: region.maxX, by: 1) {
                guard let pixel = color(result, x: x, y: y) else { continue }
                let distance = abs(pixel.redComponent - background.redComponent)
                    + abs(pixel.greenComponent - background.greenComponent)
                    + abs(pixel.blueComponent - background.blueComponent)
                if distance > 0.12 { count += 1 }
            }
        }
        return count
    }

    private func brokenPictures() throws -> (folder: URL, missing: URL, unreadable: URL) {
        let folder = ImageViewerFixtures.folder.appendingPathComponent("broken-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let unreadable = folder.appendingPathComponent("not-a-picture.png")
        try Data("this is not an image".utf8).write(to: unreadable)
        return (folder, folder.appendingPathComponent("gone.png"), unreadable)
    }

    /// Picture B is compared on the right of the divider, or in the right pane. When it cannot load, that region says
    /// why and offers Retry, as picture A's does for the whole canvas.
    func testAComparisonPictureThatFailsToLoadSaysSoInItsOwnRegion() async throws {
        let broken = try brokenPictures()
        defer { try? FileManager.default.removeItem(at: broken.folder) }
        for (label, file) in [("missing", broken.missing), ("undecodable", broken.unreadable)] {
            let items = [ImageViewerItem(id: "0", path: ImageViewerFixtures.diagram.path),
                         ImageViewerItem(id: "1", path: file.path)]
            for mode in [ImageViewerModel.CompareMode.slider, .sideBySide] {
                let result = try await shot(items, .compare(bID: "1", mode: mode, divider: 0.5))
                try write(result, "6-compare-b-\(label)-\(mode)")
                guard case .failed = result.model.stateB else { XCTFail("\(label) B must fail to load"); continue }
                let canvas = result.canvas
                let region = CGRect(x: canvas.minX + canvas.width * 0.58, y: canvas.midY - 80,
                                    width: canvas.width * 0.34, height: 160)
                XCTAssertGreaterThan(inkCount(result, in: region), 40, "\(label) B in \(mode): its reason and Retry are drawn")
            }
        }
    }

    func testRetryingAFailedComparisonPictureLoadsItOnceTheFileIsBack() async throws {
        let broken = try brokenPictures()
        defer { try? FileManager.default.removeItem(at: broken.folder) }
        let items = [ImageViewerItem(id: "0", path: ImageViewerFixtures.diagram.path),
                     ImageViewerItem(id: "1", path: broken.missing.path)]
        let result = try await shot(items, .compare(bID: "1", mode: .slider, divider: 0.5))
        guard case .failed = result.model.stateB else { return XCTFail("B must fail to load") }

        try FileManager.default.copyItem(at: ImageViewerFixtures.after, to: broken.missing)
        result.model.retry(.b)
        await result.model.waitUntilLoaded()

        XCTAssertTrue(result.model.stateB.isReady, "\(result.model.stateB)")
        XCTAssertNotNil(result.model.canvas.pictureB)
    }

    /// A render closes its window, and a closing viewer remembers its size for the next one: a fixture window must not.
    func testARenderLeavesTheRememberedViewerSizeAlone() async throws {
        let defaults = UserDefaults.standard
        let key = ImageViewer.sizeKey
        let before = defaults.object(forKey: key)
        defer {
            if let before { defaults.set(before, forKey: key) } else { defaults.removeObject(forKey: key) }
        }
        let items = [ImageViewerItem(id: "0", path: ImageViewerFixtures.diagram.path)]

        defaults.set("{777, 555}", forKey: key)
        _ = try await shot(items, .single)
        XCTAssertEqual(defaults.string(forKey: key), "{777, 555}", "a render must not overwrite the size the user left")

        defaults.removeObject(forKey: key)
        _ = try await shot(items, .single)
        XCTAssertNil(defaults.object(forKey: key), "a render must not invent a remembered size")
    }

    /// Every pinch, scroll and drag only moves layer frames; one step must leave most of a 60 Hz frame free.
    func testZoomAndPanOnALargeScreenshotCostLessThanAFrame() async throws {
        let items = [ImageViewerItem(id: "0", path: ImageViewerFixtures.before.path),
                     ImageViewerItem(id: "1", path: ImageViewerFixtures.after.path)]
        let hosted = await ImageViewerSnapshot.host(items: items, selectedID: "0", size: CGSize(width: 1180, height: 760))
        let controller = try XCTUnwrap(hosted)
        defer { controller.closeNow() }
        let canvas = controller.model.canvas
        var steps: [Double] = []
        for step in 0..<240 {
            let anchor = CGPoint(x: 200 + CGFloat(step % 7) * 90, y: 150 + CGFloat(step % 5) * 80)
            let started = CACurrentMediaTime()
            if step % 3 == 2 {
                canvas.pan(by: CGSize(width: step % 2 == 0 ? 14 : -11, height: 9))
            } else {
                canvas.zoom(to: canvas.zoom.scale * (step < 120 ? 1.03 : 0.97), anchor: anchor, animated: false)
            }
            CATransaction.flush()
            steps.append((CACurrentMediaTime() - started) * 1000)
        }
        // The same with the slider on: two pictures and the mask move together.
        controller.model.compare(with: items[1])
        await controller.model.waitUntilLoaded()
        for step in 0..<120 {
            let started = CACurrentMediaTime()
            canvas.zoom(to: canvas.zoom.scale * (step < 60 ? 1.03 : 0.97), anchor: CGPoint(x: 400, y: 300), animated: false)
            canvas.setDivider(0.3 + CGFloat(step % 40) / 100, notify: true)
            CATransaction.flush()
            steps.append((CACurrentMediaTime() - started) * 1000)
        }
        let sorted = steps.sorted()
        let p50 = sorted[sorted.count / 2]
        let p95 = sorted[Int(Double(sorted.count) * 0.95)]
        print(String(format: "image viewer zoom/pan step on 4112 × 2580: p50 %.3f ms, p95 %.3f ms, max %.3f ms (%d steps)",
                     p50, p95, sorted.last ?? 0, sorted.count))
        if timingRun {
            XCTAssertLessThan(p95, 4, "a zoom or pan step must leave most of a 16.7 ms frame free")
        }
    }

    /// A second double-click while the first viewer still waits for its picture goes to that viewer, which stays off
    /// screen until its reveal; once a viewer is closing, the next request opens a new one.
    func testANewRequestGoesToTheViewerStillOpeningAndNeverToOneClosing() throws {
        let owner = ObjectIdentifier(self)
        let first = [ImageViewerItem(id: "0", path: ImageViewerFixtures.diagram.path)]
        let second = [ImageViewerItem(id: "1", path: ImageViewerFixtures.before.path)]
        let controller = ImageViewerWindowController(
            request: ImageViewerRequest(ownerID: owner, items: first, selectedID: "0"),
            frame: CGRect(x: -30000, y: -30000, width: 1180, height: 760))
        controller.remembersSize = false
        ImageViewer.controllers[owner] = controller
        defer {
            controller.closeNow()
            ImageViewer.controllers[owner] = nil
        }
        let window = try XCTUnwrap(controller.window)
        XCTAssertFalse(window.isVisible, "an opening viewer is not on screen yet")

        XCTAssertTrue(ImageViewer.reusableViewer(for: owner) === controller, "the opening viewer takes the request")
        controller.replace(ImageViewerRequest(ownerID: owner, items: second, selectedID: "1"))
        XCTAssertEqual(controller.model.current?.id, "1")
        XCTAssertFalse(window.isVisible, "the replaced request still waits for the reveal")

        XCTAssertFalse(controller.windowShouldClose(window), "the close animates first")
        XCTAssertTrue(controller.isClosing)
        XCTAssertNil(ImageViewer.reusableViewer(for: owner), "a closing viewer takes no new request")
    }

    /// The source page closes while the open still waits for the picture: the viewer stays closed.
    func testAViewerClosedWhileItsOpenWaitsForThePictureNeverShows() async throws {
        let owner = ObjectIdentifier(self)
        let controller = ImageViewerWindowController(
            request: ImageViewerRequest(
                ownerID: owner, items: [ImageViewerItem(id: "0", path: ImageViewerFixtures.diagram.path)], selectedID: "0"),
            frame: CGRect(x: -30000, y: -30000, width: 1180, height: 760))
        controller.remembersSize = false
        ImageViewer.controllers[owner] = controller
        defer { ImageViewer.controllers[owner] = nil }
        let window = try XCTUnwrap(controller.window)

        controller.open()
        controller.closeNow()
        try await Task.sleep(for: ImageViewer.decodeWait + .milliseconds(400))

        XCTAssertFalse(window.isVisible, "a closed viewer must not come back when its open finishes")
        XCTAssertNil(ImageViewer.controllers[owner])
    }

    /// The source goes away while the close still asks where the picture is: the late answer starts no flight.
    func testAnAnswerThatArrivesAfterAnImmediateCloseStartsNoCloseFlight() async throws {
        try XCTSkipIf(GenMotion.systemReduceMotion, "with Reduce Motion the close fades and never asks for the origin")
        var release: CheckedContinuation<Void, Never>?
        let asked = expectation(description: "the close asked where the picture is")
        let request = ImageViewerRequest(
            ownerID: ObjectIdentifier(self), items: [ImageViewerItem(id: "0", path: ImageViewerFixtures.diagram.path)],
            selectedID: "0",
            currentOrigin: { _ in
                await withCheckedContinuation { continuation in
                    release = continuation
                    asked.fulfill()
                }
                return ImageViewerOrigin(rect: CGRect(x: -29000, y: -29000, width: 80, height: 60),
                                         clip: CGRect(x: -29000, y: -29000, width: 80, height: 60))
            })
        let controller = ImageViewerWindowController(request: request,
                                                     frame: CGRect(x: -30000, y: -30000, width: 1180, height: 760))
        controller.remembersSize = false
        let window = try XCTUnwrap(controller.window)
        window.alphaValue = 0
        window.orderFrontRegardless()
        controller.model.start()
        await controller.model.waitUntilLoaded()
        XCTAssertNotNil(controller.model.canvas.pictureA?.image, "a loaded picture is what a close flight would carry")

        XCTAssertFalse(controller.windowShouldClose(window), "the close animates first")
        await fulfillment(of: [asked], timeout: 5)
        controller.closeNow()
        release?.resume()
        try await Task.sleep(for: .milliseconds(300))

        XCTAssertFalse(controller.model.canvas.picturesHidden, "no close flight starts for a viewer already closed")
        XCTAssertFalse(window.isVisible)
    }

    /// The window is built and laid out before the motion starts; this is that cost.
    func testTheViewerWindowIsBuiltAndLaidOutQuickly() async throws {
        let items = [ImageViewerItem(id: "0", path: ImageViewerFixtures.diagram.path)]
        var timings: [Double] = []
        for _ in 0..<3 {
            let started = CACurrentMediaTime()
            let request = ImageViewerRequest(ownerID: ObjectIdentifier(self), items: items, selectedID: "0")
            let controller = ImageViewerWindowController(request: request,
                                                         frame: CGRect(x: -30000, y: -30000, width: 1180, height: 760))
            controller.remembersSize = false
            controller.window?.alphaValue = 0
            controller.window?.layoutIfNeeded()
            controller.window?.contentView?.layoutSubtreeIfNeeded()
            timings.append((CACurrentMediaTime() - started) * 1000)
            XCTAssertGreaterThan(controller.model.canvas.bounds.width, 1000, "the canvas has its real size before the motion")
            controller.closeNow()
        }
        print(String(format: "image viewer build + layout: first %.1f ms, then %.1f ms, %.1f ms", timings[0], timings[1], timings[2]))
        if timingRun {
            XCTAssertLessThan(timings[1], 60)
        }

        // The spare the first click builds: the open only adopts the request and lays the window out again.
        ImageViewer.makeSpare()
        let spare = try XCTUnwrap(ImageViewer.spare)
        ImageViewer.spare = nil
        spare.remembersSize = false
        defer { spare.closeNow() }
        let started = CACurrentMediaTime()
        spare.adopt(ImageViewerRequest(ownerID: ObjectIdentifier(self), items: items, selectedID: "0"))
        spare.window?.layoutIfNeeded()
        spare.window?.contentView?.layoutSubtreeIfNeeded()
        let adopt = (CACurrentMediaTime() - started) * 1000
        print(String(format: "image viewer spare adopt + layout: %.1f ms", adopt))
        XCTAssertEqual(spare.model.current?.id, "0")
        XCTAssertGreaterThan(spare.model.canvas.bounds.width, 600)
        if timingRun {
            XCTAssertLessThan(adopt, 30)
        }
    }
}

@MainActor
final class ImageViewerNavigationTests: XCTestCase {
    private func hosted(_ items: [ImageViewerItem]) async throws -> ImageViewerWindowController {
        let host = await ImageViewerSnapshot.host(items: items, selectedID: "0", size: CGSize(width: 1180, height: 760))
        let controller = try XCTUnwrap(host)
        let canvas = controller.model.canvas
        XCTAssertLessThan(canvas.fitScale, canvas.actualScale, "the pictures are bigger than the canvas")
        return controller
    }

    private func sameSizeItems() -> [ImageViewerItem] {
        [ImageViewerItem(id: "0", path: ImageViewerFixtures.sameSizeOne.path),
         ImageViewerItem(id: "1", path: ImageViewerFixtures.sameSizeTwo.path)]
    }

    /// A decode the test lets finish when it chooses; the first call only.
    private final class DecodeGate: @unchecked Sendable {
        private let lock = NSLock()
        private var calls = 0
        private var gate: CheckedContinuation<Void, Never>?
        var isHeld: Bool { lock.withLock { gate != nil } }
        func isFirstCall() -> Bool { lock.withLock { calls += 1; return calls == 1 } }
        func hold() async { await withCheckedContinuation { gate in lock.withLock { self.gate = gate } } }
        func release() { lock.withLock { gate }?.resume() }
    }

    private static let pixel: CGImage = {
        let context = CGContext(data: nil, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
                                space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        return context!.makeImage()!
    }()

    /// A zoom while the next picture still loads asks for more pixels of the previous one. That must not cancel the
    /// new picture's load: once the sharper request failed, the new picture stayed loading for good.
    func testAZoomWhileTheNextPictureLoadsNeverStrandsIt() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("viewer-sharpen-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let paths = try ["first.png", "next.png"].map { name in
            let url = directory.appendingPathComponent(name)
            try MediaThumbnailCacheTests.writePNG(url, width: 8, height: 8, color: CGColor(red: 0, green: 0, blue: 1, alpha: 1))
            return url.path
        }
        let size = CGSize(width: 4000, height: 3000)
        let gate = DecodeGate()
        let cache = MediaThumbnailCache(concurrency: 2, deadline: .seconds(5)) { path, _, _ in
            let picture = MediaThumbnail(image: Self.pixel, kind: .image, sourceSize: size, duration: nil)
            guard path.hasSuffix("next.png") else { return .ready(picture) }
            guard gate.isFirstCall() else { return .failed("the sharper decode failed") }
            await gate.hold()
            return .ready(picture)
        }
        let model = ImageViewerModel(
            items: [ImageViewerItem(id: "0", path: paths[0]), ImageViewerItem(id: "1", path: paths[1])], selectedID: "0",
            cache: cache)
        model.start()
        _ = await model.waitUntilLoaded(timeout: .seconds(2))
        XCTAssertEqual(model.canvas.pictureA?.id, "0")

        model.step(1)
        let deadline = ContinuousClock.now + .seconds(2)
        while !gate.isHeld, ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(5)) }
        XCTAssertTrue(gate.isHeld, "the next picture's load is under way")
        model.canvas.onNeedsPixels?(.a, 6000)
        gate.release()
        _ = await model.waitUntilLoaded(timeout: .seconds(2))

        XCTAssertEqual(model.stateA, .ready(pixelSize: size), "the next picture finished loading")
        XCTAssertEqual(model.canvas.pictureA?.id, "1")
    }

    func testSteppingToAnotherPictureOfTheSameSizeStartsFitted() async throws {
        let controller = try await hosted(sameSizeItems())
        defer { controller.closeNow() }
        let model = controller.model
        let canvas = model.canvas
        let first = canvas.pictureA?.image
        canvas.zoom(to: canvas.actualScale, anchor: CGPoint(x: 300, y: 200), animated: false)
        XCTAssertTrue(canvas.userZoomed)

        model.step(1)
        await model.waitUntilLoaded()

        XCTAssertEqual(model.current?.id, "1")
        XCTAssertNotNil(canvas.pictureA?.image)
        XCTAssertFalse(canvas.pictureA?.image === first, "the second picture is on the canvas")
        XCTAssertFalse(canvas.userZoomed, "another picture starts fitted, as one of another size does")
        XCTAssertEqual(canvas.zoom.scale, canvas.fitScale, accuracy: 0.0001)
        XCTAssertTrue(model.readout.isFit)
    }

    func testASharperDecodeOfThePictureShownKeepsTheZoomAndPan() async throws {
        let controller = try await hosted(sameSizeItems())
        defer { controller.closeNow() }
        let canvas = controller.model.canvas
        let shown = try XCTUnwrap(canvas.pictureA)
        canvas.zoom(to: canvas.actualScale, anchor: CGPoint(x: 300, y: 200), animated: false)
        canvas.pan(by: CGSize(width: 40, height: 25))
        let viewport = canvas.zoom
        XCTAssertTrue(canvas.userZoomed)

        canvas.setPicture(.a, id: "0", image: shown.image, pixelSize: shown.pixelSize)

        XCTAssertTrue(canvas.userZoomed, "the same picture, sharper, stays where the reader put it")
        XCTAssertEqual(canvas.zoom, viewport)
    }

    func testSwappingTwoPicturesOfTheSameSizeStartsBothFitted() async throws {
        let controller = try await hosted(sameSizeItems())
        defer { controller.closeNow() }
        let model = controller.model
        let canvas = model.canvas
        model.compare(with: model.items[1])
        await model.waitUntilLoaded()
        canvas.zoom(to: canvas.actualScale, anchor: CGPoint(x: 300, y: 200), animated: false)
        XCTAssertTrue(canvas.userZoomed)

        model.swap()
        await model.waitUntilLoaded()

        XCTAssertEqual(model.current?.id, "1")
        XCTAssertEqual(model.itemB?.id, "0")
        XCTAssertFalse(canvas.userZoomed)
        XCTAssertEqual(canvas.zoom.scale, canvas.fitScale, accuracy: 0.0001)
    }
}

private func == (lhs: (a: Int, b: Int), rhs: (Int, Int)) -> Bool {
    lhs.a == rhs.0 && lhs.b == rhs.1
}
