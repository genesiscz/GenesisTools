import Foundation
import XCTest

@MainActor
extension XCTestCase {
    /// Polls `condition` on the main actor until it holds. Past `timeout` the test fails at the caller's line and the
    /// wait returns, so a condition that never holds fails the test instead of hanging the run.
    func until(_ what: String, timeout: TimeInterval = 5, file: StaticString = #filePath, line: UInt = #line,
               _ condition: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() {
            guard Date() < deadline else {
                return XCTFail("timed out after \(timeout) s waiting until \(what)", file: file, line: line)
            }
            try await Task.sleep(for: .milliseconds(10))
        }
    }
}
