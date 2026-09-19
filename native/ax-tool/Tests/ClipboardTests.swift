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

    func testCompetingWritePreventsPastePrimitive() throws {
        let board = NSPasteboard.withUniqueName()
        defer { board.releaseGlobally() }
        let transaction = try ClipboardTransaction(board: board)
        try transaction.write(text: "requested payload", format: "text")
        board.clearContents()
        board.setString("competing payload", forType: .string)
        var calls = 0
        XCTAssertThrowsError(try transaction.dispatchPaste {
            calls += 1
            throw WindowEventError.unavailable("primitive must not be reached")
        }) { error in
            XCTAssertEqual(error.localizedDescription, "clipboard ownership changed before paste; no shortcut dispatched")
        }
        XCTAssertEqual(calls, 0)
        XCTAssertEqual(transaction.restore(), "skipped-concurrent-change")
        XCTAssertEqual(board.string(forType: .string), "competing payload")
    }

    func testOwnedPayloadReachesPastePrimitive() throws {
        let board = NSPasteboard.withUniqueName()
        defer { board.releaseGlobally() }
        let transaction = try ClipboardTransaction(board: board)
        try transaction.write(text: "requested payload", format: "text")
        defer { transaction.restore() }
        var calls = 0
        try transaction.dispatchPaste {
            calls += 1
            XCTAssertEqual(board.string(forType: .string), "requested payload")
        }
        XCTAssertEqual(calls, 1)
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

extension ClipboardTests {
    func testReplacementWaitsPastIntermediateValueWithoutRepeatingPaste() throws {
        let board = NSPasteboard.withUniqueName()
        defer { board.releaseGlobally() }
        let transaction = try ClipboardTransaction(board: board)
        try transaction.write(text: "complete", format: "text")
        defer { transaction.restore() }
        var pastes = 0
        try transaction.dispatchPaste { pastes += 1 }
        var time: TimeInterval = 0
        var reads = ["seed", "", "complete"]
        let value = waitForPasteReadback(before: "seed", expected: "complete", now: { time }, wait: { time += $0 }) {
            XCTAssertEqual(board.string(forType: .string), "complete")
            return reads.removeFirst()
        }
        XCTAssertEqual(value, "complete")
        XCTAssertEqual(pastes, 1)
        XCTAssertEqual(time, 0.3, accuracy: 0.0001)
    }
    func testReadbackDeadlineReturnsMismatchWithoutDispatchingAnything() {
        var time: TimeInterval = 0
        let value = waitForPasteReadback(before: "seed", expected: "complete", now: { time }, wait: { time += $0 }) { "partial" }
        XCTAssertEqual(value, "partial")
        XCTAssertEqual(time, 1, accuracy: 0.0001)
    }
}
