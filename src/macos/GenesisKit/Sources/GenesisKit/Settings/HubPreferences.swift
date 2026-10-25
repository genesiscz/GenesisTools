import Foundation
import SwiftUI
import os

/// How the hub window looks: the hub's own dark look, or the native look of the settings window, which follows
/// General → Theme (glass, solid or gradient).
public enum HubWindowStyle: String, CaseIterable, Identifiable, Sendable {
    case hub, native
    public var id: String { rawValue }
    public var title: String {
        switch self {
        case .hub: return "Hub"
        case .native: return "Native"
        }
    }
}

/// What an agent's (or a link's) request to show a place does to the hub: it navigates there, as a click would,
/// or it only adds the place to the history list and leaves the view alone. Either way Back returns.
public enum HubAgentNavigation: String, CaseIterable, Identifiable, Sendable {
    case navigate, listOnly
    public var id: String { rawValue }
    public var title: String {
        switch self {
        case .navigate: return "Show it"
        case .listOnly: return "Only add it to History"
        }
    }

    public var detail: String {
        switch self {
        case .navigate: return "The hub moves to what the agent opened. Back returns to where you were."
        case .listOnly: return "The view stays. The place waits in History (⌘Y) until you open it."
        }
    }
}

/// The hub's preferences that a person sets, shared by the hub window (`--hub`) and the Hub pages of the settings
/// window (`--features`). Both faces run from one bundle, so they read one defaults domain. A write posts a distributed
/// notification, and every other process reloads, as `NativeSettingsAppearance` does for General.
///
/// Remembered view state (panel widths, folds, filters, sort orders, last selections) is not here: the hub keeps it
/// where it is used.
@MainActor
public final class HubPreferences: ObservableObject {
    public enum Key {
        public static let style = "hub.style"
        public static let glass = "hub.glass"
        public static let processEnergy = "hub.procs.energy"
        public static let cleanupIdleDays = "hub.worktreeCleanup.olderThanDays"
        public static let navigationLimit = "hub.nav.limit"
        public static let agentNavigation = "hub.nav.agentNavigation"
    }

    public static let shared = HubPreferences()
    /// The idle days a worktree needs before cleanup counts it as removable; 0 means any idle time.
    public static let cleanupIdleDaysRange = 0...90
    /// How many places the navigation history keeps (`tools hub nav`); the oldest go first.
    public static let navigationLimitRange = 20...2000
    public static let navigationLimitDefault = 200

    @Published public var style: HubWindowStyle { didSet { if oldValue != style { persist(.style) } } }
    /// The Hub style only: the desktop shows through, blurred. The Native style follows General → Theme instead.
    @Published public var glass: Bool { didSet { if oldValue != glass { persist(.glass) } } }
    /// The Agent processes pane adds macOS energy impact (one `top` sample of about 1 s per refresh).
    @Published public var processEnergy: Bool {
        didSet { if oldValue != processEnergy { persist(.processEnergy) } }
    }
    @Published public var cleanupIdleDays: Int {
        didSet { if oldValue != cleanupIdleDays { persist(.cleanupIdleDays) } }
    }
    /// The places Back, Forward and History keep.
    @Published public var navigationLimit: Int {
        didSet { if oldValue != navigationLimit { persist(.navigationLimit) } }
    }
    /// What an agent's request to show a place does: navigate (the default) or only add it to History.
    @Published public var agentNavigation: HubAgentNavigation {
        didSet { if oldValue != agentNavigation { persist(.agentNavigation) } }
    }

    private enum Field { case style, glass, processEnergy, cleanupIdleDays, navigationLimit, agentNavigation }
    public let notificationNamespace: String
    public let notificationName: Notification.Name
    private let defaults: UserDefaults
    private let broadcasts: Bool
    private var observer: NSObjectProtocol?
    private var applyingExternal = false
    private let log: Logger

