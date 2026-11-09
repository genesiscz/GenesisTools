import AppKit
import CoreGraphics
import CoreImage
import XCTest
@testable import GenesisToolsRecorder

/// A typewriter text types every letter where it rests. Before 2026-11-09 drawText laid out the typed prefix as a text
/// of its own, so a centred or right-aligned line sat in the prefix's narrower box: "Step 1" typed at the left edge of
/// a two-line text, slid right while line 2 typed, then jumped to its place. A partial word could also sit on another
/// line than the whole word, and a centred line moved a few pixels each time it ended in a space.
final class RecorderHuntTypewriterFullLayoutTests: XCTestCase {
    private let size = CGSize(width: 1280, height: 720)
    private let context = CIContext()
    private let typing = EditProject.TextAnimate(kind: .typewriter, ms: 2000)

    private func note(_ text: String, align: EditProject.TextAlign, width: Double = 0.8, style: EditProject.TextStyle = .plate) -> EditProject.TextNote {
        var note = EditProject.TextNote(id: "t", startUs: 0, endUs: 5_000_000, text: text, x: 0.5, y: 0.3, size: 0.055,
                                        animate: typing, block: EditProject.TextBlock(width: width, align: align))
        note.style = style
        return note
    }

    /// The time since its start at which the typewriter shows `characters` letters.
    private func sinceUs(typed characters: Int, of note: EditProject.TextNote) -> Int64 {
        Int64((Double(characters) - 0.5) / Double(note.text.count) * Double(typing.ms) * 1000)
    }

    /// The part of the canvas a test reads: the text's plate at rest and a few pixels round it, in whole pixels.
    private func region(_ note: EditProject.TextNote) throws -> CGRect {
        try XCTUnwrap(Looks.textPlateRect(note, size: size)).insetBy(dx: -8, dy: -8).intersection(CGRect(origin: .zero, size: size)).integral
    }

    /// The red channel of the drawn text on a canvas of one colour, inside `region`, row by row from its top.
    private func red(_ note: EditProject.TextNote, sinceUs: Int64, in region: CGRect, on color: CIColor = .black) -> [UInt8] {
        let canvas = CIImage(color: color).cropped(to: CGRect(origin: .zero, size: size))
        let drawn = Looks.drawText(note, opacity: 1, plates: TextPlates(), on: canvas, size: size, sinceUs: sinceUs)
        let width = Int(region.width), height = Int(region.height)
        var pixels = [UInt8](repeating: 0, count: 4 * width * height)
        context.render(drawn, toBitmap: &pixels, rowBytes: 4 * width, bounds: region, format: .RGBA8, colorSpace: CGColorSpaceCreateDeviceRGB())
        return stride(from: 0, to: pixels.count, by: 4).map { pixels[$0] }
    }

    /// The box (canvas space, y up) of the pixels that pass `lit`, in the rows `rows` of `region` (from its top).
    private func box(_ red: [UInt8], in region: CGRect, rows: Range<Int>? = nil, where lit: (UInt8) -> Bool) -> CGRect? {
        let width = Int(region.width), height = Int(region.height)
        var minX = width, maxX = -1, minRow = height, maxRow = -1
        for row in rows ?? 0..<height {
            for column in 0..<width where lit(red[row * width + column]) {
                minX = min(minX, column)
                maxX = max(maxX, column)
                minRow = min(minRow, row)
                maxRow = max(maxRow, row)
            }
        }
        guard maxX >= 0 else { return nil }
        return CGRect(x: region.minX + CGFloat(minX), y: region.minY + CGFloat(height - 1 - maxRow),
                      width: CGFloat(maxX - minX + 1), height: CGFloat(maxRow - minRow + 1))
    }

    /// The rows of the text's first line, from the top of `region`: one font size under the plate's top margin.
    private func firstLineRows(_ note: EditProject.TextNote, in region: CGRect) throws -> Range<Int> {
        let rest = try XCTUnwrap(Looks.textPlateRect(note, size: size))
        let fontSize = Looks.textPlateStyle(note, size: size).fontSize
        let top = Int(region.maxY - rest.maxY + TextPlates.inset(fontSize: fontSize).height)
        return top..<(top + Int(fontSize))
    }

