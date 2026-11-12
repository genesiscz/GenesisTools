import Foundation
import SwiftUI

/// Saved layout choices are sampled when a face opens. Snapshot overrides stay in memory and never write defaults.
public enum HubLayout {
    public enum Area: String, CaseIterable, Identifiable {
        case prDetail, transcript, lists, usageSettings
        public var id: String { rawValue }
        public var key: String { "hub.layout." + rawValue }
        public var title: String {
            switch self {
            case .prDetail: return "PR detail"
            case .transcript: return "Navigation and transcript"
            case .lists: return "Worktrees, Inbox and Activity"
            case .usageSettings: return "Usage and Settings"
            }
        }
        public var focusedTitle: String {
            switch self {
            case .prDetail: return "Diff and inspector"
            case .transcript: return "Named navigation"
            case .lists: return "Focused lists"
            case .usageSettings: return "Comparison table"
            }
        }
        public var compactTitle: String {
            switch self {
            case .prDetail: return "Document tabs"
            case .transcript: return "Compact toolbar"
            case .lists: return "Grouped tables"
            case .usageSettings: return "Account pages"
            }
        }
    }

    public enum Choice: String, CaseIterable {
        case focused = "a", compact = "b", classic
    }

    private static let options = parse(ProcessInfo.processInfo.arguments)
    private static let saved = Dictionary(uniqueKeysWithValues: Area.allCases.map { ($0.rawValue, choice($0, defaults: .standard)) })

    public static func option(_ area: String) -> String? {
        let picked = options[area].flatMap(Choice.init(rawValue:)) ?? saved[area]
        return picked == .classic ? nil : picked?.rawValue
    }

    /// Unknown stored values fall back without overwriting the user's data.
    public static func choice(_ area: Area, defaults: UserDefaults) -> Choice {
        defaults.string(forKey: area.key).flatMap(Choice.init(rawValue:)) ?? .focused
    }

    /// Retain the existing capture flag as a per-process override, including `classic` for baseline comparisons.
    static func parse(_ arguments: [String]) -> [String: String] {
        var picked: [String: String] = [:]
        for (index, argument) in arguments.enumerated() where argument == "--sketch" && arguments.indices.contains(index + 1) {
            let pair = arguments[index + 1].split(separator: "=", maxSplits: 1).map(String.init)
            if pair.count == 2, Area(rawValue: pair[0]) != nil, Choice(rawValue: pair[1]) != nil {
                picked[pair[0]] = pair[1]
            }
        }
        return picked
    }
}

/// Layout changes take effect on the next opening so a preference never tears down an active review or transcript.
struct HubLayoutSettings: View {
    var body: some View {
        NativeSettingsCard("Layouts", subtitle: "Choose each area's layout. Close and reopen the Hub and Settings windows to apply changes.") {
            ForEach(HubLayout.Area.allCases) { area in
                HubLayoutSetting(area: area)
                if area != HubLayout.Area.allCases.last { Divider() }
            }
        }
    }
}

private struct HubLayoutSetting: View {
    let area: HubLayout.Area
    @AppStorage private var stored: String

    init(area: HubLayout.Area) {
        self.area = area
        _stored = AppStorage(wrappedValue: HubLayout.Choice.focused.rawValue, area.key)
    }

    var body: some View {
        NativeSettingsSegmented(
            area.title, identifier: area.key,
            options: [
                NativeSettingsOption(HubLayout.Choice.focused, area.focusedTitle),
                NativeSettingsOption(HubLayout.Choice.compact, area.compactTitle),
                NativeSettingsOption(HubLayout.Choice.classic, "Classic"),
            ],
            selection: Binding(get: { HubLayout.Choice(rawValue: stored) ?? .focused }, set: { stored = $0.rawValue }),
            minSegmentWidth: 80)
    }
}
