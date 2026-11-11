import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
import XCTest
@testable import GenesisToolsRecorder

/// The intro card's logo picker offers only the picture types the edit accepts (the extension list the TypeScript
/// applyCard checks, kept in __fixtures__/logo-picture-types.json) and the export can draw, and it refuses a file
/// CoreImage cannot decode before it sends the op.
@MainActor
final class RecorderHuntLogoPictureTypesTests: XCTestCase {
    private func fixture() throws -> [String: Any] {
        let data = try Data(contentsOf: SharedEditorFixture.url("logo-picture-types.json"))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func offered(_ fileExtension: String) -> Bool {
        guard let type = UTType(filenameExtension: fileExtension) else { return false }
        return CardsSection.logoTypes.contains { type.conforms(to: $0) }
    }

    func testThePickerOffersOnlyExtensionsTheEditAccepts() throws {
        let accepted = Set(try XCTUnwrap(fixture()["extensions"] as? [String]))
        let pickable = Set(CardsSection.logoTypes.flatMap { $0.tags[.filenameExtension] ?? [] })
        XCTAssertEqual(pickable.subtracting(accepted), [], "the picker offers files the edit refuses")
        XCTAssertEqual(accepted.subtracting(pickable), [], "the edit accepts files the picker never offers")
        for fileExtension in ["tif", "bmp", "heif", "png", "jpg"] {
            XCTAssertTrue(offered(fileExtension), "the picker offers .\(fileExtension)")
        }
    }

    func testThePickerDoesNotOfferPicturesTheEditRefuses() throws {
        let refused = try XCTUnwrap(fixture()["refused"] as? [String])
        for fileExtension in refused {
            XCTAssertFalse(offered(fileExtension), "the picker does not offer .\(fileExtension)")
        }
    }

    func testALogoThatDoesNotDecodeIsRefusedBeforeTheOp() throws {
        let folder = FileManager.default.temporaryDirectory
            .appendingPathComponent("recorder-hunt-logo-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }

        let fake = folder.appendingPathComponent("logo.png")
        try Data("not a picture".utf8).write(to: fake)
        XCTAssertEqual(CardsSection.logoRefusal(fake), "logo.png is not a picture this Mac can read.")

        let tif = folder.appendingPathComponent("logo.tif")
        let context = try XCTUnwrap(CGContext(
            data: nil, width: 4, height: 4, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ))
        context.setFillColor(CGColor(red: 1, green: 0, blue: 0, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: 4, height: 4))
        let image = try XCTUnwrap(context.makeImage())
        let destination = try XCTUnwrap(CGImageDestinationCreateWithURL(tif as CFURL, UTType.tiff.identifier as CFString, 1, nil))
        CGImageDestinationAddImage(destination, image, nil)
        XCTAssertTrue(CGImageDestinationFinalize(destination))
        XCTAssertNil(CardsSection.logoRefusal(tif), "a TIFF logo decodes")
    }
}
