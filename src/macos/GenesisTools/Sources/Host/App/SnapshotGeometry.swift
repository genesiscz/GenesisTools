import AppKit
import ImageIO
import MachO

/// The capture geometry beside every `--snapshot` PNG: `<shot>.geometry.json` holds the window size in points, the
/// image's scale, the window's backing scale, and which build drew it. `tools control compare-screenshot` and
/// `tools control report` read it and refuse a pair drawn at different point sizes, the trap of 2026-10-11 (hub befores
/// at 2056 x 1290 pt, afters at 1440 x 900 pt, some 1x and some 2x, so every after looked zoomed in).
///
/// Shape (version 1): `{version, face, window: {width, height}, scale, backingScale, image: {width, height},
/// build: {binary, executable, commit, dirty, commitSource}, capturedAt}`. `build.binary` is the executable's Mach-O
/// UUID (a new link has a new one). `build.commit` comes from the install manifest when this process runs the installed
/// app, else it is null (`commitSource: "unknown"`) because a `.build` binary does not know its checkout.
package enum SnapshotGeometry {
    /// `shot.png` -> `shot.geometry.json`.
    package static func sidecarPath(for png: String) -> String {
        let base = (png as NSString).pathExtension.lowercased() == "png" ? (png as NSString).deletingPathExtension : png
        return base + ".geometry.json"
    }

    /// Writes the sidecar for the PNG at `png`. `points` is the size the image shows in points (the content view for
    /// a `cacheDisplay` capture); without it the image's pixels divided by `backingScale` stand in.
    package static func write(png: String, face: String, backingScale: CGFloat, points: CGSize? = nil) {
        let started = Date()
        guard let pixels = pixelSize(of: png) else {
            FileHandle.standardError.write(Data("snapshot geometry: cannot read \(png)\n".utf8))
            return
        }

        let scale = backingScale > 0 ? backingScale : 1
        let shown = points ?? CGSize(width: pixels.width / scale, height: pixels.height / scale)
        let imageScale = shown.width > 0 ? (pixels.width / shown.width * 1000).rounded() / 1000 : scale
        let build = buildFacts()
        let record: [String: Any] = [
            "version": 1,
            "face": face,
            "window": ["width": Double(shown.width.rounded()), "height": Double(shown.height.rounded())],
            "scale": Double(imageScale),
            "backingScale": Double(scale),
            "image": ["width": Int(pixels.width), "height": Int(pixels.height)],
            "build": build,
            "capturedAt": ISO8601DateFormatter().string(from: Date()),
        ]
        let path = sidecarPath(for: png)
        do {
            let data = try JSONSerialization.data(withJSONObject: record, options: [.prettyPrinted, .sortedKeys])
            try data.write(to: URL(fileURLWithPath: path))
            let ms = Int(Date().timeIntervalSince(started) * 1000)
            FileHandle.standardError.write(Data(
                "snapshot geometry: \(Int(shown.width))x\(Int(shown.height)) pt @\(imageScale)x in \(ms) ms -> \(path)\n".utf8))
        } catch {
            FileHandle.standardError.write(Data("snapshot geometry: \(error.localizedDescription)\n".utf8))
        }
    }

    private static func pixelSize(of png: String) -> CGSize? {
        guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: png) as CFURL, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int,
              let height = properties[kCGImagePropertyPixelHeight] as? Int
        else { return nil }
        return CGSize(width: width, height: height)
    }

    private static func buildFacts() -> [String: Any] {
        let executable = Bundle.main.executablePath ?? CommandLine.arguments.first ?? ""
        var facts: [String: Any] = ["binary": binaryUUID() ?? NSNull(), "executable": executable]
        let installed = (NSHomeDirectory() as NSString).appendingPathComponent("Applications/GenesisTools.app/")
        let manifest = URL(fileURLWithPath: genesisHome()).appendingPathComponent(".genesis-tools/app/manifest.json")
        if executable.hasPrefix(installed),
           let data = try? Data(contentsOf: manifest),
           let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let commit = object["sourceCommit"] as? String {
            facts["commit"] = commit
            facts["dirty"] = object["sourceDirty"] as? Bool ?? false
            facts["commitSource"] = "manifest"
        } else {
            facts["commit"] = NSNull()
            facts["commitSource"] = "unknown"
        }
        return facts
    }

    /// The main executable's LC_UUID: one value per link, so two shots from the same build share it.
    private static func binaryUUID() -> String? {
        guard let header = _dyld_get_image_header(0) else { return nil }
        var cursor = UnsafeRawPointer(header).advanced(by: MemoryLayout<mach_header_64>.size)
        for _ in 0..<header.pointee.ncmds {
            let command = cursor.assumingMemoryBound(to: load_command.self).pointee
            if command.cmd == UInt32(LC_UUID) {
                let uuid = cursor.assumingMemoryBound(to: uuid_command.self).pointee.uuid
                return UUID(uuid: uuid).uuidString
            }
            cursor = cursor.advanced(by: Int(command.cmdsize))
        }
        return nil
    }
}
