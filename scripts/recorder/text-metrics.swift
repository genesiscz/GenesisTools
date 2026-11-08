// Writes src/utils/recording-editor/text-metrics.json: how wide the recorder's text font draws each character, how it
// kerns two neighbours and how tall it sets a line, so check() (check.ts textBox) lays a text out the way the renderer
// does (Captions.swift TextPlates.render) without AppKit. Run it again when a macOS update changes the system font:
//
//     swift scripts/recorder/text-metrics.swift
//
// RecorderTextMetricsTests compares the renderer's real plates with an estimate from this file, so a font or renderer
// change fails a test until the file is written again.
import AppKit
import CoreText

/// The renderer's font: TextPlates.render draws every text in the semibold system font.
func font(_ px: Int) -> NSFont { NSFont.systemFont(ofSize: CGFloat(px), weight: .semibold) }

/// A one-line string's width in points: CTLine's typographic width, which is NSAttributedString.boundingRect's for one
/// line (both apply the font's kerning and its size-dependent tracking).
func width(_ text: String, _ font: NSFont) -> Double {
    let line = CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: [.font: font]))
    return CTLineGetTypographicBounds(line, nil, nil, nil)
}

func say(_ line: String) { FileHandle.standardError.write((line + "\n").data(using: .utf8)!) }

/// Every width and kerning value in the file is in 1/10000 em: 0.01 px at 100 px, and the file stays small.
let unit = 10_000.0
func units(_ em: Double) -> Int { Int((em * unit).rounded()) }

// ASCII printable, Latin-1, Latin Extended-A (Czech, Slovak, Polish, German, ...) and the punctuation a title uses.
var scalars: [UInt32] = Array(0x20...0x7E) + Array(0xA0...0xFF) + Array(0x100...0x17F)
scalars += "–—‘’‚“”„…•€".unicodeScalars.map(\.value)
let chars = scalars.map { String(UnicodeScalar($0)!) }

// SF has optical sizes (its letters change shape between 17 and 28 px) and tracks each size its own way, so a width
// in em differs by font size: 9 % between 14 and 80 px. The table holds the widths at a few sizes, picked so that a
// straight line between two neighbours stays within `tolerance` of the measured width at every whole pixel size from
// 8 (the renderer's smallest font) up to `top`, the size from which nothing changes any more.
let tolerance = 0.0005
let measured: [Int: [Double]] = Dictionary(uniqueKeysWithValues: (8...240).map { px in
    let f = font(px)
    return (px, chars.map { width($0, f) / Double(px) })
})
let rounded = measured.mapValues { $0.map(units) }
let top = (8...240).first { px in (px...240).allSatisfy { rounded[$0] == rounded[240] } }!

func interpolated(_ sizes: [Int], _ px: Int) -> [Double] {
    guard let upper = sizes.firstIndex(where: { $0 >= px }) else { return measured[sizes.last!]! }
    if sizes[upper] == px || upper == 0 { return measured[sizes[upper]]! }
    let (a, b) = (sizes[upper - 1], sizes[upper])
    let share = Double(px - a) / Double(b - a)
    return zip(measured[a]!, measured[b]!).map { $0 + ($1 - $0) * share }
}

func worst(_ sizes: [Int]) -> (px: Int, error: Double) {
    (8...top).map { px in
        (px, zip(interpolated(sizes, px), measured[px]!).map { abs($0 - $1) }.max()!)
    }.max { $0.1 < $1.1 }!
}

var sizes = [8, top]
while worst(sizes).error > tolerance {
    sizes = (sizes + [worst(sizes).px]).sorted()
}
let fit = worst(sizes)
say("sizes \(sizes): widths within \(String(format: "%.4f", fit.error)) em (worst at \(fit.px) px), none change from \(top) px")

// A character outside the table counts as the mean width of the letters A-Z and a-z.
let letters = chars.indices.filter { chars[$0].first!.isASCII && chars[$0].first!.isLetter }

// Kerning, at the text (17 px and below) and the display (28 px and up) optical size; between them the estimate
// interpolates. The font kerns by classes, so the file does too: every character has a class as the first of a pair
// and one as the second, and `pairs[left]` lists the right classes it kerns with, each with its two values.
let kernSizes = [17, 28]
func kerning(_ px: Int) -> [[Double]] {
    let f = font(px)
    let single = chars.map { width($0, f) }
    return chars.indices.map { a in
        chars.indices.map { b in (width(chars[a] + chars[b], f) - single[a] - single[b]) / Double(px) }
    }
}
let kerns = kernSizes.map(kerning)
let cells = chars.indices.map { a in chars.indices.map { b in kerns.map { units($0[a][b]) } } }