    /// `broadcasts: false` and `observeExternalChanges: false` keep a scripted run (a hub snapshot on its scratch
    /// copy of the settings) from telling the live hub and the settings window about values that are not theirs.
    public init(
        defaults: UserDefaults = .standard,
        notificationNamespace: String = Bundle.main.bundleIdentifier ?? "dev.genesis.native",
        broadcasts: Bool = true, observeExternalChanges: Bool = true
    ) {
        self.defaults = defaults
        self.broadcasts = broadcasts
        self.notificationNamespace = notificationNamespace
        notificationName = Notification.Name("\(notificationNamespace).hub.preferencesChanged")
        log = Logger(subsystem: notificationNamespace, category: "HubPreferences")
        style = Self.storedStyle(defaults)
        glass = defaults.bool(forKey: Key.glass)
        processEnergy = defaults.bool(forKey: Key.processEnergy)
        cleanupIdleDays = Self.storedIdleDays(defaults)
        navigationLimit = Self.storedNavigationLimit(defaults)
        agentNavigation = Self.storedAgentNavigation(defaults)
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

    /// Reads every value again, after another process changed one. Unknown or out-of-range values read as the
    /// defaults: the hub style, glass off, no energy column, any idle time.
    public func reloadFromDefaults() {
        defaults.synchronize()
        let storedStyle = Self.storedStyle(defaults)
        let storedGlass = defaults.bool(forKey: Key.glass)
        let storedEnergy = defaults.bool(forKey: Key.processEnergy)
        let storedDays = Self.storedIdleDays(defaults)
        let storedLimit = Self.storedNavigationLimit(defaults)
        let storedAgent = Self.storedAgentNavigation(defaults)
        applyingExternal = true
        if style != storedStyle { style = storedStyle }
        if glass != storedGlass { glass = storedGlass }
        if processEnergy != storedEnergy { processEnergy = storedEnergy }
        if cleanupIdleDays != storedDays { cleanupIdleDays = storedDays }
        if navigationLimit != storedLimit { navigationLimit = storedLimit }
        if agentNavigation != storedAgent { agentNavigation = storedAgent }
        applyingExternal = false
    }

    private static func storedStyle(_ defaults: UserDefaults) -> HubWindowStyle {
        HubWindowStyle(rawValue: defaults.string(forKey: Key.style) ?? "") ?? .hub
    }

    private static func storedIdleDays(_ defaults: UserDefaults) -> Int {
        min(cleanupIdleDaysRange.upperBound, max(cleanupIdleDaysRange.lowerBound, defaults.integer(forKey: Key.cleanupIdleDays)))
    }

    /// Unset reads as the default; a stored value outside the range reads as its nearest limit.
    private static func storedNavigationLimit(_ defaults: UserDefaults) -> Int {
        guard defaults.object(forKey: Key.navigationLimit) != nil else { return navigationLimitDefault }
        return min(navigationLimitRange.upperBound, max(navigationLimitRange.lowerBound, defaults.integer(forKey: Key.navigationLimit)))
    }

    private static func storedAgentNavigation(_ defaults: UserDefaults) -> HubAgentNavigation {
        HubAgentNavigation(rawValue: defaults.string(forKey: Key.agentNavigation) ?? "") ?? .navigate
    }

    private func persist(_ field: Field) {
        guard !applyingExternal else { return }
        switch field {
        case .style: defaults.set(style.rawValue, forKey: Key.style)
        case .glass: defaults.set(glass, forKey: Key.glass)
        case .processEnergy: defaults.set(processEnergy, forKey: Key.processEnergy)
        case .cleanupIdleDays:
            let clamped = min(Self.cleanupIdleDaysRange.upperBound, max(Self.cleanupIdleDaysRange.lowerBound, cleanupIdleDays))
            defaults.set(clamped, forKey: Key.cleanupIdleDays)
        case .navigationLimit:
            let clamped = min(Self.navigationLimitRange.upperBound, max(Self.navigationLimitRange.lowerBound, navigationLimit))
            defaults.set(clamped, forKey: Key.navigationLimit)
        case .agentNavigation: defaults.set(agentNavigation.rawValue, forKey: Key.agentNavigation)
        }
        guard broadcasts else { return }
        if !defaults.synchronize() { log.warning("Could not flush the hub preferences") }
        DistributedNotificationCenter.default().postNotificationName(
            notificationName, object: notificationNamespace, userInfo: nil, deliverImmediately: true)
        log.debug("Hub preferences changed: style=\(self.style.rawValue), glass=\(self.glass)")
    }
}
