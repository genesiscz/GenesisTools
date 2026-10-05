import AppKit
import SwiftUI
import XCTest
@testable import GenesisKit

/// The code block's size estimate, its AppKit text conversion and the wrapped container's height cache
/// and gutter rows (Sessions/Code/SessionCodeBlock.swift, CodeTextView.swift): what decides whether
/// transcript text is clipped and whether rows overlap.
final class CodeBlockLayoutTests: XCTestCase {
    func testColumnsCountTabsAsEightAndNonASCIIAsTwo() {
        XCTAssertEqual(CodeBlockMetrics.columns("abc"), 3)
        XCTAssertEqual(CodeBlockMetrics.columns("\tx"), 9)
        XCTAssertEqual(CodeBlockMetrics.columns("é日本"), 6)
        XCTAssertEqual(CodeBlockMetrics.columns(""), 0)
    }

    func testSizeNeverShrinksBelowOneLineAndReservesASpareColumn() {
        let one = CodeBlockMetrics.size(lines: 1, columns: 10)
        XCTAssertEqual(CodeBlockMetrics.size(lines: 0, columns: 10), one)
        XCTAssertEqual(one.width, ceil(11 * CodeBlockMetrics.columnWidth))
        let three = CodeBlockMetrics.size(lines: 3, columns: 10)
        XCTAssertEqual(three.height, ceil(3 * CodeBlockMetrics.lineHeight + 2 * CodeBlockMetrics.lineSpacing))
        XCTAssertGreaterThan(three.height, one.height)
    }

    func testConversionKeepsRunColoursOnTheirOwnRangesPastSurrogatePairs() {
        var text = AttributedString("é😀x")
        let end = text.index(text.startIndex, offsetByCharacters: 2)
        text[text.startIndex..<end].foregroundColor = .red
        let converted = CodeTextConversion.appKit(text)

        XCTAssertEqual(converted.string, "é😀x")
        let marked = converted.attribute(.foregroundColor, at: 1, effectiveRange: nil) as? NSColor
        let plain = converted.attribute(.foregroundColor, at: 3, effectiveRange: nil) as? NSColor
        XCTAssertEqual(marked, NSColor(Color.red))
        XCTAssertNotEqual(plain, NSColor(Color.red))
    }

    func testWrappingChangesTheLineBreakModeOnly() {
        let plain = CodeTextConversion.appKit(AttributedString("a"), wrapping: false)
        let wrapped = CodeTextConversion.appKit(AttributedString("a"), wrapping: true)
        let plainStyle = plain.attribute(.paragraphStyle, at: 0, effectiveRange: nil) as? NSParagraphStyle
        let wrappedStyle = wrapped.attribute(.paragraphStyle, at: 0, effectiveRange: nil) as? NSParagraphStyle
        XCTAssertEqual(plainStyle?.lineBreakMode, .byClipping)
        XCTAssertEqual(wrappedStyle?.lineBreakMode, .byWordWrapping)
        XCTAssertEqual(wrappedStyle?.lineSpacing, CodeBlockMetrics.lineSpacing)
    }

    private func body(_ text: String) -> NSAttributedString {
        CodeTextConversion.appKit(AttributedString(text), wrapping: true)
    }

    func testHeightGrowsWithLinesAndATrailingNewlineAddsTheEmptyLastRow() {
        let container = WrappedCodeContainer()
        container.set(gutter: nil, body: body("a\nb\nc"), gutterWidth: 0)
        let three = container.height(forWidth: 2000)
        container.set(gutter: nil, body: body("a"), gutterWidth: 0)
        let one = container.height(forWidth: 2000)
        container.set(gutter: nil, body: body("a\nb\n"), gutterWidth: 0)
        let twoAndEmpty = container.height(forWidth: 2000)
        container.set(gutter: nil, body: body("a\nb"), gutterWidth: 0)
        let two = container.height(forWidth: 2000)

        XCTAssertGreaterThan(three, two)
        XCTAssertGreaterThan(two, one)
        XCTAssertGreaterThan(twoAndEmpty, two)
    }

    func testANarrowWidthWrapsTallerAndComingBackToAWidthGivesItsFirstAnswer() {
        let container = WrappedCodeContainer()
        container.set(gutter: nil, body: body(String(repeating: "word ", count: 40)), gutterWidth: 0)
        let wide = container.height(forWidth: 3000)
        let narrow = container.height(forWidth: 120)
        let wideAgain = container.height(forWidth: 3000)

        XCTAssertGreaterThan(narrow, wide)
        XCTAssertEqual(wideAgain, wide)
        XCTAssertEqual(container.height(forWidth: 120), narrow)
    }

    func testNewContentForgetsTheHeightsOfTheOldAtTheSameWidth() {
        let container = WrappedCodeContainer()
        container.set(gutter: nil, body: body("a"), gutterWidth: 0)
        let short = container.height(forWidth: 400)
        container.set(gutter: nil, body: body("a\nb\nc\nd"), gutterWidth: 0)

        XCTAssertGreaterThan(container.height(forWidth: 400), short)
    }

    func testTheGutterNumbersSitAtTheTopOfEachLinesFirstRowAfterWrapping() throws {
        let container = WrappedCodeContainer()
        let long = String(repeating: "word ", count: 40)
        container.set(
            gutter: CodeTextConversion.appKit(AttributedString("1\n2\n3")),
            body: body("\(long)\nb\nc"),
            gutterWidth: 24
        )
        _ = container.height(forWidth: 160)

        let gutter = try XCTUnwrap(container.subviews.compactMap { $0 as? CodeGutterView }.first)
        XCTAssertEqual(gutter.starts.count, 3)
        XCTAssertEqual(gutter.starts[0], 0)
        let wrappedGap = gutter.starts[1] - gutter.starts[0]
        let singleRowGap = gutter.starts[2] - gutter.starts[1]
        XCTAssertGreaterThan(wrappedGap, singleRowGap * 2, "line 1 wrapped onto several rows, so line 2 starts well below it")
    }
}
