import SwiftUI

public enum WidgetModulePresentation: Int, Comparable, Sendable {
    case compact, preview, expanded

    public static func < (lhs: Self, rhs: Self) -> Bool { lhs.rawValue < rhs.rawValue }
}

public struct WidgetSurfaceID: Hashable, Sendable {
    public var edge: EdgePanelPlacement
    public var group: Int

    public init(edge: EdgePanelPlacement, group: Int = 0) {
        self.edge = edge
        self.group = max(0, group)
    }

    public var key: String { edge.rawValue + "." + String(group) }
}

@MainActor
public struct WidgetModuleDescriptor: Identifiable {
    public let id: String
    public let title: String
    public let symbol: String
    public let tint: Color
    public let expandedSize: CGSize
    public let summary: () -> String
    public let content: (WidgetModulePresentation) -> AnyView
    public let visibilityChanged: (WidgetModulePresentation?) -> Void

    public init<Content: View>(
        id: String, title: String, symbol: String, tint: Color,
        expandedSize: CGSize = CGSize(width: 432, height: 540),
        summary: @escaping () -> String,
        visibilityChanged: @escaping (WidgetModulePresentation?) -> Void = { _ in },
        @ViewBuilder content: @escaping (WidgetModulePresentation) -> Content
    ) {
        self.id = id
        self.title = title
        self.symbol = symbol
        self.tint = tint
        self.expandedSize = expandedSize
        self.summary = summary
        self.visibilityChanged = visibilityChanged
        self.content = { AnyView(content($0)) }
    }
}

public enum WidgetRegistryError: LocalizedError, Equatable {
    case invalidIdentifier(String)
    case duplicateIdentifier(String)

    public var errorDescription: String? {
        switch self {
        case .invalidIdentifier(let id): return "Invalid widget identifier: " + id
        case .duplicateIdentifier(let id): return "A widget is already registered as " + id
        }
    }
}

@MainActor
public final class WidgetModuleRegistry: ObservableObject {
    @Published public private(set) var modules: [WidgetModuleDescriptor] = []
    private var surfaces: [WidgetSurfaceID: (id: String, presentation: WidgetModulePresentation)] = [:]

    public init() {}

    public func register(_ module: WidgetModuleDescriptor) throws {
        guard module.id.range(of: "^[a-z][a-z0-9-]{0,47}$", options: .regularExpression) != nil else {
            throw WidgetRegistryError.invalidIdentifier(module.id)
        }
        guard !modules.contains(where: { $0.id == module.id }) else {
            throw WidgetRegistryError.duplicateIdentifier(module.id)
        }
        modules.append(module)
    }

    public func module(_ id: String) -> WidgetModuleDescriptor? { modules.first { $0.id == id } }

    public func update(
        surface: WidgetSurfaceID, moduleID: String?, presentation: WidgetModulePresentation = .compact
    ) {
        let before = visiblePresentations()
        if let moduleID, module(moduleID) != nil {
            surfaces[surface] = (moduleID, presentation)
        } else {
            surfaces.removeValue(forKey: surface)
        }
        publishChanges(from: before)
    }

    public func removeAllSurfaces() {
        let before = visiblePresentations()
        surfaces.removeAll()
        publishChanges(from: before)
    }

    private func visiblePresentations() -> [String: WidgetModulePresentation] {
        Dictionary(grouping: surfaces.values, by: \.id).compactMapValues { values in
            values.map(\.presentation).max()
        }
    }

    private func publishChanges(from before: [String: WidgetModulePresentation]) {
        let after = visiblePresentations()
        for module in modules where before[module.id] != after[module.id] {
            module.visibilityChanged(after[module.id])
        }
    }
}
