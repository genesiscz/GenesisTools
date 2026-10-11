import CryptoKit
import Foundation

/// A picture embedded in a page as `data:image/…;base64,…`, written once to a private temporary file, so it takes
/// the same path as every other picture (`MediaThumbnailCache`, Copy, Open in Preview).
public enum MediaDataURL {
    /// The MIME types a host lets through, by the file extension they get (`"image/png": "png"`).
    public static let imageTypes: [String: String] = [
        "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/gif": "gif", "image/webp": "webp",
        "image/avif": "avif", "image/svg+xml": "svg",
    ]

    public static let maxBytes = 64 << 20

    /// The bytes and the file extension of a base64 `data:` image of an allowed type; nil for anything else (another
    /// type, no base64, too large, not decodable).
    public static func decode(_ url: String, allowed: [String: String] = imageTypes, maxBytes: Int = maxBytes)
        -> (data: Data, ext: String)?
    {
        guard url.count < maxBytes / 3 * 4 + 512, url.lowercased().hasPrefix("data:"),
              let comma = url.firstIndex(of: ",") else { return nil }
        let header = url[url.index(url.startIndex, offsetBy: 5)..<comma].lowercased()
        let parts = header.split(separator: ";").map { $0.trimmingCharacters(in: .whitespaces) }
        guard let mime = parts.first, let ext = allowed[mime], parts.dropFirst().contains("base64") else { return nil }
        let payload = String(url[url.index(after: comma)...]).filter { !$0.isWhitespace }
        guard let data = Data(base64Encoded: payload), !data.isEmpty, data.count <= maxBytes else { return nil }
        return (data, ext)
    }

    /// The temporary file for this picture: named by a hash of its bytes, so the same picture is written once and
    /// reused, readable by this user only. Nil when the URL is refused or the file cannot be written.
    public static func materialize(_ url: String, allowed: [String: String] = imageTypes, maxBytes: Int = maxBytes,
                                   folder: URL = defaultFolder) -> URL?
    {
        guard let (data, ext) = decode(url, allowed: allowed, maxBytes: maxBytes) else { return nil }
        let name = SHA256.hash(data: data).prefix(16).map { String(format: "%02x", $0) }.joined()
        let file = folder.appendingPathComponent("\(name).\(ext)")
        let manager = FileManager.default
        if let size = (try? manager.attributesOfItem(atPath: file.path))?[.size] as? NSNumber, size.intValue == data.count {
            return file
        }
        do {
            try manager.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            try data.write(to: file, options: .atomic)
            try manager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
            return file
        } catch {
            GenesisKit.log("media data url could not be written to \(file.path): \(error)")
            return nil
        }
    }

    public static var defaultFolder: URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("genesiskit-embedded-images", isDirectory: true)
    }
}
