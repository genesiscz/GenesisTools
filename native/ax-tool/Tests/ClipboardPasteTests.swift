import AppKit
import XCTest
@testable import SnapshotSupport

/// Every exit path of `performClipboardPaste` must leave the user's clipboard as it found it.
/// The paste primitive is a spy that throws when it is reached twice or when the pasteboard does
/// not hold our payload at that moment, and `assertOriginal` throws when the clipboard leaked.
final class ClipboardPasteTests: XCTestCase {
    struct Leak: Error, CustomStringConvertible {
        let description: String
    }

    /// A text field with a clock. `consumeAfter` is how long the receiver takes to read the
    /// pasteboard after cmd+v; it reads whatever the pasteboard holds at that moment.
    final class Field {
        let board: NSPasteboard
        var value: String?
        var selection: (location: Int, length: Int)?
        var focused = true
        var time: TimeInterval = 0
        var consumeAfter: TimeInterval = 0.1
        var consumes = true
        var appendsInsteadOfReplacing = false
        var axSelectionWorks = true
        var keySelectionWorks = true
        var pastes = 0
        var pendingPasteAt: TimeInterval?
        var readFromPasteboard: String?

        init(board: NSPasteboard, value: String?) {
            self.board = board
            self.value = value
        }

        func advance(_ seconds: TimeInterval) {
            time += seconds
            if let due = pendingPasteAt, time >= due {
                pendingPasteAt = nil
                let pasted = board.string(forType: .string) ?? ""
                readFromPasteboard = pasted
                let current = value ?? ""
                if let selection, selection.location == 0, selection.length == current.utf16.count,
                   !appendsInsteadOfReplacing {
                    value = pasted
                } else {
                    value = current + pasted
                }
                self.selection = nil
            }
        }

        func primitives(ours: String) -> ClipboardPastePrimitives {
            ClipboardPastePrimitives(
                readValue: { self.value },
                focusedOnTarget: { self.focused },
                setSelection: { length in
                    guard self.axSelectionWorks else { return false }
                    self.selection = (0, length)
                    return true
                },
                selectedRange: { self.selection ?? (self.value.map { ($0.utf16.count, 0) }) },
                postSelectAll: {
                    if self.keySelectionWorks { self.selection = (0, (self.value ?? "").utf16.count) }
                },
                postPaste: {
                    self.pastes += 1
                    guard self.pastes == 1 else { throw Leak(description: "cmd+v posted twice") }
                    guard self.board.string(forType: .string) == ours else {
                        throw Leak(description: "cmd+v posted while the pasteboard did not hold our payload")
                    }
                    if self.consumes { self.pendingPasteAt = self.time + self.consumeAfter }
                },
                now: { self.time },
                wait: { self.advance($0) })
        }
    }

    private var board: NSPasteboard!

    override func setUp() {
        super.setUp()
        board = NSPasteboard.withUniqueName()
        let original = NSPasteboardItem()
        original.setString("user clipboard", forType: .string)
        original.setData(Data([7, 8, 9]), forType: NSPasteboard.PasteboardType("test.binary"))
        board.clearContents()
        XCTAssertTrue(board.writeObjects([original]))
    }

    override func tearDown() {
        board.releaseGlobally()
        board = nil
        super.tearDown()
    }

    private func assertOriginal(file: StaticString = #filePath, line: UInt = #line) throws {
        let text = board.string(forType: .string)
        let binary = board.data(forType: NSPasteboard.PasteboardType("test.binary"))
        guard text == "user clipboard", binary == Data([7, 8, 9]) else {
            XCTFail("clipboard leaked: \(text ?? "nil")", file: file, line: line)
            throw Leak(description: "clipboard leaked: \(text ?? "nil")")
        }
    }

    private func paste(_ field: Field, text: String, replace: Bool) throws -> ClipboardPasteOutcome {
        let transaction = try ClipboardTransaction(board: board)
        return try performClipboardPaste(transaction: transaction, text: text, format: "text", replace: replace,
                                         primitives: field.primitives(ours: text))
    }

    private func pasteFailure(_ field: Field, text: String, replace: Bool) throws -> ClipboardPasteError {
        do {
            _ = try paste(field, text: text, replace: replace)
        } catch let failure as ClipboardPasteError {
            return failure
        }
        XCTFail("expected a ClipboardPasteError")
        throw Leak(description: "no failure")
    }

    func testReplacementSucceedsAndRestoresAfterTheReceiverRead() throws {
        let field = Field(board: board, value: "https://old.example/page")
        let outcome = try paste(field, text: "chrome-extension://abc/options.html", replace: true)
        XCTAssertEqual(outcome.readback, "chrome-extension://abc/options.html")
        XCTAssertEqual(outcome.clipboardRestore, "restored")
        XCTAssertEqual(outcome.selection, "ax")
        XCTAssertEqual(field.pastes, 1)
        try assertOriginal()
    }

    /// The observed failure: the restore ran one second after cmd+v, before a busy receiver read
    /// the pasteboard, so the receiver pasted the user's ORIGINAL clipboard.
    func testSlowReceiverReadsOurPayloadNotTheRestoredClipboard() throws {
        let field = Field(board: board, value: "")
        field.consumeAfter = 1.6
        let outcome = try paste(field, text: "chrome-extension://abc/options.html", replace: true)
        XCTAssertEqual(field.readFromPasteboard, "chrome-extension://abc/options.html")
        XCTAssertEqual(outcome.readback, "chrome-extension://abc/options.html")
        try assertOriginal()
    }

