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
    func testConsumptionWaitsPastIntermediateValue() {
        var time: TimeInterval = 0
        var reads = ["seed", "", "complete"]
        let result = waitForPasteConsumption(before: "seed", timeout: 3, now: { time }, wait: { time += $0 },
                                             read: { reads.removeFirst() }, settled: { $0 == "complete" })
        XCTAssertEqual(result.value, "complete")
        XCTAssertTrue(result.consumed)
        XCTAssertEqual(time, 0.15, accuracy: 0.0001)
    }

    func testConsumptionDeadlineReportsAChangeThatNeverSettled() {
        var time: TimeInterval = 0
        let result = waitForPasteConsumption(before: "seed", timeout: 3, now: { time }, wait: { time += $0 },
                                             read: { "partial" }, settled: { $0 == "complete" })
        XCTAssertEqual(result.value, "partial")
        XCTAssertTrue(result.consumed)
        XCTAssertEqual(time, 3, accuracy: 0.0001)
    }

    func testWrittenPayloadCarriesTheTransientMarkers() throws {
        let board = NSPasteboard.withUniqueName()
        defer { board.releaseGlobally() }
        board.setString("before", forType: .string)
        let transaction = try ClipboardTransaction(board: board)
        try transaction.write(text: "ours", format: "text")
        defer { transaction.restore() }
        let types = board.pasteboardItems?.first?.types ?? []
        for marker in clipboardTransientTypes {
            XCTAssertTrue(types.contains(marker), "missing \(marker.rawValue)")
        }
    }

    /// A clipboard-history app that re-publishes the item it recorded moves the change count
    /// without the user copying anything. Skipping the restore then left our text on the
    /// clipboard for good.
    func testRepublishedPayloadIsStillRestored() throws {
        let board = NSPasteboard.withUniqueName()
        defer { board.releaseGlobally() }
        board.setString("before", forType: .string)
        let transaction = try ClipboardTransaction(board: board)
        try transaction.write(text: "our paste", format: "text")
        let item = try XCTUnwrap(board.pasteboardItems?.first)
        let copy = NSPasteboardItem()
        for type in item.types {
            copy.setData(try XCTUnwrap(item.data(forType: type)), forType: type)
        }
        board.clearContents()
        XCTAssertTrue(board.writeObjects([copy]))
        XCTAssertEqual(transaction.restore(), "restored")
        XCTAssertEqual(board.string(forType: .string), "before")
    }

    /// The same text copied by the user is a newer copy, not ours: it carries no paste nonce, so the
    /// restore must leave it alone rather than put the older clipboard back over it.
    func testAUserCopyOfTheSameTextIsNeverOverwritten() throws {
        let board = NSPasteboard.withUniqueName()
        defer { board.releaseGlobally() }
        board.setString("before", forType: .string)
        let transaction = try ClipboardTransaction(board: board)
        try transaction.write(text: "our paste", format: "text")
        board.clearContents()
        let userCopy = NSPasteboardItem()
        userCopy.setString("our paste", forType: .string)
        userCopy.setString("<b>our paste</b>", forType: .html)
        XCTAssertTrue(board.writeObjects([userCopy]))
        XCTAssertEqual(transaction.restore(), "skipped-concurrent-change")
        XCTAssertEqual(board.string(forType: .html), "<b>our paste</b>")
    }
}
