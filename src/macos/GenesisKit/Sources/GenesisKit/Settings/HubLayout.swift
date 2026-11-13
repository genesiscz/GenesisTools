import Foundation
import Observation
import SwiftUI

/// Live layout choices shared by Settings and the Hub. Snapshot overrides never write defaults.
public enum HubLayout {
    public enum Area: String, CaseIterable, Identifiable, Sendable {
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

    public enum Choice: String, CaseIterable, Sendable {
        case focused = "a", compact = "b", classic
    }

    private static let options = parse(ProcessInfo.processInfo.arguments)
    @MainActor private static var scriptedDefaults: UserDefaults?
    @MainActor static let state = HubLayoutState(
        defaults: scriptedDefaults ?? .standard, broadcasts: !isScripted, observeChanges: !isScripted)

    /// The host supplies its existing scratch store before resolving any layouts. Live faces keep the standard domain.
    public static func useScriptedDefaults(_ defaults: UserDefaults) {
        guard isScripted else { return }
        // App entry points configure the scratch domain on the main thread before starting AppKit.
        MainActor.assumeIsolated { scriptedDefaults = defaults }
    }
    private static let isScripted = ProcessInfo.processInfo.arguments.contains("--snapshot")
        || ProcessInfo.processInfo.arguments.contains("--bench")

    @MainActor public static func option(_ area: String) -> String? {
        guard let area = Area(rawValue: area) else { return nil }
        let picked = options[area.rawValue].flatMap(Choice.init(rawValue:)) ?? state.choice(area)
        return picked == .classic ? nil : picked.rawValue
    }

    /// Unknown stored values fall back without overwriting the user's data.
    public static func choice(_ area: Area, defaults: UserDefaults) -> Choice {
        defaults.string(forKey: area.key).flatMap(Choice.init(rawValue:)) ?? .classic
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

/// The observable read happens inside a View body, including pages whose factory is cached by Settings.
public struct HubLayoutView<Focused: View, Compact: View, Classic: View>: View {
    private let area: HubLayout.Area
    private let focused: () -> Focused
    private let compact: () -> Compact
    private let classic: () -> Classic

    public init(_ area: HubLayout.Area, @ViewBuilder focused: @escaping () -> Focused,
                @ViewBuilder compact: @escaping () -> Compact, @ViewBuilder classic: @escaping () -> Classic) {
        self.area = area
        self.focused = focused
        self.compact = compact
        self.classic = classic
    }

    public var body: some View {
        switch HubLayout.option(area.rawValue) {
        case "a": focused()
        case "b": compact()
        default: classic()
        }
    }
}

@MainActor @Observable
final class HubLayoutState {
    private var choices: [HubLayout.Area: HubLayout.Choice]
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let namespace: String
    @ObservationIgnored private let broadcasts: Bool
    @ObservationIgnored private var observer: NSObjectProtocol?

    init(defaults: UserDefaults = .standard,
         namespace: String = Bundle.main.bundleIdentifier ?? "dev.genesis.native",
         broadcasts: Bool = true, observeChanges: Bool = true) {
        self.defaults = defaults
        self.namespace = namespace
        self.broadcasts = broadcasts
        choices = Dictionary(uniqueKeysWithValues: HubLayout.Area.allCases.map { ($0, HubLayout.choice($0, defaults: defaults)) })
        if observeChanges {
            observer = DistributedNotificationCenter.default().addObserver(
                forName: Notification.Name("\(namespace).hub.layoutsChanged"), object: namespace, queue: .main
            ) { [weak self] _ in
                Task { @MainActor in self?.reload() }
            }
        }
    }

    deinit {
        if let observer { DistributedNotificationCenter.default().removeObserver(observer) }
    }

    func choice(_ area: HubLayout.Area) -> HubLayout.Choice { choices[area] ?? .classic }

    func set(_ choice: HubLayout.Choice, for area: HubLayout.Area) {
        guard choices[area] != choice else { return }
        choices[area] = choice
        defaults.set(choice.rawValue, forKey: area.key)
        guard broadcasts else { return }
        defaults.synchronize()
        DistributedNotificationCenter.default().postNotificationName(
            Notification.Name("\(namespace).hub.layoutsChanged"), object: namespace,
            userInfo: nil, deliverImmediately: true)
    }

    func reload() {
        defaults.synchronize()
        let next = Dictionary(uniqueKeysWithValues: HubLayout.Area.allCases.map { ($0, HubLayout.choice($0, defaults: defaults)) })
        if choices != next { choices = next }
    }
}

/// Layout changes apply immediately, without replacing the Hub's model or active session.
struct HubLayoutSettings: View {
    var body: some View {
        NativeSettingsCard("Layouts", subtitle: "Choose each area's layout. Changes apply immediately to open windows.") {
            ForEach(HubLayout.Area.allCases) { area in
                HubLayoutSetting(area: area)
                if area != HubLayout.Area.allCases.last { Divider() }
            }
        }
    }
}

private struct HubLayoutSetting: View {
    let area: HubLayout.Area

    var body: some View {
        NativeSettingsSegmented(
            area.title, identifier: area.key,
            options: [
                NativeSettingsOption(HubLayout.Choice.focused, area.focusedTitle),
                NativeSettingsOption(HubLayout.Choice.compact, area.compactTitle),
                NativeSettingsOption(HubLayout.Choice.classic, "Classic"),
            ],
            selection: Binding(get: { HubLayout.state.choice(area) }, set: { HubLayout.state.set($0, for: area) }),
            minSegmentWidth: 80)
    }
}
