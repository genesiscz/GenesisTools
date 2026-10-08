import Combine
import Foundation
import SwiftUI
import os

@MainActor
public struct NativeSettingsPage: Identifiable {
    public let id: String
    public let title: String
    public let symbol: String
    public let tint: Color
    public let subtitle: String
    let content: () -> AnyView

    public init<Content: View>(
        id: String, title: String, symbol: String, tint: Color,
        subtitle: String = "", @ViewBuilder content: @escaping () -> Content
    ) {
        self.id = id
        self.title = title
        self.symbol = symbol
        self.tint = tint
        self.subtitle = subtitle
        self.content = { AnyView(content()) }
    }
}

@MainActor
public struct NativeSettingsSection: Identifiable {
    public let id: String
    public let title: String
    public let pages: [NativeSettingsPage]
    public let order: Int

    public init(id: String, title: String, pages: [NativeSettingsPage], order: Int = 50) {
        self.id = id
        self.title = title
        self.pages = pages
        self.order = order
    }
}

public enum NativeSettingsCatalogError: Error, Equatable, CustomStringConvertible {
    case emptySectionID
    case emptyPageID
    case duplicateSectionID(String)
    case duplicatePageID(String)

    public var description: String {
        switch self {
        case .emptySectionID: return "A settings section has an empty identifier."
        case .emptyPageID: return "A settings page has an empty identifier."
        case .duplicateSectionID(let id): return "Duplicate settings section: \(id)"
        case .duplicatePageID(let id): return "Duplicate settings page: \(id)"
        }
    }
}

@MainActor
public final class NativeSettingsStore: ObservableObject {
    @Published public private(set) var sections: [NativeSettingsSection]
    @Published public private(set) var selectedPageID: String?
    @Published public private(set) var catalogError: NativeSettingsCatalogError?
    public let appearance: NativeSettingsAppearance
    public private(set) var pendingPageID: String?
    private let defaults: UserDefaults
    private let selectionKey: String

    public init(
        sections: [NativeSettingsSection], defaults: UserDefaults = .standard,
        selectionKey: String = "featureSettings.selectedPage", initialPageID: String? = nil,
        appearance: NativeSettingsAppearance? = nil
    ) {
        self.defaults = defaults
        self.selectionKey = selectionKey
        self.appearance = appearance ?? .shared
        let error = Self.validate(sections)
        catalogError = error
        let acceptedSections = error == nil ? sections.sorted { $0.order < $1.order } : []
        self.sections = acceptedSections
        let requested = initialPageID ?? defaults.string(forKey: selectionKey)
        let pages = acceptedSections.flatMap(\.pages)
        selectedPageID = pages.first(where: { $0.id == requested })?.id ?? pages.first?.id
        pendingPageID = requested != selectedPageID ? requested : nil
    }

    public var selectedPage: NativeSettingsPage? {
        sections.lazy.flatMap(\.pages).first { $0.id == selectedPageID }
    }

    @discardableResult
    public func select(pageID: String) -> Bool {
        guard sections.contains(where: { $0.pages.contains(where: { $0.id == pageID }) }) else {
            pendingPageID = pageID
            return false
        }
        pendingPageID = nil
        selectedPageID = pageID
        defaults.set(pageID, forKey: selectionKey)
        return true
    }

    @discardableResult
    public func register(section: NativeSettingsSection) -> Bool {
        var candidate = sections
        if let index = candidate.firstIndex(where: { $0.id == section.id }) {
            candidate[index] = section
        } else {
            candidate.append(section)
        }
        if let error = Self.validate(candidate) {
            catalogError = error
            return false
        }
        catalogError = nil
        candidate.sort { $0.order < $1.order }
        sections = candidate
        if let pendingPageID, candidate.contains(where: { $0.pages.contains(where: { $0.id == pendingPageID }) }) {
            return select(pageID: pendingPageID)
        }
        if selectedPage == nil { selectedPageID = candidate.lazy.flatMap(\.pages).first?.id }
        return true
    }

    public static func validate(_ sections: [NativeSettingsSection]) -> NativeSettingsCatalogError? {
        var sectionIDs: Set<String> = []
        var pageIDs: Set<String> = []
        for section in sections {
            guard !section.id.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return .emptySectionID }
            guard sectionIDs.insert(section.id).inserted else { return .duplicateSectionID(section.id) }
            for page in section.pages {
                guard !page.id.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return .emptyPageID }
                guard pageIDs.insert(page.id).inserted else { return .duplicatePageID(page.id) }
            }
        }
        return nil
    }
}

