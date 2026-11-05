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

    static func == (a: DisplayPlan, b: DisplayPlan) -> Bool {
        a.policy == b.policy && a.windowSec == b.windowSec && a.ranges == b.ranges
            && a.displays.map(\.id) == b.displays.map(\.id) && a.displays.map(\.name) == b.displays.map(\.name)
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
        if let manifest = try? Data(contentsOf: folder.appendingPathComponent("recording.json")),
           let root = try? JSONSerialization.jsonObject(with: manifest) as? [String: Any],
           let list = root["displays"] as? [[String: Any]] {
            displays = list.compactMap { entry in
                guard let id = (entry["id"] as? NSNumber)?.intValue else { return nil }
                return (id, entry["name"] as? String ?? "Display \(id)")
            }
        }
        for id in file.ranges.map(\.displayId) where !displays.contains(where: { $0.id == id }) {
            displays.append((id, "Display \(id)"))
        }
        return DisplayPlan(policy: file.policy, windowSec: file.windowSec, ranges: file.ranges, displays: displays)
    }

    /// The `tools` arguments that show `displayId` from `fromUs` to `toUs` and keep the rest of the plan: the CLI's own
    /// command (`--keep-plan --switch`), so the window, an agent and a script make the same movie.
    static func switchArguments(folder: URL, fromUs: Int64, toUs: Int64, displayId: Int) -> [String] {
        let seconds = { (us: Int64) in String(format: "%.3f", Double(us) / 1_000_000) }
        return ["recorder", "proxy", folder.path, "--keep-plan", "--switch", "\(seconds(fromUs))-\(seconds(toUs))=\(displayId)"]
    }
}
