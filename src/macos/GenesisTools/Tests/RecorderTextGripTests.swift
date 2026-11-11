import AppKit
import CoreGraphics
import CoreImage
import XCTest
@testable import GenesisToolsRecorder

/// The Text tab's grip on the preview sits on the plate the renderer draws: for every alignment, at the canvas's edges
/// and for a text of two lines. Before 2026-11-08 it sat at the text's x, y, the centre of its block, so a left- or
/// right-aligned text (whose plate starts or ends at the block's edge) had its grip beside the plate.
final class RecorderTextGripTests: XCTestCase {
    /// The picture the test renders, as the preview's player does at a smaller size than the export's canvas.
    private let size = CGSize(width: 960, height: 540)
    private let context = CIContext()

    private func note(_ text: String = "Invoices", align: EditProject.TextAlign?, x: Double = 0.62, y: Double = 0.5,
                      size: Double = 0.05, animate: EditProject.TextAnimate? = nil) -> EditProject.TextNote {
        EditProject.TextNote(id: "t", startUs: 0, endUs: 10_000_000, text: text, x: x, y: y, size: size, animate: animate,
                             block: align.map { EditProject.TextBlock(width: 0.4, align: $0) })
    }

    /// A callout so long that its plate is more than twice the canvas's height: textOrigin keeps it at the bottom, so
    /// it runs out of the top and its centre lies above the picture. Its lines are set by "\n" and fit the block on
    /// both canvases the grip test measures, so the two plates have the same lines and only scale.
    private var overflowing: EditProject.TextNote {
        note(Array(repeating: "Send and track", count: 50).joined(separator: "\n"), align: .left, x: 0.5)
    }

    /// The cases the grip must follow: each alignment, a plate kept inside at the left and at the right edge, a text
    /// of two lines, and a slide-up text at rest.
    private var cases: [(name: String, note: EditProject.TextNote)] {
        [
            ("left", note(align: .left)),
            ("center", note(align: .center)),
            ("right", note(align: .right)),
            ("no block", note(align: nil)),
            ("kept inside at the left edge", note(align: .left, x: 0.1)),
            ("kept inside at the right edge", note(align: .right, x: 0.95)),
            ("two lines", note("Send, track\nand get paid", align: .left, x: 0.3, y: 0.3)),
            ("slide-up at rest", note(align: .right, x: 0.5, y: 0.7, animate: EditProject.TextAnimate(kind: .slideUp, ms: 600))),
            ("taller than twice the canvas", overflowing),
        ]
    }

