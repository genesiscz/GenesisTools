import XCTest
@testable import GenesisKitBase
@testable import GenesisKit

final class ShellWordsTests: XCTestCase {
    func testQuotedIsAlwaysOneWordWhoseQuotesAreEscaped() {
        XCTAssertEqual(ShellWords.quoted("/Users/someone/Acme app"), "'/Users/someone/Acme app'")
        XCTAssertEqual(ShellWords.quoted("/tmp/it's"), "'/tmp/it'\\''s'")
        XCTAssertEqual(ShellWords.quoted(""), "''")
    }

    func testWordQuotesOnlyWhatAShellWouldRead() {
        let words = ["tools", "claude", "resume", "11111111-2222-4333-8444-555555555555"]
        XCTAssertEqual(words.map(ShellWords.word).joined(separator: " "), "tools claude resume 11111111-2222-4333-8444-555555555555")
        XCTAssertEqual(ShellWords.word("id; rm -r x"), "'id; rm -r x'")
        XCTAssertEqual(ShellWords.word("$(whoami)"), "'$(whoami)'")
        XCTAssertEqual(ShellWords.word("~/notes"), "'~/notes'", "a bare ~ would expand to a home folder")
        XCTAssertEqual(ShellWords.word(""), "''")
        XCTAssertEqual(ShellWords.word("=cat"), "'=cat'", "zsh would expand a leading =")
    }

    func testAQuotedWordRunsAsTheSameTextInARealShell() throws {
        let tricky = "a'; touch injected-marker; echo '$(whoami) `x` \"q\""
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = ["-c", "printf %s \(ShellWords.quoted(tricky))"]
        let output = Pipe()
        process.standardOutput = output
        try process.run()
        let data = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        XCTAssertEqual(String(decoding: data, as: UTF8.self), tricky)
    }
}
