import XCTest
@testable import GenesisKit

final class TextMergeTests: XCTestCase {
    private func merged(_ base: String, _ ours: String, _ theirs: String) -> (String, Int) {
        let r = TextMerge.merge(base: base, ours: ours, theirs: theirs)
        return (r.text(trailingNewline: true), r.conflictCount)
    }

    func testUnchangedSidesReturnTheBase() {
        let (t, c) = merged("a\nb\nc\n", "a\nb\nc\n", "a\nb\nc\n")
        XCTAssertEqual(t, "a\nb\nc\n"); XCTAssertEqual(c, 0)
    }

    func testOneSideChangedWinsWithoutConflict() {
        XCTAssertEqual(merged("a\nb\nc\n", "a\nB\nc\n", "a\nb\nc\n").0, "a\nB\nc\n")
        XCTAssertEqual(merged("a\nb\nc\n", "a\nb\nc\n", "a\nb\nC\n").0, "a\nb\nC\n")
    }

    func testDisjointEditsOnBothSidesCombine() {
        // Mine edits line 2, disk appends line 4: both land.
        let (t, c) = merged("a\nb\nc\n", "a\nB\nc\n", "a\nb\nc\nd\n")
        XCTAssertEqual(t, "a\nB\nc\nd\n"); XCTAssertEqual(c, 0)
    }

    func testSameEditOnBothSidesIsNotAConflict() {
        let (t, c) = merged("a\nb\nc\n", "a\nB\nc\n", "a\nB\nc\n")
        XCTAssertEqual(t, "a\nB\nc\n"); XCTAssertEqual(c, 0)
    }

    func testDifferentEditsOfTheSameLineConflictWithLabelledMarkers() {
        let r = TextMerge.merge(base: "a\nb\nc\n", ours: "a\nB1\nc\n", theirs: "a\nB2\nc\n")
        XCTAssertEqual(r.conflictCount, 1)
        XCTAssertEqual(
            r.text(trailingNewline: true),
            "a\n<<<<<<< mine\nB1\n=======\nB2\n>>>>>>> on disk\nc\n"
        )
        XCTAssertEqual(r.regions.count, 3)
        XCTAssertEqual(r.regions[1], .conflict(base: ["b"], ours: ["B1"], theirs: ["B2"]))
    }

    func testDeleteVersusEditConflicts() {
        let (_, c) = merged("a\nb\nc\n", "a\nc\n", "a\nB\nc\n")
        XCTAssertEqual(c, 1)
    }

    func testInsertionsAtTheSameSpotFromBothSidesConflict() {
        let (_, c) = merged("a\nb\n", "a\nx\nb\n", "a\ny\nb\n")
        XCTAssertEqual(c, 1)
    }

    func testEmptyBaseTreatsBothSidesAsInsertions() {
        XCTAssertEqual(merged("", "hello\n", "").0, "hello\n")
        XCTAssertEqual(merged("", "hello\n", "hello\n").0, "hello\n")
        XCTAssertEqual(merged("", "one\n", "two\n").1, 1)
    }

    func testTrailingNewlineFollowsTheCaller() {
        let r = TextMerge.merge(base: "a", ours: "a\nb", theirs: "a")
        XCTAssertEqual(r.text(trailingNewline: false), "a\nb")
        XCTAssertEqual(r.text(trailingNewline: true), "a\nb\n")
    }

    func testTwoWayDiffInterleavesRemovalsBeforeInsertions() {
        let d = TextMerge.diff(old: "a\nb\nc\n", new: "a\nB\nc\nd\n")
        XCTAssertEqual(d, [.equal("a"), .removed("b"), .inserted("B"), .equal("c"), .inserted("d")])
    }

    /// `git merge-file` (git's xdiff) is the oracle: on every generated triple,
    /// a clean merge must be byte-identical to git's, and the two must agree on
    /// whether the triple conflicts at all. NOT `/usr/bin/diff3 -m`: the FreeBSD
    /// diff3 shipped with macOS 26 drops lines next to an insertion and prints
    /// "invalid print range" on some inputs (seen 2026-09-08).
    func testAgreesWithGitMergeFileOnGeneratedTriples() throws {
        var rng = SystemRandomNumberGenerator()
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("diff3-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        var cleanChecked = 0, conflictChecked = 0
        for _ in 0..<150 {
            let base = (0..<Int.random(in: 3...12, using: &rng)).map { "L\($0)" }
            let ours = mutate(base, using: &rng)
            let theirs = mutate(base, using: &rng)
            let b = base.joined(separator: "\n") + "\n"
            let o = ours.joined(separator: "\n") + "\n"
            let t = theirs.joined(separator: "\n") + "\n"
            let mine = TextMerge.merge(base: b, ours: o, theirs: t)
            let (out, status) = try gitMergeFile(dir: dir, base: b, ours: o, theirs: t)
            if status == 0 {
                XCTAssertEqual(mine.conflictCount, 0, "git merged cleanly but we conflicted:\nbase=\(base)\nours=\(ours)\ntheirs=\(theirs)")
                XCTAssertEqual(mine.text(trailingNewline: true), out, "base=\(base)\nours=\(ours)\ntheirs=\(theirs)")
                cleanChecked += 1
            } else {
                XCTAssertGreaterThan(mine.conflictCount, 0, "git conflicted but we merged:\nbase=\(base)\nours=\(ours)\ntheirs=\(theirs)")
                conflictChecked += 1
            }
        }
        XCTAssertGreaterThan(cleanChecked, 20)
        XCTAssertGreaterThan(conflictChecked, 5)
    }

    private func mutate(_ lines: [String], using rng: inout SystemRandomNumberGenerator) -> [String] {
        var out = lines
        for _ in 0..<Int.random(in: 0...2, using: &rng) {
            switch Int.random(in: 0..<3, using: &rng) {
            case 0 where !out.isEmpty: out[Int.random(in: 0..<out.count, using: &rng)] = "E\(Int.random(in: 0..<9, using: &rng))"
            case 1 where !out.isEmpty: out.remove(at: Int.random(in: 0..<out.count, using: &rng))
            default: out.insert("I\(Int.random(in: 0..<9, using: &rng))", at: Int.random(in: 0...out.count, using: &rng))
            }
        }
        return out
    }

    /// stdout = merged text, status = number of conflicts (git's contract).
    private func gitMergeFile(dir: URL, base: String, ours: String, theirs: String) throws -> (String, Int32) {
        let b = dir.appendingPathComponent("base"), o = dir.appendingPathComponent("ours"), t = dir.appendingPathComponent("theirs")
        try base.write(to: b, atomically: true, encoding: .utf8)
        try ours.write(to: o, atomically: true, encoding: .utf8)
        try theirs.write(to: t, atomically: true, encoding: .utf8)
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        p.arguments = ["merge-file", "-p", "-L", "mine", "-L", "base", "-L", "on disk", o.path, b.path, t.path]
        let pipe = Pipe()
        p.standardOutput = pipe
        try p.run()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return (String(decoding: data, as: UTF8.self), p.terminationStatus)
    }
}