public enum NativeSettingsTheme: String, CaseIterable, Codable, Identifiable {
    case glass, solid, gradient
    public var id: String { rawValue }
    public var title: String { rawValue.capitalized }
    public func effective(reduceTransparency: Bool, systemReduceTransparency: Bool) -> NativeSettingsTheme {
        reduceTransparency || systemReduceTransparency ? .solid : self
    }
}

@MainActor
public final class NativeSettingsAppearance: ObservableObject {
    public static let shared = NativeSettingsAppearance()
    @Published public var reduceMotion: Bool { didSet { if oldValue != reduceMotion { persist(fields: [.motion]) } } }
    @Published public var reduceTransparency: Bool {
        didSet { if oldValue != reduceTransparency { persist(fields: [.transparency]) } }
    }
    @Published public var theme: NativeSettingsTheme { didSet { if oldValue != theme { persist(fields: [.theme]) } } }
    private enum Field { case motion, transparency, theme }
    public let notificationNamespace: String
    public let notificationName: Notification.Name
    private let defaults: UserDefaults
    private let keyPrefix: String
    private var observer: NSObjectProtocol?
    private var applyingExternal = false
    private let log: Logger

    public init(
        defaults: UserDefaults = .standard,
        notificationNamespace: String = Bundle.main.bundleIdentifier ?? "dev.genesis.native",
        keyPrefix: String = "featureSettings.appearance", observeExternalChanges: Bool = true
    ) {
        self.defaults = defaults
        self.keyPrefix = keyPrefix
        self.notificationNamespace = notificationNamespace
        notificationName = Notification.Name("\(notificationNamespace).featureSettings.appearanceChanged")
        log = Logger(subsystem: notificationNamespace, category: "NativeSettings")
        reduceMotion = defaults.bool(forKey: "\(keyPrefix).reduceMotion")
        reduceTransparency = defaults.bool(forKey: "\(keyPrefix).reduceTransparency")
        theme = NativeSettingsTheme(rawValue: defaults.string(forKey: "\(keyPrefix).theme") ?? "") ?? .glass
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

    public func migrateIfNeeded(reduceMotion legacyMotion: Bool, reduceTransparency legacyTransparency: Bool) {
        let missingMotion = defaults.object(forKey: "\(keyPrefix).reduceMotion") == nil
        let missingTransparency = defaults.object(forKey: "\(keyPrefix).reduceTransparency") == nil
        guard missingMotion || missingTransparency else { return }
        applyingExternal = true
        if missingMotion { reduceMotion = legacyMotion }
        if missingTransparency { reduceTransparency = legacyTransparency }
        applyingExternal = false
        var changed: [Field] = []
        if missingMotion { changed.append(.motion) }
        if missingTransparency { changed.append(.transparency) }
        persist(fields: changed)
    }

    public func reloadFromDefaults() {
        defaults.synchronize()
        let motion = defaults.bool(forKey: "\(keyPrefix).reduceMotion")
        let transparency = defaults.bool(forKey: "\(keyPrefix).reduceTransparency")
        let storedTheme = NativeSettingsTheme(rawValue: defaults.string(forKey: "\(keyPrefix).theme") ?? "") ?? .glass
        applyingExternal = true
        if reduceMotion != motion { reduceMotion = motion }
        if reduceTransparency != transparency { reduceTransparency = transparency }
        if theme != storedTheme { theme = storedTheme }
        applyingExternal = false
    }

    private func persist(fields: [Field]) {
        guard !applyingExternal else { return }
        for field in fields {
            switch field {
            case .motion: defaults.set(reduceMotion, forKey: "\(keyPrefix).reduceMotion")
            case .transparency: defaults.set(reduceTransparency, forKey: "\(keyPrefix).reduceTransparency")
            case .theme: defaults.set(theme.rawValue, forKey: "\(keyPrefix).theme")
            }
        }
        if !defaults.synchronize() { log.warning("Could not flush shared appearance preferences") }
        DistributedNotificationCenter.default().postNotificationName(
            notificationName, object: notificationNamespace, userInfo: nil, deliverImmediately: true)
        log.debug("Appearance changed: motion=\(self.reduceMotion), transparency=\(self.reduceTransparency)")
    }
}
