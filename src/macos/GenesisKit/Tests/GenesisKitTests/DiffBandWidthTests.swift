import AppKit
import SwiftUI
import XCTest
@testable import GenesisKit

/// Martin, 2026-10-07: in a tool call's diff the green and red bands stopped about 96 columns in, and the
/// rest of each long changed line ran on without its band.
@MainActor
final class DiffBandWidthTests: XCTestCase {
    private func greenness(_ rep: NSBitmapImageRep, x: CGFloat, y: CGFloat) -> CGFloat {
        guard let c = rep.colorAt(x: Int(x * CGFloat(rep.pixelsWide) / rep.size.width), y: Int(y * CGFloat(rep.pixelsHigh) / rep.size.height))?.usingColorSpace(.sRGB) else { return 0 }
        return c.greenComponent * c.alphaComponent - c.redComponent * c.alphaComponent
    }

    func testABandRunsUnderTheWholeOfALongChangedLine() throws {
        let long = String(repeating: "word ", count: 40)
        let diff = "@@ -1,1 +1,2 @@\n+short line\n+\(long)\n"
        let block = CodeBlockBuilder.unifiedDiff(diff, language: SyntaxLanguage.plain)
        let rendered = CodeBlockRenderer.attributed(block, limit: nil, highlight: false)
        let text = CodeTextConversion.appKit(rendered.body)
        let width = CGFloat(rendered.columns + 4) * CodeBlockMetrics.columnWidth
        let height = (CodeBlockMetrics.lineHeight + CodeBlockMetrics.lineSpacing) * 3
        let view = NSTextView(usingTextLayoutManager: false)
        view.frame = NSRect(x: 0, y: 0, width: width, height: height)
        view.drawsBackground = false
        view.textContainerInset = .zero
        view.textContainer?.lineFragmentPadding = 0
        view.textContainer?.widthTracksTextView = false
        view.textContainer?.containerSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        view.isVerticallyResizable = false
        view.isHorizontallyResizable = false
        view.textStorage?.setAttributedString(text)
        view.frame = NSRect(x: 0, y: 0, width: width, height: height)
        let rep = try XCTUnwrap(view.bitmapImageRepForCachingDisplay(in: view.bounds))
        view.cacheDisplay(in: view.bounds, to: rep)
        let row2 = CodeBlockMetrics.lineHeight + CodeBlockMetrics.lineSpacing + CodeBlockMetrics.lineHeight / 2
        let col = { (n: Int) in CGFloat(n) * CodeBlockMetrics.columnWidth + 2 }
        XCTAssertGreaterThan(greenness(rep, x: col(50), y: row2), 0.03, "no band at column 50 of the long line")
        XCTAssertGreaterThan(greenness(rep, x: col(150), y: row2), 0.03, "no band at column 150 of the long line")
        XCTAssertGreaterThan(greenness(rep, x: col(150), y: CodeBlockMetrics.lineHeight / 2), 0.03, "the short line's band stops before the long line ends")
    }
}
