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

/// A settings link can name a card on its page: `widgets.sessions#inbox-preview` selects the page and pulses the card
/// that carries `.nativeSettingsAnchor("inbox-preview")`. One settings window per process, so one shared center.
@MainActor
public final class NativeSettingsHighlightCenter: ObservableObject {
    public static let shared = NativeSettingsHighlightCenter()
    @Published public private(set) var anchor: String?
    /// Bumped on every request, so the same card asked for twice pulses twice.
    @Published public private(set) var token = 0
    /// The last request a card pulsed for, so going back to the page does not replay an old one.
    private var deliveredToken = 0
    /// When the last request came: a card that appears later (a page that opens on it) flashes only what is left of
    /// the flash, and a page visited again later does not flash or scroll again.
    @Published public private(set) var requestedAt: Date?

    public func request(_ anchor: String) {
        self.anchor = anchor
        requestedAt = Date()
        token += 1
    }

    /// True once per request, for the card that carries `anchor`.
    func consume(_ anchor: String) -> Bool {
        guard self.anchor == anchor, deliveredToken != token else { return false }
        deliveredToken = token
        return true
    }

    /// "page#anchor" into its page id and the anchor; a plain page id has no anchor.
    public nonisolated static func split(_ requested: String) -> (page: String, anchor: String?) {
        guard let mark = requested.firstIndex(of: "#") else { return (requested, nil) }
        let anchor = String(requested[requested.index(after: mark)...])
        return (String(requested[..<mark]), anchor.isEmpty ? nil : anchor)
    }
}

private struct NativeSettingsAnchor: ViewModifier {
    let id: String
    @ObservedObject private var center = NativeSettingsHighlightCenter.shared
    @State private var pulses = 0

    func body(content: Content) -> some View {
        content
            .attentionPulse(trigger: pulses)
            // A window that opens on the page asks before the card exists: the card pulses once it is on screen.
            .onAppear { if center.consume(id) { pulseSoon() } }
            .onChange(of: center.token) { _, _ in if center.consume(id) { pulseSoon() } }
    }

    private func pulseSoon() {
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(350))
            pulses += 1
        }
    }
}

extension View {
    /// Names this card for a settings link (`<page>#<id>`): following the link pulses it.
    public func nativeSettingsAnchor(_ id: String) -> some View {
        modifier(NativeSettingsAnchor(id: id))
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
        let link = initialPageID.map(NativeSettingsHighlightCenter.split)
        let requested = link?.page ?? defaults.string(forKey: selectionKey)
        let pages = acceptedSections.flatMap(\.pages)
        selectedPageID = pages.first(where: { $0.id == requested })?.id ?? pages.first?.id
        pendingPageID = requested != selectedPageID ? requested : nil
        if let anchor = link?.anchor { NativeSettingsHighlightCenter.shared.request(anchor) }
    }

    public var selectedPage: NativeSettingsPage? {
        sections.lazy.flatMap(\.pages).first { $0.id == selectedPageID }
    }

    /// `pageID` may name a card too (`<page>#<anchor>`): the page opens and the card pulses.
    @discardableResult
    public func select(pageID requested: String) -> Bool {
        let (pageID, anchor) = NativeSettingsHighlightCenter.split(requested)
        guard sections.contains(where: { $0.pages.contains(where: { $0.id == pageID }) }) else {
            pendingPageID = requested
            return false
        }
        pendingPageID = nil
        selectedPageID = pageID
        defaults.set(pageID, forKey: selectionKey)
        if let anchor { NativeSettingsHighlightCenter.shared.request(anchor) }
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
        if let pendingPageID, candidate.contains(where: {
            $0.pages.contains(where: { $0.id == NativeSettingsHighlightCenter.split(pendingPageID).page })
        }) {
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

/// The look of native feature windows and widgets (General → Theme).
public enum NativeSettingsTheme: String, CaseIterable, Codable, Identifiable {
    /// The glass material under a strong dark tint: translucent, about as dark as the hub's own glass.
    case glass
    /// The system's window background.
    case solid
    /// The system's window background under a purple-to-pink tint.
    case gradient
    /// Solid near-black, close to the hub's own surfaces.
    case graphite
    /// Solid deep blue-black with cool hairlines.
    case midnight
    /// Gradient's hues, darker and richer.
    case dusk

    /// A stored value, read with the names of themes that were folded into another: "smoked" (Smoked glass,
    /// 2026-10-11) became Glass. Nil for anything else unknown, so the caller keeps its own default.
    public init?(stored raw: String?) {
        guard let raw else { return nil }
        if raw == "smoked" {
            self = .glass
            return
        }
        self.init(rawValue: raw)
    }

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        guard let theme = NativeSettingsTheme(stored: raw) else {
            throw DecodingError.dataCorrupted(
                DecodingError.Context(codingPath: decoder.codingPath, debugDescription: "Unknown theme \(raw)"))
        }
        self = theme
    }

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .glass: return "Glass"
        case .solid: return "Solid"
        case .gradient: return "Gradient"
        case .graphite: return "Graphite"
        case .midnight: return "Midnight"
        case .dusk: return "Dusk"
        }
    }

    /// The window shows the blurred desktop behind it.
    public var isSeeThrough: Bool {
        switch self {
        case .glass: return true
        case .solid, .gradient, .graphite, .midnight, .dusk: return false
        }
    }

    /// The theme drawn while Reduce transparency is on: Glass shows Graphite, Solid and Gradient show Solid, and the
    /// other opaque themes stay as they are.
    public func effective(reduceTransparency: Bool, systemReduceTransparency: Bool) -> NativeSettingsTheme {
        guard reduceTransparency || systemReduceTransparency else { return self }
        switch self {
        case .solid, .gradient: return .solid
        case .glass, .graphite: return .graphite
        case .midnight: return .midnight
        case .dusk: return .dusk
        }
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
    /// Fields an earlier `migrateIfNeeded` set. Over defaults that drop writes (a settings snapshot) their keys stay
    /// missing, and a second model's migration must not overwrite the first one's value.
    private var migratedFields: Set<Field> = []
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
        theme = NativeSettingsTheme(stored: defaults.string(forKey: "\(keyPrefix).theme")) ?? .glass
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
            && !migratedFields.contains(.motion)
        let missingTransparency = defaults.object(forKey: "\(keyPrefix).reduceTransparency") == nil
            && !migratedFields.contains(.transparency)
        guard missingMotion || missingTransparency else { return }
        applyingExternal = true
        if missingMotion { reduceMotion = legacyMotion }
        if missingTransparency { reduceTransparency = legacyTransparency }
        applyingExternal = false
        var changed: [Field] = []
        if missingMotion { changed.append(.motion) }
        if missingTransparency { changed.append(.transparency) }
        migratedFields.formUnion(changed)
        persist(fields: changed)
    }

    public func reloadFromDefaults() {
        defaults.synchronize()
        let motion = defaults.bool(forKey: "\(keyPrefix).reduceMotion")
        let transparency = defaults.bool(forKey: "\(keyPrefix).reduceTransparency")
        let storedTheme = NativeSettingsTheme(stored: defaults.string(forKey: "\(keyPrefix).theme")) ?? .glass
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
