import Foundation
import SwiftUI
import os

/// How a burn lane draws the time between two readings. A reading is stored only when the value changes, so `step`
/// (hold the value until the next reading) is the truthful default; `linear` reads smoother.
public enum UsageLineShape: String, CaseIterable, Identifiable, Codable, Sendable {
    case step, linear
    public var id: String { rawValue }
    public var title: String { self == .step ? "Step" : "Linear" }
}

/// A window the account has no limit for (no 5h window): a hatched "No limit" band, or no lane at all.
public enum UsageAbsentWindow: String, CaseIterable, Identifiable, Codable, Sendable {
    case band, hide
    public var id: String { rawValue }
    public var title: String { self == .band ? "Show a band" : "Hide the lane" }
}

/// How fine the series door bins the readings: raw up to 48 h and min-max bins above (`auto`), or a fixed width.
public enum UsageResolution: String, CaseIterable, Identifiable, Codable, Sendable {
    case auto, raw, oneMinute = "1m", fiveMinutes = "5m"
    public var id: String { rawValue }
    public var title: String {
        switch self {
        case .auto: return "Auto"
        case .raw: return "Raw"
        case .oneMinute: return "1 min"
        case .fiveMinutes: return "5 min"
        }
    }

    /// `--step` and `--agg` for a range: raw rows up to 48 h, min-max bins above, so a 5h peak just before a reset
    /// stays visible at 30 days.
    public func door(_ range: UsageRange) -> (step: String, agg: String) {
        switch self {
        case .auto: return range.seconds <= 48 * 3600 ? ("raw", "raw") : ("auto", "minmax")
        case .raw: return ("raw", "raw")
        case .oneMinute: return ("1m", "minmax")
        case .fiveMinutes: return ("5m", "minmax")
        }
    }
}

/// The pivot dimension the Spend tab stacks its bars by.
public enum UsageSpendStack: String, CaseIterable, Identifiable, Codable, Sendable {
    case provider, account, model, project, harness
    public var id: String { rawValue }
    public var title: String { rawValue.prefix(1).uppercased() + rawValue.dropFirst() }
}

/// Every choice the usage views make that a person could want another way (`.claude/rules/opinionated-settings.md`).
/// The defaults are the design's (proposals 1, 4, 5, 8, 10 and 15). A key missing from a saved value reads as its
/// default, so a value saved by an older build loads, and a key added later needs no migration.
public struct UsageSettings: Codable, Equatable, Sendable {
    public var range: UsageRange = .day
    public var resolution: UsageResolution = .auto
    public var lineShape: UsageLineShape = .step
    public var absentWindow: UsageAbsentWindow = .band
    /// A faint band for each window period and a drop at each reset.
    public var resetBands = true
    /// The line takes the severity colour of its reading (ok, warning, critical) instead of the provider's.
    public var severityColour = true
    /// The dashed projection from now to the reset.
    public var projection = true
    /// The shaded cone between the slow and the fast pace (25th to 75th percentile of the active burn).
    public var cone = true
    /// The thin line that lands at exactly 100 % at the reset.
    public var safePace = true
    /// Any of the three forecast overlays is on: each is its own switch, so the chart draws and makes room for the
    /// ones that are on, not only while the projection is.
    public var drawsForecast: Bool { projection || cone || safePace }
    /// A diamond on each spike, sized by the jump.
    public var spikeMarkers = true
    /// A tick for each rate limit, cooldown, poll pause, block and probe.
    public var eventMarkers = true
    /// The poll coverage strip under each account's lanes.
    public var coverageStrip = true
    /// Fable and other scoped windows get lanes of their own.
    public var scopedWindows = false
    /// The Spend tab's stack.
    public var spendStack: UsageSpendStack = .provider
    /// The hub digest draws a small cone beside each account's forecast.
    public var digestCone = true

