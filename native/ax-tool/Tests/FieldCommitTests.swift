import XCTest
@testable import SnapshotSupport

final class FieldCommitTests: XCTestCase {
    /// The observed failure: the omnibox lost its last character, and Return submitted it anyway.
    func testReturnIsRefusedWhenTheFieldTextChangedSinceItWasObserved() throws {
        let refusal = try XCTUnwrap(commitRefusal(role: "AXTextField", code: NativeKeyChord("return").code,
                                                  observed: "https://genesis.tools/t/D5iPWv28aiBR",
                                                  live: "https://genesis.tools/t/D5iPWv28aiB"))
        XCTAssertTrue(refusal.contains("observed \"https://genesis.tools/t/D5iPWv28aiBR\", now \"https://genesis.tools/t/D5iPWv28aiB\""), refusal)
        XCTAssertNotNil(commitRefusal(role: "AXComboBox", code: try NativeKeyChord("kp_enter").code, observed: "a", live: nil))
    }

    func testAnUnchangedFieldOrANonCommitKeyIsNotRefused() throws {
        XCTAssertNil(commitRefusal(role: "AXTextField", code: try NativeKeyChord("return").code, observed: "same", live: "same"))
        XCTAssertNil(commitRefusal(role: "AXTextField", code: try NativeKeyChord("tab").code, observed: "a", live: "b"))
        XCTAssertNil(commitRefusal(role: "AXButton", code: try NativeKeyChord("return").code, observed: "a", live: "b"))
        XCTAssertNil(commitRefusal(role: "AXTextField", code: try NativeKeyChord("return").code, observed: nil, live: "b"))
    }

    /// A paste fills a field; it must never be able to submit it.
    func testPasteKeysAreNeverCommitKeys() throws {
        XCTAssertFalse(commitKeyCodes.contains(ClipboardPasteKeys.selectAll))
        XCTAssertFalse(commitKeyCodes.contains(ClipboardPasteKeys.paste))
        XCTAssertEqual(ClipboardPasteKeys.selectAll, try NativeKeyChord("a").code)
        XCTAssertEqual(ClipboardPasteKeys.paste, try NativeKeyChord("v").code)
        XCTAssertTrue(commitKeyCodes.contains(try NativeKeyChord("enter").code))
    }

    func testARewriteShortlyAfterTheWriteIsReported() {
        var time: TimeInterval = 0
        var reads = ["full", "full", "ful"]
        let rewritten = valueRewrittenAfterWrite(written: "full", now: { time }, wait: { time += $0 },
                                                 read: { reads.isEmpty ? "ful" : reads.removeFirst() })
        XCTAssertEqual(rewritten, "ful")
        time = 0
        XCTAssertNil(valueRewrittenAfterWrite(written: "full", now: { time }, wait: { time += $0 }, read: { "full" }))
        XCTAssertEqual(time, 0.3, accuracy: 0.0001)
    }
}
