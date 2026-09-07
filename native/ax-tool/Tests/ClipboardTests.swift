import AppKit
import XCTest
@testable import SnapshotSupport

final class ClipboardTests: XCTestCase {
    func testPasteRestoresEveryPreviousRepresentation() throws {
        let board = NSPasteboard.withUniqueName()
        defer { board.releaseGlobally() }
        let original = NSPasteboardItem()
        original.setString("before", forType: .string)
        original.setData(Data([1, 2, 3]), forType: NSPasteboard.PasteboardType("test.binary"))
        XCTAssertTrue(board.writeObjects([original]))
        let transaction = try ClipboardTransaction(board: board)
        try transaction.write(text: "<b>after</b>", format: "html")
        XCTAssertEqual(board.string(forType: .html), "<b>after</b>")
        XCTAssertEqual(transaction.restore(), "restored")
        XCTAssertEqual(board.string(forType: .string), "before")
        XCTAssertEqual(board.data(forType: NSPasteboard.PasteboardType("test.binary")), Data([1, 2, 3]))
    }

    func testRestoreDoesNotOverwriteAnotherClipboardWriter() throws {
        let board = NSPasteboard.withUniqueName()
        defer { board.releaseGlobally() }
        board.setString("before", forType: .string)
        let transaction = try ClipboardTransaction(board: board)
        try transaction.write(text: "our paste", format: "text")
        board.clearContents()
        board.setString("new user copy", forType: .string)
        XCTAssertEqual(transaction.restore(), "skipped-concurrent-change")
        XCTAssertEqual(board.string(forType: .string), "new user copy")
    }
}
