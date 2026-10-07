import XCTest
@testable import GenesisKit

/// A Session Details banner reading only "expected JSON object" tells the
/// reader nothing: not which command, not what it printed, not why. These pin
/// down that a `tools` response we cannot read explains itself.
final class MonitorJSONDiagnosticTests: XCTestCase {
    private func message(_ block: () throws -> Void) -> String {
        do {
            try block()
            return ""
        } catch let error as ToolsBridgeError {
            if case .refused(let m) = error { return m }
            return "\(error)"
        } catch {
            return error.localizedDescription
        }
    }

    func testPlainJSONIsReturnedUntouched() throws {
        let data = Data(#"{"rows":[]}"#.utf8)
        XCTAssertEqual(try MonitorJSON.dataByDroppingPreamble(data), data)
    }

    func testABannerBeforeTheJSONIsDropped() throws {
        let data = Data("loading accounts…\n[profile:x] 12ms\n{\"rows\":[]}".utf8)
        let out = try MonitorJSON.dataByDroppingPreamble(data)
        XCTAssertEqual(String(decoding: out, as: UTF8.self), #"{"rows":[]}"#)
    }

    func testABraceInsideTheNoiseDoesNotDerailTheParse() throws {
        // The old code took the FIRST brace on faith and handed the decoder
        // garbage, which surfaced as "the data couldn't be read".
        let data = Data("warn: bad config {see docs}\n{\"rows\":[]}".utf8)
        let out = try MonitorJSON.dataByDroppingPreamble(data)
        XCTAssertEqual(String(decoding: out, as: UTF8.self), #"{"rows":[]}"#)
    }

    func testEmptyOutputSaysSoRatherThanBlamingTheJSON() {
        let text = message { _ = try MonitorJSON.dataByDroppingPreamble(Data("   \n".utf8)) }
        XCTAssertTrue(text.contains("printed nothing"), text)
    }

    func testUnparseableOutputQuotesWhatArrived() {
        let text = message { _ = try MonitorJSON.dataByDroppingPreamble(Data("command not found: tools".utf8)) }
        XCTAssertTrue(text.contains("command not found: tools"), text)
    }

    func testTheQuoteIsOneLineAndBounded() {
        let noisy = (0..<50).map { "line \($0)" }.joined(separator: "\n")
        let preview = MonitorJSON.preview(noisy, limit: 40)
        XCTAssertFalse(preview.contains("\n"))
        XCTAssertLessThanOrEqual(preview.count, 41)
    }

    func testAFailureReasonSkipsTheProfilerTimingsThatComeFirst() {
        let stderr = """
        [profile:ai-spend] pricing 0.375ms
        [profile:ai-spend] monitor:accounts 13.58ms
        [profile:ai-spend] monitor:build 1.515s
        ERROR: undefined is not an object (evaluating 'entry.events.map')
        """
        XCTAssertEqual(
            MonitorJSON.failureReason(stderr),
            "ERROR: undefined is not an object (evaluating 'entry.events.map')"
        )
    }

    func testAFailureReasonQuotesTheTimingsWhenThereIsNothingElse() {
        XCTAssertEqual(MonitorJSON.failureReason("[profile:x] a 1ms\n[profile:x] b 2ms"), "[profile:x] a 1ms ⏎ [profile:x] b 2ms")
        XCTAssertEqual(MonitorJSON.failureReason(""), "")
    }

    func testAFailureReasonWithoutProfilerLinesIsThePlainPreview() {
        XCTAssertEqual(MonitorJSON.failureReason("boom\nsecond"), "boom ⏎ second")
    }

    func testADecodingErrorNamesTheKeyInsteadOfSayingNothing() {
        struct Envelope: Decodable { let rows: [String] }
        do {
            _ = try JSONDecoder().decode(Envelope.self, from: Data(#"{"other":1}"#.utf8))
            XCTFail("should not decode")
        } catch let error as DecodingError {
            let detail = MonitorJSON.failureDetail(error, stdout: #"{"other":1}"#, stderr: "")
            XCTAssertTrue(detail.contains("missing key rows"), detail)
            XCTAssertTrue(detail.contains(#"stdout: {"other":1}"#), detail)
        } catch {
            XCTFail("wrong error: \(error)")
        }
    }

    func testStderrRidesAlongWhenThereIsAny() {
        let detail = MonitorJSON.failureDetail(
            ToolsBridgeError.refused("nope"), stdout: "", stderr: "tools: no such subcommand"
        )
        XCTAssertTrue(detail.contains("nope"), detail)
        XCTAssertTrue(detail.contains("stderr: tools: no such subcommand"), detail)
    }
}
