import XCTest
@testable import GenesisKit

/// Spec 06 T5 — sidecar SQLite FTS5 index + search quality + latency gate.
final class VaultIndexTests: XCTestCase {
    private var dir: URL!
    private var index: VaultIndex!

    override func setUp() async throws {
        dir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("genesis-index-\(UUID().uuidString)")
        index = try VaultIndex(vaultRoot: "/tmp/fake-vault", directory: dir)
    }

    override func tearDown() async throws {
        index = nil
        try? FileManager.default.removeItem(at: dir)
    }

    func testUpsertAndSearchBody() {
        index.upsert(
            path: "notes/alpha.md", title: "alpha", body: "the quick zebra jumps",
            mtimeMs: 1000, headings: ["Intro"], tags: ["animal"], props: "status:open",
            resolvedLinkPaths: []
        )
        let rows = index.search(query: "zebra")
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows.first?.path, "notes/alpha.md")
        XCTAssertNotNil(rows.first?.snippet)
    }

    func testFullBodyIndexedBeyond40k() {
        // Gap G18: the old in-memory corpus capped bodies at 40k chars and
        // silently lost matches. FTS must find a term past that boundary.
        let filler = String(repeating: "lorem ipsum dolor sit amet ", count: 2000) // ~54k chars
        let body = filler + "\nUNIQUE-DEEP-TOKEN-99 appears only at the very end"
        XCTAssertGreaterThan(filler.count, 40_000)
        index.upsert(
            path: "big.md", title: "big", body: body, mtimeMs: 1,
            headings: [], tags: [], props: "", resolvedLinkPaths: []
        )
        let rows = index.search(query: "UNIQUE-DEEP-TOKEN-99")
        XCTAssertEqual(rows.first?.path, "big.md", "body terms beyond 40k chars must be searchable")
    }

    func testMultiTermAnd() {
        index.upsert(path: "a.md", title: "a", body: "apples and oranges", mtimeMs: 1,
                     headings: [], tags: [], props: "", resolvedLinkPaths: [])
        index.upsert(path: "b.md", title: "b", body: "apples and bananas", mtimeMs: 1,
                     headings: [], tags: [], props: "", resolvedLinkPaths: [])
        let rows = index.search(query: "apples oranges")
        XCTAssertEqual(rows.map(\.path), ["a.md"], "multi-term queries AND together")
    }

    func testPropertySearch() {
        index.upsert(path: "p.md", title: "p", body: "body text", mtimeMs: 1,
                     headings: [], tags: ["project"], props: "status:in-progress priority:1",
                     resolvedLinkPaths: [])
        let rows = index.search(query: "in-progress")
        XCTAssertEqual(rows.first?.path, "p.md")
        XCTAssertTrue(rows.first?.matchedProps == true)
    }

    func testRemoveAndBacklinks() {
        index.upsert(path: "src.md", title: "src", body: "[[dst]]", mtimeMs: 1,
                     headings: [], tags: [], props: "", resolvedLinkPaths: ["dst.md"])
        index.upsert(path: "dst.md", title: "dst", body: "target", mtimeMs: 1,
                     headings: [], tags: [], props: "", resolvedLinkPaths: [])
        XCTAssertEqual(index.backlinks(of: "dst.md"), ["src.md"])
        XCTAssertEqual(index.allLinks().count, 1)
        index.remove(path: "src.md")
        XCTAssertEqual(index.backlinks(of: "dst.md"), [])
        XCTAssertEqual(index.noteCount(), 1)
    }

    func testInjectionSafeMatchExpression() {
        XCTAssertEqual(VaultIndex.ftsMatchExpression("foo bar"), "\"foo\"* AND \"bar\"*")
        XCTAssertEqual(VaultIndex.ftsMatchExpression("a\"b OR *"), "\"ab\"* AND \"or\"* AND \"*\"*")
        // Must not crash / must return no rows rather than SQL error
        _ = index.search(query: "\" OR 1=1 --")
    }

    /// Latency gate (Spec 06 M1#7): warm p95 keystroke query < 16 ms on a
    /// 5k-note synthetic corpus. Honest hard assertion — do not delete.
    func testWarmQueryLatencyP95Under16msOn5kNotes() {
        for i in 0..<5000 {
            index.upsert(
                path: "notes/n\(i).md",
                title: "note-\(i)",
                body: "synthetic body \(i) with shared corpus words alpha beta gamma delta epsilon token\(i % 97)",
                mtimeMs: Double(i),
                headings: ["Heading \(i % 13)"],
                tags: ["t\(i % 7)"],
                props: "status:\(i % 2 == 0 ? "open" : "done")",
                resolvedLinkPaths: []
            )
        }
        XCTAssertEqual(index.noteCount(), 5000)
        // Warm-up
        for q in ["alpha", "token1", "note-42"] { _ = index.search(query: q) }
        var samples: [Double] = []
        let queries = ["alpha", "beta gamma", "token5", "note-49", "delta", "status", "gam", "epsi", "note", "token12"]
        for _ in 0..<5 {
            for q in queries {
                let t0 = DispatchTime.now()
                _ = index.search(query: q, limit: 60)
                let ms = Double(DispatchTime.now().uptimeNanoseconds - t0.uptimeNanoseconds) / 1_000_000
                samples.append(ms)
            }
        }
        samples.sort()
        let p95 = samples[Int(Double(samples.count) * 0.95)]
        print("VaultIndex latency: p50=\(samples[samples.count / 2])ms p95=\(p95)ms n=\(samples.count) corpus=5000")
        XCTAssertLessThan(p95, 16.0, "warm p95 keystroke query must stay under 16ms on 5k notes")
    }
}

