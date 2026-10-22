// cloudctl: iCloud Drive upload state and eviction for `tools du evict`.
//
//   cloudctl status < paths   one JSON object per path: ubiquitous, uploaded, uploading,
//                             uploadError, downloading (current | downloaded | notDownloaded)
//   cloudctl evict  < paths   evicts each path, but only after it re-reads the state
//                             itself and finds it uploaded, not uploading, without an
//                             upload error, and the local copy current
//
// Paths come on stdin, NUL-separated. Reading these resource values never reads
// file contents, so it cannot download anything. Eviction removes the LOCAL copy
// only (FileManager.evictUbiquitousItem); the file stays in iCloud.
//
// Built on demand by src/du/lib/evict.ts: swiftc -O -o cloudctl cloudctl.swift

import Foundation

let keys: Set<URLResourceKey> = [
    .isUbiquitousItemKey,
    .ubiquitousItemIsUploadedKey,
    .ubiquitousItemIsUploadingKey,
    .ubiquitousItemUploadingErrorKey,
    .ubiquitousItemDownloadingStatusKey,
]

func downloadingName(_ s: URLUbiquitousItemDownloadingStatus?) -> String? {
    guard let s else { return nil }
    switch s {
    case .current: return "current"
    case .downloaded: return "downloaded"
    case .notDownloaded: return "notDownloaded"
    default: return s.rawValue
    }
}

func status(_ path: String) -> [String: Any] {
    var o: [String: Any] = ["path": path]
    // A fresh URL each time: URL caches resource values per instance.
    let url = URL(fileURLWithPath: path)
    do {
        let v = try url.resourceValues(forKeys: keys)
        o["ubiquitous"] = v.isUbiquitousItem ?? false
        o["uploaded"] = v.ubiquitousItemIsUploaded ?? false
        o["uploading"] = v.ubiquitousItemIsUploading ?? false
        if let e = v.ubiquitousItemUploadingError {
            o["uploadError"] = e.localizedDescription
        }
        if let d = downloadingName(v.ubiquitousItemDownloadingStatus) {
            o["downloading"] = d
        }
    } catch {
        o["error"] = error.localizedDescription
    }
    return o
}

/** The same rule as judgeEviction in evict.ts, checked again right before the evict call. */
func refusal(_ s: [String: Any]) -> String? {
    if let e = s["error"] as? String { return "status unknown: \(e)" }
    if s["ubiquitous"] as? Bool != true { return "not an iCloud item" }
    if s["uploading"] as? Bool == true { return "upload in progress" }
    if let e = s["uploadError"] as? String { return "upload error: \(e)" }
    if s["uploaded"] as? Bool != true { return "not uploaded yet" }
    if s["downloading"] as? String != "current" { return "local copy is not the current version" }
    return nil
}

func emit(_ o: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: o, options: [.sortedKeys]) else { return }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0A]))
}

let args = CommandLine.arguments
guard args.count == 2, args[1] == "status" || args[1] == "evict" else {
    FileHandle.standardError.write(Data("usage: cloudctl status|evict < NUL-separated paths\n".utf8))
    exit(2)
}

let input = FileHandle.standardInput.readDataToEndOfFile()
let paths = input.split(separator: 0).compactMap { String(data: Data($0), encoding: .utf8) }.filter { !$0.isEmpty }

for path in paths {
    let s = status(path)
    if args[1] == "status" {
        emit(s)
        continue
    }

    if let why = refusal(s) {
        emit(["path": path, "evicted": false, "reason": why])
        continue
    }

    do {
        try FileManager.default.evictUbiquitousItem(at: URL(fileURLWithPath: path))
        emit(["path": path, "evicted": true])
    } catch {
        emit(["path": path, "evicted": false, "reason": error.localizedDescription])
    }
}