    /// The box of the pixels the plate darkened on a white canvas, in Core Image space (y up), read from the picture.
    private func drawnPlate(_ note: EditProject.TextNote) throws -> CGRect {
        let white = CIImage(color: .white).cropped(to: CGRect(origin: .zero, size: size))
        let drawn = Looks.drawText(note, opacity: 1, plates: TextPlates(), on: white, size: size, sinceUs: 5_000_000)
        let image = try XCTUnwrap(context.createCGImage(drawn, from: CGRect(origin: .zero, size: size)))
        let width = Int(size.width), height = Int(size.height)
        var pixels = [UInt8](repeating: 0, count: 4 * width * height)
        var minX = width, maxX = -1, minRow = height, maxRow = -1
        pixels.withUnsafeMutableBytes { buffer in
            guard let bitmap = CGContext(data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 4 * width,
                                         space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
            else { return }
            bitmap.draw(image, in: CGRect(origin: .zero, size: size))
            // A bitmap's first row is the picture's top. The plate darkens white to about 145 (Core Image blends in
            // linear light); the text on it stays light, inside the plate's box.
            for row in 0..<height {
                let start = 4 * row * width
                for column in 0..<width where buffer[start + 4 * column] < 200 {
                    minX = min(minX, column)
                    maxX = max(maxX, column)
                    minRow = min(minRow, row)
                    maxRow = max(maxRow, row)
                }
            }
        }
        XCTAssertGreaterThanOrEqual(maxX, 0, "the plate was drawn")
        return CGRect(x: minX, y: height - 1 - maxRow, width: maxX - minX + 1, height: maxRow - minRow + 1)
    }

    /// The grip, a share of the picture from its top left, in Core Image's bottom-up pixels of `size`.
    private func gripPixel(_ note: EditProject.TextNote, canvas: CGSize) -> CGPoint {
        let grip = TextGrip.point(note, canvas: canvas)
        return CGPoint(x: grip.x * size.width, y: (1 - grip.y) * size.height)
    }

    func testTheGripSitsOnThePlateTheRendererDraws() throws {
        for (name, note) in cases {
            let plate = try drawnPlate(note)
            let point = gripPixel(note, canvas: size)
            XCTAssertTrue(plate.contains(point), "\(name): the grip at \(point) is off the plate drawn at \(plate)")
            // The editor measures on the export's canvas while the preview renders smaller: still on the plate.
            let measured = gripPixel(note, canvas: CGSize(width: size.width * 2, height: size.height * 2))
            XCTAssertTrue(plate.insetBy(dx: 4, dy: 4).contains(measured), "\(name): measured on a larger canvas, the grip at \(measured) leaves \(plate)")
            XCTAssertEqual(measured.x, point.x, accuracy: 2, name)
            XCTAssertEqual(measured.y, point.y, accuracy: 2, name)
        }
    }

    /// textPlateRect is the box drawText really composites the plate in, to the pixel. Only its part inside the canvas
    /// can show, which is the whole box for every case but the overflowing one.
    func testThePlateRectIsWhereDrawTextCompositesThePlate() throws {
        for (name, note) in cases {
            let drawn = try drawnPlate(note)
            let rect = try XCTUnwrap(Looks.textPlateRect(note, size: size), name).intersection(CGRect(origin: .zero, size: size))
            XCTAssertEqual(rect.minX, drawn.minX, accuracy: 1, name)
            XCTAssertEqual(rect.maxX, drawn.maxX, accuracy: 1, name)
            XCTAssertEqual(rect.minY, drawn.minY, accuracy: 1, name)
            XCTAssertEqual(rect.maxY, drawn.maxY, accuracy: 1, name)
        }
    }

    /// The box of the pixels a plain text's white letters lit on a black canvas, in Core Image space (y up). A plain text
    /// draws no plate, so its letters are all a viewer sees of it.
    private func drawnLetters(_ note: EditProject.TextNote) throws -> CGRect {
        let black = CIImage(color: .black).cropped(to: CGRect(origin: .zero, size: size))
        let drawn = Looks.drawText(note, opacity: 1, plates: TextPlates(), on: black, size: size, sinceUs: 5_000_000)
        let width = Int(size.width), height = Int(size.height)
        var pixels = [UInt8](repeating: 0, count: 4 * width * height)
        context.render(drawn, toBitmap: &pixels, rowBytes: 4 * width, bounds: CGRect(origin: .zero, size: size), format: .RGBA8,
                       colorSpace: CGColorSpaceCreateDeviceRGB())
        var minX = width, maxX = -1, minRow = height, maxRow = -1
        for row in 0..<height {
            for column in 0..<width where pixels[4 * (row * width + column)] > 100 {
                minX = min(minX, column)
                maxX = max(maxX, column)
                minRow = min(minRow, row)
                maxRow = max(maxRow, row)
            }
        }
        XCTAssertGreaterThanOrEqual(maxX, 0, "the letters were drawn")
        // The bitmap's first row is the picture's top.
        return CGRect(x: minX, y: height - 1 - maxRow, width: maxX - minX + 1, height: maxRow - minRow + 1)
    }

    /// A plain text lines up its letters, not its plate (textOrigin), and the grip follows: it sits on the letters for
    /// every alignment and at the canvas's edges, where the plate nobody sees reaches past the picture.
    func testTheGripOfAPlainTextSitsOnItsLetters() throws {
        for (name, plate) in cases.filter({ $0.name != "taller than twice the canvas" }) {
            var note = plate
            note.style = .plain
            let letters = try drawnLetters(note)
            let point = gripPixel(note, canvas: size)
            XCTAssertTrue(letters.contains(point), "\(name): the grip at \(point) is off the letters drawn at \(letters)")
            let rect = try XCTUnwrap(Looks.textPlateRect(note, size: size), name)
            XCTAssertTrue(rect.contains(letters), "\(name): the letters at \(letters) are outside the plate rect \(rect)")
        }
    }

    /// A plate that runs out of the canvas keeps its grip on the part the preview shows: the overlay is not clipped to
    /// the picture, so a grip at the whole plate's centre drew above the preview.
    func testTheGripOfAnOverflowingPlateStaysOnThePicture() throws {
        let note = overflowing
        let rect = try XCTUnwrap(Looks.textPlateRect(note, size: size))
        XCTAssertGreaterThan(rect.height, 2 * size.height, "the case needs a plate more than twice the canvas's height")
        let grip = TextGrip.point(note, canvas: size)
        XCTAssertTrue(CGRect(x: 0, y: 0, width: 1, height: 1).contains(grip), "the grip at \(grip) is off the picture")
        XCTAssertTrue(try drawnPlate(note).contains(gripPixel(note, canvas: size)), "the grip is off the drawn plate")
    }

    /// The measure and the drawn plate share one layout, so their sizes never drift apart, whatever the colours.
    func testTheMeasureIsTheSizeOfTheDrawnPlate() throws {
        let plates = TextPlates()
        let texts = ["Invoices", "Send, track\nand get paid", String(repeating: "word ", count: 40).trimmingCharacters(in: .whitespaces)]
        for text in texts {
            for alignment: NSTextAlignment in [.left, .center, .right] {
                for plain in [false, true] {
                    let drawn = try XCTUnwrap(plates.plate(text, fontSize: 31, maxWidth: 500, plain: plain,
                                                           highlight: (3, .yellow), alignment: alignment))
                    XCTAssertEqual(TextPlates.measure(text, fontSize: 31, maxWidth: 500, alignment: alignment), drawn.extent.size,
                                   "\(text) \(alignment.rawValue) plain \(plain)")
                }
            }
        }
    }
}