    public init() {}

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let defaults = UsageSettings()
        func value<V: Decodable>(_ key: CodingKeys, _ fallback: V) -> V {
            // A value an older or newer build wrote in another shape reads as the default, never as an error.
            (try? container.decodeIfPresent(V.self, forKey: key)).flatMap { $0 } ?? fallback
        }
        range = value(.range, defaults.range)
        resolution = value(.resolution, defaults.resolution)
        lineShape = value(.lineShape, defaults.lineShape)
        absentWindow = value(.absentWindow, defaults.absentWindow)
        resetBands = value(.resetBands, defaults.resetBands)
        severityColour = value(.severityColour, defaults.severityColour)
        projection = value(.projection, defaults.projection)
        cone = value(.cone, defaults.cone)
        safePace = value(.safePace, defaults.safePace)
        spikeMarkers = value(.spikeMarkers, defaults.spikeMarkers)
        eventMarkers = value(.eventMarkers, defaults.eventMarkers)
        coverageStrip = value(.coverageStrip, defaults.coverageStrip)
        scopedWindows = value(.scopedWindows, defaults.scopedWindows)
        spendStack = value(.spendStack, defaults.spendStack)
        digestCone = value(.digestCone, defaults.digestCone)
    }

    /// The saved text: JSON with sorted keys.
    public func encoded() -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return (try? encoder.encode(self)).map { String(decoding: $0, as: UTF8.self) } ?? "{}"
    }

    /// Text that is not JSON, or no text, reads as the defaults.
    public static func decoded(_ text: String?) -> UsageSettings {
        guard let text, let data = text.data(using: .utf8) else { return UsageSettings() }
        return (try? JSONDecoder().decode(UsageSettings.self, from: data)) ?? UsageSettings()
    }
}

/// The usage views' settings, shared by the hub's Usage mode and the Usage page of the settings window. Both faces
/// run from one bundle, so they read one defaults domain; a write posts a distributed notification and every other
/// process reloads, as `HubPreferences` does. Saved as one JSON text under `key` (`hub.`, so a hub `--snapshot` run
/// copies it into its scratch settings and `--set hub.usage.settings={"range":"7d"}` sets it there).
@MainActor
public final class UsagePreferences: ObservableObject {
    public static let key = "hub.usage.settings"
    public static let shared = UsagePreferences()

    @Published public var settings: UsageSettings {
        didSet { if oldValue != settings { persist() } }
    }

    public let notificationName: Notification.Name
    private let notificationNamespace: String
    private let defaults: UserDefaults
    private let broadcasts: Bool
    private var observer: NSObjectProtocol?
    private var applyingExternal = false
    private let log: Logger

    /// `broadcasts: false` and `observeExternalChanges: false` keep a scripted run on its scratch settings from
    /// telling the live hub and the settings window about values that are not theirs.
    public init(
        defaults: UserDefaults = .standard,
        notificationNamespace: String = Bundle.main.bundleIdentifier ?? "dev.genesis.native",
        broadcasts: Bool = true, observeExternalChanges: Bool = true
    ) {
        self.defaults = defaults
        self.broadcasts = broadcasts
        self.notificationNamespace = notificationNamespace
        notificationName = Notification.Name("\(notificationNamespace).usage.preferencesChanged")
        log = Logger(subsystem: notificationNamespace, category: "UsagePreferences")
        settings = UsageSettings.decoded(defaults.string(forKey: Self.key))
        if observeExternalChanges {
            observer = DistributedNotificationCenter.default().addObserver(
                forName: notificationName, object: notificationNamespace, queue: .main
            ) { [weak self] _ in
                Task { @MainActor in self?.reloadFromDefaults() }
            }
        }
    }

    deinit {
        if let observer { DistributedNotificationCenter.default().removeObserver(observer) }
    }

    public func reloadFromDefaults() {
        defaults.synchronize()
        let stored = UsageSettings.decoded(defaults.string(forKey: Self.key))
        guard stored != settings else { return }
        applyingExternal = true
        settings = stored
        applyingExternal = false
    }

    /// A binding to one setting, for a toggle or a picker.
    public func binding<V>(_ path: WritableKeyPath<UsageSettings, V>) -> Binding<V> {
        Binding(get: { self.settings[keyPath: path] }, set: { self.settings[keyPath: path] = $0 })
    }

    private func persist() {
        guard !applyingExternal else { return }
        defaults.set(settings.encoded(), forKey: Self.key)
        guard broadcasts else { return }
        if !defaults.synchronize() { log.warning("Could not flush the usage preferences") }
        DistributedNotificationCenter.default().postNotificationName(
            notificationName, object: notificationNamespace, userInfo: nil, deliverImmediately: true)
    }
}