    /// At every count of typed letters, each letter pixel lit while typing is lit in the finished text too, and the
    /// first line starts at the column where it rests.
    func testEveryTypedLetterIsDrawnWhereItRests() throws {
        let cases: [(name: String, note: EditProject.TextNote)] = [
            ("center", note("Step 1\nOpen the inbox and reply", align: .center)),
            ("right", note("Step 1\nOpen the inbox and reply", align: .right)),
            ("left", note("Step 1\nOpen the inbox and reply", align: .left)),
            ("plain center", note("Step 1\nOpen the inbox and reply", align: .center, style: .plain)),
            ("wrapped left", note("Open the inbox and reply to the client before noon", align: .left, width: 0.3)),
        ]
        for (name, note) in cases {
            let area = try region(note)
            let done = red(note, sinceUs: Int64(typing.ms) * 1000, in: area)
            let rows = try firstLineRows(note, in: area)
            let rest = try XCTUnwrap(box(done, in: area, rows: rows) { $0 > 200 }, "\(name): the first line was drawn")
            for characters in 1..<note.text.count {
                let since = sinceUs(typed: characters, of: note)
                XCTAssertEqual(TextMotion.at(sinceUs: since, note: note).characters, characters, "\(name): the case types \(characters)")
                let typed = red(note, sinceUs: since, in: area)
                let strays = zip(typed, done).filter { $0.0 > 200 && $0.1 < 100 }.count
                let line = try XCTUnwrap(box(typed, in: area, rows: rows) { $0 > 200 }, "\(name) \(characters): the first line was drawn")
                XCTAssertEqual(strays, 0, "\(name) \(characters) typed: \(strays) letter pixels lie where the finished text has none")
                XCTAssertEqual(line.minX, rest.minX, accuracy: 1,
                               "\(name) \(characters) typed: the first line starts at x \(line.minX), it rests at \(rest.minX)")
            }
        }
    }

    /// A plate text's plate still grows with the typing, around the letters typed so far: under a centred first line
    /// it is centred where that line rests, and a right-aligned one keeps its right edge; it ends on the typed lines.
    func testATypedPlateGrowsAroundTheTypedLetters() throws {
        for align in [EditProject.TextAlign.center, .right, .left] {
            let note = note("Step 1\nOpen the inbox and reply", align: align)
            let rest = try XCTUnwrap(Looks.textPlateRect(note, size: size))
            let area = try region(note)
            for characters in [7, 19] {
                let since = sinceUs(typed: characters, of: note)
                // The plate darkens a white canvas; its white letters stay white.
                let plate = try XCTUnwrap(box(red(note, sinceUs: since, in: area, on: .white), in: area) { $0 < 200 },
                                          "\(align) \(characters): a plate")
                let letters = try XCTUnwrap(box(red(note, sinceUs: since, in: area), in: area) { $0 > 200 }, "\(align) \(characters): letters")
                XCTAssertTrue(plate.insetBy(dx: -1, dy: -1).contains(letters),
                              "\(align) \(characters): the letters at \(letters) lie outside the plate at \(plate)")
                XCTAssertEqual(plate.maxY, rest.maxY, accuracy: 1, "\(align) \(characters): the plate hangs from the text's top")
                XCTAssertLessThanOrEqual(plate.width, rest.width + 1, "\(align) \(characters): never wider than at rest")
                switch align {
                case .center:
                    XCTAssertEqual(plate.midX, letters.midX, accuracy: 6, "\(align) \(characters): centred on the letters")
                    if characters == 7 {
                        XCTAssertEqual(plate.midX, rest.midX, accuracy: 2, "the typed first line is centred where it rests")
                    }
                case .right: XCTAssertEqual(plate.maxX, rest.maxX, accuracy: 1, "\(align) \(characters): the right edge stays")
                case .left: XCTAssertEqual(plate.minX, rest.minX, accuracy: 1, "\(align) \(characters): the left edge stays")
                }
                if characters == 7 {
                    XCTAssertLessThan(plate.height, rest.height * 0.65, "\(align): one typed line makes a plate of one line")
                } else {
                    XCTAssertEqual(plate.height, rest.height, accuracy: 2, "\(align): two typed lines make a plate of both")
                }
            }
        }
    }
}