/// What the markdown viewer's `[[` / `#` completion and the Properties block read from the index.
final class VaultIndexSuggestionTests: XCTestCase {
    private func scratch(_ name: String) -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("\(name)-\(UUID().uuidString)")
    }

    /// The index answers both lists, ranked so an exact prefix comes first.
    func testTheIndexAnswersNamesAndTags() throws {
        let index = try VaultIndex(vaultRoot: "/vault", directory: scratch("md-complete"))
        index.upsert(
            path: "Work/Overview.md", title: "Overview", body: "b", mtimeMs: 3, headings: [],
            tags: ["frontend", "cleanup"], props: "", resolvedLinkPaths: []
        )
        index.upsert(
            path: "Work/OpenMergeRequests.md", title: "Open MRs", body: "b", mtimeMs: 2, headings: [],
            tags: ["frontend"], props: "", resolvedLinkPaths: []
        )
        index.upsert(
            path: "Dev/Overnight.md", title: "Overnight", body: "b", mtimeMs: 1, headings: [],
            tags: ["dev"], props: "", resolvedLinkPaths: []
        )

        XCTAssertEqual(index.noteNames(matching: "over"), ["Overview", "Overnight"])
        XCTAssertEqual(index.noteNames(matching: "merge"), ["OpenMergeRequests"])
        XCTAssertEqual(index.noteNames(matching: "nothing"), [])
        // Wikilinks name the file, not the title.
        XCTAssertFalse(index.noteNames(matching: "").contains("Open MRs"))
        // Both contain "f"; the one used by more notes leads.
        XCTAssertEqual(index.tags(matching: "f"), ["frontend"])
        XCTAssertEqual(index.tags(matching: "c"), ["cleanup"])
        XCTAssertEqual(index.tags(matching: ""), ["frontend", "cleanup", "dev"])
    }

    func testTheIndexRanksKeysAndValuesByUse() throws {
        let index = try VaultIndex(vaultRoot: "/vault", directory: scratch("md-vocab"))
        func note(_ path: String, _ props: String) {
            index.upsert(path: path, title: path, body: "b", mtimeMs: 1, headings: [], tags: [], props: props, resolvedLinkPaths: [])
        }
        note("a.md", "status:DRAFT owner:alice")
        note("b.md", "status:DRAFT")
        note("c.md", "status:done ticket:1234")

        let vocabulary = index.propertyVocabulary()
        XCTAssertEqual(vocabulary["status"], ["DRAFT", "done"])
        XCTAssertEqual(vocabulary["owner"], ["alice"])
        XCTAssertEqual(vocabulary["ticket"], ["1234"])
        XCTAssertNil(vocabulary["missing"])
    }

    /// A reader of someone else's index never creates one: no folder, no file, no tables.
    func testReadOnlyOpenOfAMissingIndexThrowsAndCreatesNothing() {
        let dir = scratch("md-readonly-missing")
        XCTAssertThrowsError(try VaultIndex(vaultRoot: "/vault", directory: dir, readOnly: true))
        XCTAssertFalse(FileManager.default.fileExists(atPath: dir.path))
    }

    func testReadOnlyOpenReadsWhatTheWriterIndexed() throws {
        let dir = scratch("md-readonly")
        let writer = try VaultIndex(vaultRoot: "/vault", directory: dir)
        writer.upsert(
            path: "notes/plan.md", title: "Plan", body: "b", mtimeMs: 1, headings: [],
            tags: ["roadmap"], props: "status:open", resolvedLinkPaths: []
        )

        let reader = try VaultIndex(vaultRoot: "/vault", directory: dir, readOnly: true)
        XCTAssertEqual(reader.noteNames(matching: "pl"), ["plan"])
        XCTAssertEqual(reader.tags(matching: "road"), ["roadmap"])
        XCTAssertEqual(reader.propertyVocabulary()["status"], ["open"])
    }
}
