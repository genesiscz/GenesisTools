import CoreImage
import XCTest
@testable import GenesisToolsRecorder

/// A background picture or an intro logo is read again when its file changes at the same path, written in place or
/// replaced by a rename, so the preview, a still and an export draw the file as it is now, not as it was when the
/// long-lived app first drew it. A missing file draws the background's colour.
final class RecorderHuntBackgroundPictureCacheTests: XCTestCase {
    private let context = CIContext()
    private let sRGB = CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB()
    private var folder: URL!

    override func setUpWithError() throws {
        folder = FileManager.default.temporaryDirectory
            .appendingPathComponent("recorder-hunt-background-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: folder)
    }

    /// A solid 32 x 32 PNG of one colour.
    private func png(_ color: CIColor) throws -> Data {
        let image = CIImage(color: color).cropped(to: CGRect(x: 0, y: 0, width: 32, height: 32))
        return try XCTUnwrap(context.pngRepresentation(of: image, format: .RGBA8, colorSpace: sRGB))
    }

    /// Writes over the file's bytes, so the path keeps its inode.
    private func overwriteInPlace(_ url: URL, with data: Data) throws {
        let handle = try FileHandle(forWritingTo: url)
        try handle.truncate(atOffset: 0)
        try handle.write(contentsOf: data)
        try handle.close()
    }

    private func inode(_ url: URL) throws -> Int {
        try XCTUnwrap(FileManager.default.attributesOfItem(atPath: url.path)[.systemFileNumber] as? Int)
    }

    /// The middle pixel of the background drawn on a 16 x 16 canvas, as red, green, blue.
    private func drawn(_ background: EditProject.Background) -> (red: UInt8, green: UInt8, blue: UInt8) {
        let image = Looks.background(background, size: CGSize(width: 16, height: 16))
        var pixel = [UInt8](repeating: 0, count: 4)
        context.render(image, toBitmap: &pixel, rowBytes: 4, bounds: CGRect(x: 8, y: 8, width: 1, height: 1),
                       format: .RGBA8, colorSpace: sRGB)
        return (pixel[0], pixel[1], pixel[2])
    }

    private func picture(_ url: URL) -> EditProject.Background {
        EditProject.Background(kind: .image, colors: ["#FFFFFF"], image: url.path, blur: nil)
    }

    func testABackgroundPictureIsReadAgainAfterItsFileChangesAtTheSamePath() throws {
        let url = folder.appendingPathComponent("background.png")
        try png(CIColor(red: 1, green: 0, blue: 0)).write(to: url)
        let background = picture(url)

        let red = drawn(background)
        XCTAssertGreaterThan(red.red, 200, "the first picture is red")
        XCTAssertLessThan(red.blue, 50)

        let before = try inode(url)
        try overwriteInPlace(url, with: try png(CIColor(red: 0, green: 0, blue: 1)))
        XCTAssertEqual(try inode(url), before, "the test writes over the same file")
        let blue = drawn(background)
        XCTAssertGreaterThan(blue.blue, 200, "a picture written over in place draws the new bytes, not the cached red")
        XCTAssertLessThan(blue.red, 50)

        let next = folder.appendingPathComponent("background.next.png")
        try png(CIColor(red: 0, green: 1, blue: 0)).write(to: next)
        _ = try FileManager.default.replaceItemAt(url, withItemAt: next)
        let green = drawn(background)
        XCTAssertGreaterThan(green.green, 200, "a picture replaced by a rename draws the new file")
        XCTAssertLessThan(green.red, 50)
        XCTAssertLessThan(green.blue, 50)
    }

    func testAMissingPictureDrawsTheBackgroundColour() throws {
        let url = folder.appendingPathComponent("gone.png")
        try png(CIColor(red: 1, green: 0, blue: 0)).write(to: url)
        let background = picture(url)
        XCTAssertGreaterThan(drawn(background).red, 200)
        XCTAssertLessThan(drawn(background).blue, 50)

        try FileManager.default.removeItem(at: url)
        XCTAssertNil(Looks.BackgroundPictures.shared.image(url.path), "a file that is gone has no picture")
        let fallback = drawn(background)
        XCTAssertGreaterThan(fallback.red, 200, "the white background colour draws instead")
        XCTAssertGreaterThan(fallback.green, 200)
        XCTAssertGreaterThan(fallback.blue, 200)
    }

    func testAnUnchangedPictureIsDecodedOnce() throws {
        let url = folder.appendingPathComponent("logo.png")
        try png(CIColor(red: 0, green: 0, blue: 1)).write(to: url)
        let first = try XCTUnwrap(Looks.BackgroundPictures.shared.image(url.path))
        let second = try XCTUnwrap(Looks.BackgroundPictures.shared.image(url.path))
        XCTAssertTrue(first === second, "every frame draws the picture, so an unchanged file is not decoded again")
    }

    func testOnlyThePicturesUsedLastAreKept() throws {
        let pictures = Looks.BackgroundPictures(limit: 2)
        let paths = try ["a", "b", "c"].map { name -> String in
            let url = folder.appendingPathComponent("\(name).png")
            try png(CIColor(red: 0, green: 1, blue: 0)).write(to: url)
            return url.path
        }
        let first = try XCTUnwrap(pictures.image(paths[0]))
        let second = try XCTUnwrap(pictures.image(paths[1]))
        XCTAssertTrue(pictures.image(paths[0]) === first)
        _ = try XCTUnwrap(pictures.image(paths[2]))
        XCTAssertTrue(pictures.image(paths[0]) === first, "a picture used lately stays")
        XCTAssertFalse(pictures.image(paths[1]) === second, "the picture used longest ago was dropped and is read again")
    }
}