func classes(_ key: (Int) -> [[Int]]) -> (of: [Int], first: [Int]) {
    var seen: [[[Int]]: Int] = [:]
    var first: [Int] = []
    let of = chars.indices.map { c -> Int in
        let row = key(c)
        if let known = seen[row] { return known }
        seen[row] = first.count
        first.append(c)
        return first.count - 1
    }
    return (of, first)
}
let left = classes { a in chars.indices.map { cells[a][$0] } }
let right = classes { b in chars.indices.map { cells[$0][b] } }
let pairs: [[Int]] = left.first.map { a in
    right.first.enumerated().flatMap { klass, b -> [Int] in
        cells[a][b].allSatisfy { $0 == 0 } ? [] : [klass] + cells[a][b]
    }
}
let pairCount = pairs.map { $0.count / 3 }.reduce(0, +)

// How far the two-size kerning is from the real kerning at sizes between and around them.
for px in [12, 20, 24, 40, 80] {
    let real = kerning(px)
    let share = min(1, max(0, Double(px - kernSizes[0]) / Double(kernSizes[1] - kernSizes[0])))
    var errors: [Double] = []
    for a in chars.indices {
        for b in chars.indices {
            errors.append(abs(kerns[0][a][b] + (kerns[1][a][b] - kerns[0][a][b]) * share - real[a][b]))
        }
    }
    let sorted = errors.sorted()
    say("kerning at \(px) px: 99.9 % of pairs within \(String(format: "%.4f", sorted[sorted.count * 999 / 1000])) em, all within \(String(format: "%.4f", sorted.last!))")
}

// The file is written by hand, one row per line, so a new measurement reads as a diff of rows.
func quoted(_ text: String) -> String {
    var out = "\""
    for scalar in text.unicodeScalars {
        switch scalar {
        case "\"": out += "\\\""
        case "\\": out += "\\\\"
        case "\u{00AD}", "\u{00A0}": out += String(format: "\\u%04X", scalar.value)
        default: out.unicodeScalars.append(scalar)
        }
    }
    return out + "\""
}
func list(_ values: [Int]) -> String { "[" + values.map(String.init).joined(separator: ",") + "]" }
func rows(_ rows: [[Int]], indent: String) -> String {
    "[\n" + rows.map { indent + "    " + list($0) }.joined(separator: ",\n") + "\n" + indent + "]"
}

let probe = font(1000)
let version = ProcessInfo.processInfo.operatingSystemVersion
let about = "The recorder's text font (NSFont.systemFont, semibold, as Captions.swift TextPlates.render draws it), measured "
    + "on macOS \(version.majorVersion).\(version.minorVersion) by scripts/recorder/text-metrics.swift; do not edit by hand. "
    + "Widths and kerning are in 1/10000 em. advances has one row per font pixel size in sizes, one width per character of "
    + "chars; between two sizes a width is interpolated, outside them the nearest size holds. fallback is the width of a "
    + "character outside chars, per size. kerning adds to two neighbouring characters: left and right give each character's "
    + "class, pairs[left class] lists right class, value at kerning.sizes[0], value at kerning.sizes[1]; between the two "
    + "sizes it is interpolated. A line is round(ascender x px) + round(descender x px) + round(leading x px) pixels tall."
let json = """
{
    "about": \(quoted(about)),
    "font": \(quoted(probe.fontName)),
    "unit": \(Int(unit)),
    "ascender": \(Double(probe.ascender) / 1000),
    "descender": \(Double(-probe.descender) / 1000),
    "leading": \(Double(probe.leading) / 1000),
    "chars": \(quoted(chars.joined())),
    "sizes": \(list(sizes)),
    "fallback": \(list(sizes.map { px in units(letters.map { measured[px]![$0] }.reduce(0, +) / Double(letters.count)) })),
    "advances": \(rows(sizes.map { rounded[$0]! }, indent: "    ")),
    "kerning": {
        "sizes": \(list(kernSizes)),
        "left": \(list(left.of)),
        "right": \(list(right.of)),
        "pairs": \(rows(pairs, indent: "        "))
    }
}

"""

let out = CommandLine.arguments.count > 1
    ? URL(fileURLWithPath: CommandLine.arguments[1])
    : URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("src/utils/recording-editor/text-metrics.json")
_ = try JSONSerialization.jsonObject(with: json.data(using: .utf8)!)
try json.write(to: out, atomically: true, encoding: .utf8)
say("wrote \(out.path): \(sizes.count) sizes, \(chars.count) characters, \(left.first.count) x \(right.first.count) kerning classes with \(pairCount) pairs, \(json.utf8.count) bytes")
