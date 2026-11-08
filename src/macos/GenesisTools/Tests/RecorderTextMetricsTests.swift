import AppKit
import XCTest
@testable import GenesisToolsRecorder

/// check() (check.ts textBox, text-metrics.ts) lays a text out from text-metrics.json, not with AppKit. These tests set
/// the same estimate beside the plates TextPlates really draws, so a change of the system font or of the renderer fails
/// here: write the table again with `swift scripts/recorder/text-metrics.swift` and keep text-metrics.ts in step.
final class RecorderTextMetricsTests: XCTestCase {
    /// Every case at a 1080 px short side on a 16:9 canvas, the size check() lays texts out at.
    private static let canvas = CGSize(width: 1920, height: 1080)

    func testTheTableEstimatesTheRenderersPlatesWithinTwoPixels() throws {
        let estimate = try TextEstimate(contentsOf: Self.metricsURL)
        let block = { (width: Double, align: EditProject.TextAlign) in EditProject.TextBlock(width: width, align: align) }
        let notes: [EditProject.TextNote] = [
            note("Hello", size: 0.05),
            note("Zákazník napíše do poradny", size: 0.05, style: .plain, block: block(0.4, .center)),
            note("Recepce zrovna telefonuje, zprávu nečte.", size: 0.029, style: .plain, block: block(0.4, .center)),
            note("Každý krok nastavení se v ukázce objeví jako krátký titulek, jeden po druhém, v pořadí, v jakém je projde "
                + "nový uživatel.", size: 0.04, block: block(0.4, .center)),
            note("První řádek\nDruhý řádek s háčky: ěščřžýáíé", size: 0.045),
            note("Öffnen Sie die Einstellungen für Größe und Straße", size: 0.06, block: block(0.3, .left)),
            note("Zażółć gęślą jaźń — łódź płynie po rzece", size: 0.05, style: .plain, block: block(0.35, .right)),
            note("Supercalifragilisticexpialidocious and more", size: 0.06, block: block(0.2, .center)),
            note("Napíše „rezervace“ a pošle ji (hned) e-mailem…", size: 0.035, block: block(0.25, .center)),
            note("AVATAR Toyota WAVE", size: 0.08),
            note("Malý popisek pod obrázkem, který se zalomí do více řádků.", size: 0.02, block: block(0.2, .center)),
            note("Velký nadpis", size: 0.12, style: .plain),
            note("Termín 10:30, 12. 11. 2026", size: 0.045),
        ]
        let plates = TextPlates()
        for note in notes {
            // As Looks.drawText sizes and wraps it.
            let fontSize = max(8, (note.size * min(Self.canvas.width, Self.canvas.height)).rounded())
            let maxWidth = Looks.textBlockWidth(note, canvasWidth: Self.canvas.width)
            let alignment = Looks.textAlignment(note.block?.align)
            let real = try XCTUnwrap(plates.plate(note.text, fontSize: fontSize, maxWidth: maxWidth, weight: .semibold,
                                                  plain: note.style == .plain, alignment: alignment), note.text).extent.size
            let inset = CGSize(width: fontSize * 0.7, height: fontSize * 0.38)
            let lines = estimate.layout(note.text, px: Int(fontSize), wrap: max(fontSize * 4, maxWidth - 2 * inset.width),
                                        align: alignment)
            let guess = CGSize(width: ceil(lines.width + 2 * inset.width), height: ceil(lines.height + 2 * inset.height))
            XCTAssertEqual(guess.width, real.width, accuracy: 2, "width of \"\(note.text)\" at \(Int(fontSize)) px")
            XCTAssertEqual(guess.height, real.height, accuracy: 2, "height (lines) of \"\(note.text)\" at \(Int(fontSize)) px")
        }
    }

    /// TextPlates.render's font, as the table measured it.
    func testTheTableMeasuredTheRenderersFont() throws {
        let metrics = try JSONDecoder().decode(TextEstimate.Metrics.self, from: Data(contentsOf: Self.metricsURL))
        let font = NSFont.systemFont(ofSize: 1000, weight: .semibold)
        XCTAssertEqual(metrics.font, font.fontName)
        XCTAssertEqual(metrics.ascender, Double(font.ascender) / 1000, accuracy: 1e-6)
        XCTAssertEqual(metrics.descender, Double(-font.descender) / 1000, accuracy: 1e-6)
    }

    private static var metricsURL: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("utils/recording-editor/text-metrics.json")
    }

    private func note(_ text: String, size: Double, style: EditProject.TextStyle = .plate,
                      block: EditProject.TextBlock? = nil) -> EditProject.TextNote {
        EditProject.TextNote(id: "t", startUs: 0, endUs: 1_000_000, text: text, size: size, style: style, block: block)
    }
}

/// text-metrics.ts layoutText in Swift, from the same table: the font's widths and kerning, TextKit's line breaks and
/// the box boundingRect returns. Keep the two in step.
private struct TextEstimate {
    struct Metrics: Decodable {
        struct Kerning: Decodable {
            let sizes: [Int]
            let left: [Int]
            let right: [Int]
            let pairs: [[Int]]
        }

        let font: String
        let unit: Double
        let ascender: Double
        let descender: Double
        let leading: Double
        let chars: String
        let sizes: [Int]
        let fallback: [Int]
        let advances: [[Int]]
        let kerning: Kerning
    }

