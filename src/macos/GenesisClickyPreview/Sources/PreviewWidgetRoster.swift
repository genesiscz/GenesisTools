import Foundation
import GenesisKit

/// The Widgets settings pages in the preview, without the widget face or the real `tools`: a stand-in `tools` script
/// answers `hub widget snapshot --json` with a saved snapshot (`--widget-snapshot <file.json>`) or a made-up roster
/// (`--sessions <n>`: one selected lead with n - 1 agents under it, so its group opens, as the real selected one does).
@MainActor
enum PreviewWidgetRoster {
    static func model(arguments args: [String], defaults: UserDefaults, appearance: NativeSettingsAppearance) -> WidgetModel? {
        let snapshot: URL
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("clicky-preview-widget-\(UUID().uuidString)")
        do {
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            if let path = value(after: "--widget-snapshot", in: args) {
                snapshot = URL(fileURLWithPath: path)
            } else if let count = value(after: "--sessions", in: args).flatMap(Int.init), count > 0 {
                snapshot = root.appendingPathComponent("snapshot.json")
                try roster(sessions: count).write(to: snapshot, atomically: true, encoding: .utf8)
            } else {
                return nil
            }
            let tools = root.appendingPathComponent("tools")
            let script = "#!/bin/sh\nfor a in \"$@\"; do if [ \"$a\" = snapshot ]; then cat '\(snapshot.path)'; exit 0; fi; done\nexit 0\n"
            try script.write(to: tools, atomically: true, encoding: .utf8)
            try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: tools.path)
        } catch {
            fputs("Preview widget roster failed: \(error)\n", stderr)
            return nil
        }
        return WidgetModel(binaryPath: root.appendingPathComponent("tools").path, stateRoot: root.path,
                           defaults: defaults, appearance: appearance)
    }

    /// A snapshot with `sessions` rows: a selected lead and `sessions - 1` agents under it.
    static func roster(sessions: Int) -> String {
        let now = Date().timeIntervalSince1970 * 1000
        let lead = "local:claude:preview-lead:"
        var rows: [String] = []
        for index in 0..<sessions {
            let isLead = index == 0
            let key = isLead ? lead : "local:claude:preview-lead:agent-\(index)"
            let extra = isLead
                ? #""role":"lead""#
                : #""role":"background","agentId":"agent-\#(index)","parentKey":"\#(lead)","agentStatus":"finished""#
            rows.append(
                #"{"key":"\#(key)","target":{"hostId":"local","provider":"claude","sessionId":"preview-\#(index)","#
                    + #""sourceHome":"","cwd":"/tmp/fixture/project"},"title":"Preview agent \#(index)","#
                    + #""project":"project","activityAt":\#(now - Double(index) * 60_000),"status":"recent","#
                    + #""pinned":false,"visible":true,"hiddenByFilter":false,"model":"opus","toolCalls":\#(index % 40),\#(extra)}"#)
        }
        return #"{"version":1,"state":{"version":1,"revision":0,"selectedKey":"\#(lead)","preferences":{"excludedKeys":[],"#
            + #""projects":[],"sessions":[],"showChanges":true,"placement":"both","side":"right","quietSeconds":15,"#
            + #""voiceProvider":"fixture","voiceLanguage":"en"},"assets":{},"drafts":{},"outgoing":[]},"#
            + #""sessions":[\#(rows.joined(separator: ","))],"cards":[],"manifests":{},"errors":[]}"#
    }

    private static func value(after flag: String, in args: [String]) -> String? {
        guard let index = args.firstIndex(of: flag), args.indices.contains(index + 1) else { return nil }
        return args[index + 1]
    }
}
