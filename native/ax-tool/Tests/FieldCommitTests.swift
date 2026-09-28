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

    /// A stable-key pin re-resolves a field whose text changed after `see`; the act's own read then
    /// already holds the new text, so only the caller's observed value can catch it.
    func testTheCallersObservedValueWinsOverTheActsOwnRead() throws {
        let observedAtSee = fieldValueDigest("https://genesis.tools/t/D5iPWv28aiBR")
        let refusal = try XCTUnwrap(commitRefusal(role: "AXTextField", code: NativeKeyChord("return").code,
                                                  observed: "https://genesis.tools/t/D5iPWv28aiB",
                                                  live: "https://genesis.tools/t/D5iPWv28aiB", expectedDigest: observedAtSee))
        XCTAssertTrue(refusal.contains("changed since it was observed"), refusal)
        XCTAssertNil(commitRefusal(role: "AXTextField", code: try NativeKeyChord("return").code, observed: "same",
                                   live: "same", expectedDigest: fieldValueDigest("same")))
        XCTAssertNotNil(commitRefusal(role: "AXTextField", code: try NativeKeyChord("return").code, observed: nil,
                                      live: nil, expectedDigest: fieldValueDigest("same")))
        XCTAssertEqual(fieldValueDigest("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
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
