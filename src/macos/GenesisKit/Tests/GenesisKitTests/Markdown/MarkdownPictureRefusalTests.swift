import XCTest
@testable import GenesisKit

/// Why a picture shows nothing: `MarkdownMedia.Refusal` and the answer `MarkdownMediaRegistry.update` hands the page.
/// One test per reason, plus the setting that allows a folder. The page's sentences are in
/// `MarkdownWebSecurityTests.testAPictureThatShowsNothingSaysWhy`.
final class MarkdownPictureRefusalTests: XCTestCase {
    private var base: URL!
    private var vault: URL!
    private var outside: URL!
    private var context: MarkdownMedia.Context!

    override func setUpWithError() throws {
        let fm = FileManager.default
        base = fm.temporaryDirectory.appendingPathComponent("md-refusal-\(UUID().uuidString)")
        vault = base.appendingPathComponent("vault/Notes")
        outside = base.appendingPathComponent("outside")
        try fm.createDirectory(at: vault, withIntermediateDirectories: true)
        try fm.createDirectory(at: outside, withIntermediateDirectories: true)
        context = MarkdownMedia.Context(folder: vault, vaultRoot: base.appendingPathComponent("vault"))
    }

    override func tearDownWithError() throws {
        try? FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: vault.appendingPathComponent("locked.png").path)
        try? FileManager.default.removeItem(at: base)
    }

    private func answer(_ markdown: String, _ context: MarkdownMedia.Context? = nil) -> [String: [String: String]] {
        MarkdownMediaRegistry().update(markdown: markdown, context: context ?? self.context)
    }

    func testAMissingPictureIsMissingWithItsPath() {
        let item = answer("![](nowhere.png)")["nowhere.png"]
        XCTAssertEqual(item?["kind"], "refused")
        XCTAssertEqual(item?["reason"], "missing")
        XCTAssertEqual(item?["path"], "nowhere.png")
    }

    func testAPictureOutsideTheFoldersIsOutsideWithItsAbsolutePath() throws {
        let file = outside.appendingPathComponent("shot.png")
        try Data([0x89]).write(to: file)
        let item = answer("![](\(file.path))")[file.path]
        XCTAssertEqual(item?["reason"], "outsideRoots")
        XCTAssertEqual(item?["path"], file.standardizedFileURL.path)
        XCTAssertNil(item?["token"], "the page never gets a way to load it")
    }

    func testAFolderTheReaderAllowedShowsItsPicturesAndOnlyThose() throws {
        let file = outside.appendingPathComponent("shot.png")
        let other = base.appendingPathComponent("other")
        try FileManager.default.createDirectory(at: other, withIntermediateDirectories: true)
        try Data([0x89]).write(to: file)
        try Data([0x89]).write(to: other.appendingPathComponent("x.png"))
        var allowed = context!
        allowed.extraRoots = [outside]
        let map = answer("![](\(file.path))\n\n![](\(other.path)/x.png)", allowed)
        XCTAssertEqual(map[file.path]?["kind"], "image")
        XCTAssertNotNil(map[file.path]?["token"])
        XCTAssertEqual(map["\(other.path)/x.png"]?["reason"], "outsideRoots", "a sibling folder is not allowed by it")
        XCTAssertNotEqual(allowed, context, "a changed allow list makes the page render again")
    }

    func testAPictureAllowanceDoesNotAdmitJSONDocuments() throws {
        let file = outside.appendingPathComponent("private.json")
        try Data("{}".utf8).write(to: file)
        var allowed = context!
        allowed.extraRoots = [outside]
        XCTAssertNil(MarkdownMedia.admitted(file, in: allowed))
        XCTAssertNil(answer("[document](\(file.path))", allowed)[file.path]?["token"])
        let local = vault.appendingPathComponent("local.json")
        try Data("{}".utf8).write(to: local)
        XCTAssertNotNil(MarkdownMedia.admitted(local, in: allowed))
    }

    func testAPictureTheProcessCannotReadIsNotReadable() throws {
        let file = vault.appendingPathComponent("locked.png")
        try Data([0x89]).write(to: file)
        try FileManager.default.setAttributes([.posixPermissions: 0], ofItemAtPath: file.path)
        XCTAssertEqual(answer("![](locked.png)")["locked.png"]?["reason"], "notReadable")
    }

    func testAFolderNamedLikeAPictureIsNotReadable() throws {
        try FileManager.default.createDirectory(at: vault.appendingPathComponent("dir.png"), withIntermediateDirectories: true)
        XCTAssertEqual(answer("![](dir.png)")["dir.png"]?["reason"], "notReadable")
    }

    func testATypeTheViewerDoesNotShowIsNotAPicture() throws {
        try Data([1]).write(to: vault.appendingPathComponent("scan.heic"))
        try Data([1]).write(to: vault.appendingPathComponent("scan.tiff"))
        let map = answer("![](scan.heic)\n\n![[scan.tiff]]\n\n![[Some note]]\n\n[link](scan.heic)")
        XCTAssertEqual(map["scan.heic"]?["reason"], "notAPicture")
        XCTAssertEqual(map["scan.tiff"]?["reason"], "notAPicture", "a wikilink embed of a known picture type too")
        XCTAssertNil(map["Some note"], "an embedded note is no picture")
        XCTAssertEqual(map.count, 2, "a plain link to a heic file stays a link")
    }

    func testAPictureOverTheLimitIsTooLargeWithItsSize() throws {
        let file = vault.appendingPathComponent("huge.png")
        FileManager.default.createFile(atPath: file.path, contents: nil)
        let handle = try FileHandle(forWritingTo: file)
        try handle.truncate(atOffset: UInt64(MarkdownMedia.maxImageBytes) + 1)
        try handle.close()
        let registry = MarkdownMediaRegistry()
        let item = registry.update(markdown: "![](huge.png)", context: context)["huge.png"]
        XCTAssertEqual(item?["reason"], "tooLarge")
        XCTAssertEqual(item?["limit"], "64 MB")
        XCTAssertEqual(item?["size"], "65 MB")
        XCTAssertTrue(registry.entries.isEmpty, "a file over the limit is not registered")
    }

    func testALinkToAMissingJSONFileStaysALink() {
        XCTAssertNil(answer("[data](gone.json)")["gone.json"])
        XCTAssertNil(answer("![[gone.json]]")["gone.json"], "an embedded JSON file is a chip, not a picture")
    }

    @MainActor
    func testTheSettingKeepsItsFoldersAndStartsEmpty() throws {
        let suite = "md-refusal-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let configuration = GenesisKitMarkdownConfiguration(defaults: defaults)
        XCTAssertEqual(configuration.pictureFolders, [])
        configuration.pictureFolders = ["~/Pictures/notes"]
        XCTAssertEqual(GenesisKitMarkdownConfiguration(defaults: defaults).pictureFolders, ["~/Pictures/notes"])
    }
}
