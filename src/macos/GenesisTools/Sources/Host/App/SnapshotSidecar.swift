import Foundation

/// A JSON file beside a `--snapshot` PNG (`shot.png` -> `shot.<suffix>.json`): the geometry and the view tree.
enum SnapshotSidecar {
    static func path(for png: String, suffix: String) -> String {
        let base = (png as NSString).pathExtension.lowercased() == "png" ? (png as NSString).deletingPathExtension : png
        return base + ".\(suffix).json"
    }

    /// Writes `record` beside `png` and prints one stderr line: `<label>: <summary> in <ms> ms -> <path>`, or the error.
    static func write(_ record: [String: Any], png: String, suffix: String, options: JSONSerialization.WritingOptions,
                      label: String, summary: String, started: Date) {
        let file = path(for: png, suffix: suffix)
        do {
            let data = try JSONSerialization.data(withJSONObject: record, options: options)
            try data.write(to: URL(fileURLWithPath: file))
            let ms = Int(Date().timeIntervalSince(started) * 1000)
            FileHandle.standardError.write(Data("\(label): \(summary) in \(ms) ms -> \(file)\n".utf8))
        } catch {
            FileHandle.standardError.write(Data("\(label): \(error.localizedDescription)\n".utf8))
        }
    }
}