    func testReceiverThatNeverReadsIsReportedAndTheClipboardStillComesBack() throws {
        let field = Field(board: board, value: "draft")
        field.consumes = false
        let failure = try pasteFailure(field, text: "new", replace: true)
        XCTAssertTrue(failure.dispatched)
        XCTAssertEqual(failure.clipboardRestore, "restored")
        XCTAssertTrue(failure.message.contains("did not take the paste"), failure.message)
        try assertOriginal()
    }

    /// A select-all that did not take turned a replacement into an append on Brave's omnibox.
    func testUnprovenSelectionRefusesBeforeCmdV() throws {
        let field = Field(board: board, value: "https://www.youtube.com/@channel/streams")
        field.axSelectionWorks = false
        field.keySelectionWorks = false
        let failure = try pasteFailure(field, text: "chrome-extension://abc/options.html", replace: true)
        XCTAssertFalse(failure.dispatched)
        XCTAssertEqual(field.pastes, 0)
        XCTAssertEqual(field.value, "https://www.youtube.com/@channel/streams")
        XCTAssertTrue(failure.message.contains("select-all did not cover the field"), failure.message)
        try assertOriginal()
    }

    func testKeySelectionIsAcceptedOnlyOnceItReadsBack() throws {
        let field = Field(board: board, value: "old")
        field.axSelectionWorks = false
        let outcome = try paste(field, text: "new", replace: true)
        XCTAssertEqual(outcome.selection, "keys")
        XCTAssertEqual(outcome.readback, "new")
        try assertOriginal()
    }

    func testReadbackMismatchStillRestores() throws {
        let field = Field(board: board, value: "old")
        field.appendsInsteadOfReplacing = true
        let failure = try pasteFailure(field, text: "new", replace: true)
        XCTAssertTrue(failure.dispatched)
        XCTAssertEqual(failure.message, "paste replacement read-back differs; inspect before retrying")
        XCTAssertEqual(failure.clipboardRestore, "restored")
        try assertOriginal()
    }

    func testThrowingPastePrimitiveStillRestores() throws {
        let transaction = try ClipboardTransaction(board: board)
        let field = Field(board: board, value: "old")
        var primitives = field.primitives(ours: "new")
        primitives.postPaste = { throw WindowEventError.unavailable("could not allocate paste keys") }
        XCTAssertThrowsError(try performClipboardPaste(transaction: transaction, text: "new", format: "text",
                                                       replace: true, primitives: primitives)) { error in
            XCTAssertEqual((error as? ClipboardPasteError)?.clipboardRestore, "restored")
            XCTAssertEqual((error as? ClipboardPasteError)?.dispatched, true)
        }
        try assertOriginal()
    }

    func testFocusLossBeforePasteRestoresWithoutDispatch() throws {
        let field = Field(board: board, value: "old")
        field.focused = false
        let failure = try pasteFailure(field, text: "new", replace: true)
        XCTAssertFalse(failure.dispatched)
        XCTAssertEqual(field.pastes, 0)
        XCTAssertEqual(failure.message, "focus changed before paste; clipboard restored without dispatch")
        try assertOriginal()
    }

    func testInsertionMustContainThePastedText() throws {
        let field = Field(board: board, value: "Hello ")
        let outcome = try paste(field, text: "world", replace: false)
        XCTAssertEqual(outcome.readback, "Hello world")
        XCTAssertNil(outcome.selection)
        try assertOriginal()
    }

    func testReplacingIdenticalTextNeverTouchesTheClipboard() throws {
        let count = board.changeCount
        let field = Field(board: board, value: "same")
        let outcome = try paste(field, text: "same", replace: true)
        XCTAssertTrue(outcome.skipped)
        XCTAssertEqual(field.pastes, 0)
        XCTAssertEqual(board.changeCount, count)
        try assertOriginal()
    }

    func testTerminationDuringPasteRestoresBeforeExit() throws {
        let transaction = try ClipboardTransaction(board: board)
        try transaction.write(text: "ours", format: "text")
        let fired = expectation(description: "termination handler")
        var restoration: String?
        let guardian = ClipboardTerminationGuard(transaction: transaction, signals: [SIGUSR1]) { _, status in
            restoration = status
            fired.fulfill()
        }
        defer { guardian.cancel() }
        // A process-directed signal, as the caller's SIGTERM is; raise() targets only this thread.
        kill(getpid(), SIGUSR1)
        wait(for: [fired], timeout: 2)
        XCTAssertEqual(restoration, "restored")
        try assertOriginal()
    }
}

extension ClipboardPasteTests {
    /// An html or md paste is rendered by the receiver, so its markup never shows in AXValue.
    func testRenderedMarkupCountsAsLandedForAnInsertion() throws {
        let transaction = try ClipboardTransaction(board: board)
        let field = Field(board: board, value: "Note: ")
        var primitives = field.primitives(ours: "<b>bold</b>")
        let post = primitives.postPaste
        primitives.postPaste = {
            try post()
            field.pendingPasteAt = nil
            field.value = "Note: bold"
        }
        let outcome = try performClipboardPaste(transaction: transaction, text: "<b>bold</b>", format: "html",
                                                replace: false, primitives: primitives)
        XCTAssertEqual(outcome.readback, "Note: bold")
        try assertOriginal()
    }

    func testLineEndingsAreComparedNormalized() {
        XCTAssertTrue(insertedTextVisible("a\nb", text: "a\r\nb", format: "text"))
        XCTAssertFalse(insertedTextVisible("ab", text: "a\r\nb", format: "text"))
    }
}