    static let spaces: Set<Unicode.Scalar> = [" ", "\t", "\u{1680}", "\u{2000}", "\u{2001}", "\u{2002}", "\u{2003}", "\u{2004}",
                                              "\u{2005}", "\u{2006}"]
    static let breaksAfter: Set<Unicode.Scalar> = ["-", "/", "?", "!", "|", "}", "\u{2010}", "\u{2013}", "\u{2014}", "\u{2026}"]
    static let noBreakBefore: Set<Unicode.Scalar> = ["!", "?", ")", "]", "}", ",", ".", ":", ";", "/", "\u{201D}"]
    static let noBreakAfter: Set<Unicode.Scalar> = ["(", "[", "{", "\u{00A1}", "\u{00AB}", "\u{00BF}", "\u{2018}", "\u{201A}",
                                                    "\u{201C}", "\u{201E}", "\u{2039}"]

    let metrics: Metrics
    private let index: [Unicode.Scalar: Int]
    private let kerns: [Int: (text: Double, display: Double)]

    init(contentsOf url: URL) throws {
        metrics = try JSONDecoder().decode(Metrics.self, from: Data(contentsOf: url))
        index = Dictionary(uniqueKeysWithValues: metrics.chars.unicodeScalars.enumerated().map { ($1, $0) })
        var kerns: [Int: (text: Double, display: Double)] = [:]
        for (left, row) in metrics.kerning.pairs.enumerated() {
            for at in stride(from: 0, to: row.count - 2, by: 3) {
                kerns[left * 4096 + row[at]] = (Double(row[at + 1]), Double(row[at + 2]))
            }
        }
        self.kerns = kerns
    }

    /// The widths (em) of the table's characters at a font size, the last for a character outside the table.
    private func widths(_ px: Int) -> [Double] {
        let sizes = metrics.sizes
        let above = sizes.firstIndex { $0 >= px }
        let high = above ?? sizes.count - 1
        let low = above.map { $0 > 0 && sizes[$0] != px ? $0 - 1 : $0 } ?? high
        let share = low == high ? 0 : Double(px - sizes[low]) / Double(sizes[high] - sizes[low])
        let from: [Int] = metrics.advances[low] + [metrics.fallback[low]]
        let to: [Int] = metrics.advances[high] + [metrics.fallback[high]]
        return zip(from, to).map { pair -> Double in
            let (a, b) = (Double(pair.0), Double(pair.1))
            return (a + (b - a) * share) / metrics.unit
        }
    }

    private func kerning(_ left: Int?, _ right: Int?, px: Int) -> Double {
        guard let left, let right,
              let values = kerns[metrics.kerning.left[left] * 4096 + metrics.kerning.right[right]] else { return 0 }
        let (text, display) = (Double(metrics.kerning.sizes[0]), Double(metrics.kerning.sizes[1]))
        let share = min(1, max(0, (Double(px) - text) / (display - text)))
        return (values.text + (values.display - values.text) * share) / metrics.unit
    }

    private func lineHeight(_ px: Int) -> Double {
        let size = Double(px)
        return (metrics.ascender * size).rounded() + (metrics.descender * size).rounded() + (metrics.leading * size).rounded()
    }

    /// The text's box at `px`, wrapped at `wrap` pixels: boundingRect's width and height.
    func layout(_ text: String, px: Int, wrap: CGFloat, align: NSTextAlignment) -> CGSize {
        let widths = widths(px)
        let size = Double(px)
        let wrap = Double(wrap)
        var lines: [(letters: Double, spaces: Double)] = []
        let paragraphs = text.precomposedStringWithCanonicalMapping.replacingOccurrences(of: "\r\n", with: "\n")
            .split(omittingEmptySubsequences: false) { "\n\r\u{2028}\u{2029}".contains($0) }
        for paragraph in paragraphs {
            let chars = Array(String(paragraph).unicodeScalars)
            let indices = chars.map { index[$0] }
            func advance(_ at: Int) -> Double { widths[indices[at] ?? widths.count - 1] * size }
            func kern(_ at: Int) -> Double { kerning(indices[at - 1], indices[at], px: px) * size }
            func span(_ from: Int, _ to: Int) -> Double {
                (from..<max(from, to)).reduce(0) { $0 + advance($1) + ($1 > from ? kern($1) : 0) }
            }
            func close(_ from: Int, _ to: Int) {
                var last = to
                while last > from, Self.spaces.contains(chars[last - 1]) { last -= 1 }
                let letters = span(from, last) + (last > from && last < to ? kern(last) : 0)
                lines.append((letters, span(from, to) - letters))
            }
            var start = 0, breakAt = -1, before = -1, width = 0.0, opened = false
            func mark(_ at: Int) {
                if breakAt != at { before = breakAt }
                breakAt = at + 1
            }
            for (at, char) in chars.enumerated() {
                if breakAt == at, Self.noBreakBefore.contains(char) { breakAt = before }
                // The character does not fit: the line ends at its last break, or before this character when it has none.
                while !Self.spaces.contains(char), at > start, width + kern(at) + advance(at) > wrap + 1e-6 {
                    let end = breakAt > start ? breakAt : at
                    close(start, end)
                    start = end
                    breakAt = -1
                    before = -1
                    width = span(start, at)
                }
                width += advance(at) + (at > start ? kern(at) : 0)
                if Self.spaces.contains(char) {
                    if !opened { mark(at) }
                } else {
                    opened = Self.noBreakAfter.contains(char)
                    if Self.breaksAfter.contains(char) { mark(at) }
                }
            }
            close(start, chars.count)
        }
        // TextKit's box runs from the leftmost line's start to the rightmost line's end, and is never wider than the wrap.
        var leftmost = Double.infinity, rightmost = -Double.infinity
        for line in lines {
            let left = align == .left ? 0 : align == .right ? wrap - line.letters : (wrap - line.letters) / 2
            leftmost = min(leftmost, left)
            rightmost = max(rightmost, left + line.letters + line.spaces)
        }
        return CGSize(width: min(wrap, max(0, rightmost - leftmost)), height: Double(lines.count) * lineHeight(px))
    }
}
