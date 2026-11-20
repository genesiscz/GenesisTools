import XCTest

extension RandomAccessCollection where Index == Int {
    /// The element at `index`, or a failed test where `self[index]` would trap and end the whole test process, so a
    /// regression that drops a row fails one assertion instead of every test after it.
    func required(_ index: Int, file: StaticString = #filePath, line: UInt = #line) throws -> Element {
        try XCTUnwrap(indices.contains(index) ? self[index] : nil, "no element \(index) among \(count)", file: file, line: line)
    }
}
