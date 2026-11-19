import Foundation

/// Which display a frames recording's proxy movie shows when (proxy.json, written by `tools recorder proxy`, src/recorder
/// /lib/proxy.ts), with the names the recording gave its displays (recording.json `displays`). The proxy's movie time
/// is the recording's time, so the ranges are SOURCE microseconds of the edit.
struct DisplayPlan: Equatable {
    struct Range: Codable, Equatable {
        var fromUs: Int64
        var toUs: Int64
        var displayId: Int
    }

    var policy: String
    var windowSec: Double
    var ranges: [Range]
    /// Every display the recording has, in its order, with its name.
    var displays: [(id: Int, name: String)]
    /// Each display's first frame (source microseconds), from recording.json's frames; empty when it lists none (a
    /// meeting), and then every display counts as having frames from the start.
    var firstFrameUs: [Int: Int64] = [:]

    static func == (a: DisplayPlan, b: DisplayPlan) -> Bool {
        a.policy == b.policy && a.windowSec == b.windowSec && a.ranges == b.ranges && a.firstFrameUs == b.firstFrameUs
            && a.displays.map(\.id) == b.displays.map(\.id) && a.displays.map(\.name) == b.displays.map(\.name)
    }

    /// The displays the editor draws as rows, in the recording's order: each one with frames (a display recording.json
    /// names but never captured has nothing to show), and each one the plan shows.
    var rows: [(id: Int, name: String)] {
        displays.filter { display in
            firstFrameUs.isEmpty || firstFrameUs[display.id] != nil || ranges.contains { $0.displayId == display.id }
        }
    }

    /// The source times where the movie changes from one display to another.
    var switches: [Int64] {
        zip(ranges, ranges.dropFirst()).compactMap { left, right in left.displayId == right.displayId ? nil : right.fromUs }
    }

    /// The range that shows at `sourceUs` (the last one past the end).
    func rangeIndex(atSource sourceUs: Int64) -> Int? {
        guard !ranges.isEmpty else { return nil }
        return ranges.firstIndex { sourceUs < $0.toUs } ?? ranges.count - 1
    }

    /// Whether `displayId` has a picture somewhere in `fromUs..<toUs` (its first frame is before the end).
    func hasFrames(_ displayId: Int, before toUs: Int64) -> Bool {
        firstFrameUs.isEmpty || (firstFrameUs[displayId].map { $0 < toUs } ?? false)
    }

    func name(of id: Int) -> String {
        displays.first { $0.id == id }?.name ?? "Display \(id)"
    }

    /// The plan of the proxy movie `video`; nil for any other movie or a proxy without a plan.
    static func read(video: String) -> DisplayPlan? {
        let movie = URL(fileURLWithPath: video)
        guard movie.lastPathComponent == "proxy.mp4" else { return nil }
        let folder = movie.deletingLastPathComponent()
        struct File: Decodable {
            var policy: String
            var windowSec: Double
            var ranges: [Range]
        }
        guard let data = try? Data(contentsOf: folder.appendingPathComponent("proxy.json")),
              let file = try? JSONDecoder().decode(File.self, from: data) else { return nil }
        var displays: [(id: Int, name: String)] = []
        var firstFrameUs: [Int: Int64] = [:]
        if let manifest = try? Data(contentsOf: folder.appendingPathComponent("recording.json")),
           let root = try? JSONSerialization.jsonObject(with: manifest) as? [String: Any] {
            displays = (root["displays"] as? [[String: Any]] ?? []).compactMap { entry in
                guard let id = (entry["id"] as? NSNumber)?.intValue else { return nil }
                return (id, entry["name"] as? String ?? "Display \(id)")
            }
            for frame in root["frames"] as? [[String: Any]] ?? [] {
                guard let id = (frame["displayId"] as? NSNumber)?.intValue, let ms = (frame["atMs"] as? NSNumber)?.doubleValue else { continue }
                firstFrameUs[id] = min(firstFrameUs[id] ?? .max, Int64((ms * 1000).rounded()))
            }
        }
        for id in file.ranges.map(\.displayId) + firstFrameUs.keys.sorted() where !displays.contains(where: { $0.id == id }) {
            displays.append((id, "Display \(id)"))
        }
        return DisplayPlan(policy: file.policy, windowSec: file.windowSec, ranges: file.ranges, displays: displays,
                           firstFrameUs: firstFrameUs)
    }

    /// The `tools recorder apply` arguments of display ops (switchDisplay, hideDisplay, moveDisplaySwitch), the CLI twin of
    /// the REPL's methods of the same names: the window's fallback when the recorder service does not offer them.
    static func applyArguments(folder: URL, op: [String: Any]) -> [String] {
        let data = (try? JSONSerialization.data(withJSONObject: op, options: [.sortedKeys])) ?? Data("{}".utf8)
        return ["recorder", "apply", folder.path, String(decoding: data, as: UTF8.self)]
    }

    /// The `tools` arguments that show `displayId` from `fromUs` to `toUs` and keep the rest of the plan: the CLI's own
    /// command (`--keep-plan --switch`), so the window, an agent and a script make the same movie.
    static func switchArguments(folder: URL, fromUs: Int64, toUs: Int64, displayId: Int) -> [String] {
        let seconds = { (us: Int64) in String(format: "%.3f", Double(us) / 1_000_000) }
        return ["recorder", "proxy", folder.path, "--keep-plan", "--switch", "\(seconds(fromUs))-\(seconds(toUs))=\(displayId)"]
    }
}
