import Foundation

/// The live cmux layout from `tools ai cmux tree --json`: windows, their workspaces, each
/// workspace's panes (with the rectangle cmux draws them in) and each pane's surfaces (tabs), with
/// the agent session in a surface when the hook journal knows it. GenesisTools.app and Genesis
/// decode this one type; the JSON shape belongs to `tools`.
///
/// Every field but the ids decodes with a default, so an older `tools` that leaves one out still
/// gives a tree.
public struct CmuxTree: Codable, Equatable, Sendable {
    public struct Frame: Codable, Equatable, Sendable {
        public var x: Double
        public var y: Double
        public var width: Double
        public var height: Double

        public init(x: Double, y: Double, width: Double, height: Double) {
            self.x = x
            self.y = y
            self.width = width
            self.height = height
        }
    }

    public struct Size: Codable, Equatable, Sendable {
        public var width: Double
        public var height: Double

        public init(width: Double, height: Double) {
            self.width = width
            self.height = height
        }
    }

    public struct Surface: Codable, Equatable, Sendable, Identifiable {
        public var id: String
        public var title: String
        public var type: String
        public var index: Int
        public var selected: Bool
        public var active: Bool
        public var sessionId: String?
        /// The agent in the surface ("claude", "codex", "grok"), when a session is known.
        public var provider: String?
        /// The first 8 characters of a session id, when only a title names it.
        public var sessionHint: String?

        public init(
            id: String,
            title: String = "",
            type: String = "terminal",
            index: Int = 0,
            selected: Bool = false,
            active: Bool = false,
            sessionId: String? = nil,
            provider: String? = nil,
            sessionHint: String? = nil
        ) {
            self.id = id
            self.title = title
            self.type = type
            self.index = index
            self.selected = selected
            self.active = active
            self.sessionId = sessionId
            self.provider = provider
            self.sessionHint = sessionHint
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try c.decode(String.self, forKey: .id)
            title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
            type = try c.decodeIfPresent(String.self, forKey: .type) ?? "terminal"
            index = try c.decodeIfPresent(Int.self, forKey: .index) ?? 0
            selected = try c.decodeIfPresent(Bool.self, forKey: .selected) ?? false
            active = try c.decodeIfPresent(Bool.self, forKey: .active) ?? false
            sessionId = try c.decodeIfPresent(String.self, forKey: .sessionId)
            provider = try c.decodeIfPresent(String.self, forKey: .provider)
            sessionHint = try c.decodeIfPresent(String.self, forKey: .sessionHint)
        }

        /// Whether the surface holds `sessionId` (by full id, or by its 8-character hint).
        public func holds(_ sessionId: String) -> Bool {
            let key = sessionId.lowercased()
            return self.sessionId?.lowercased() == key || sessionHint?.lowercased() == String(key.prefix(8))
        }
    }

    public struct Pane: Codable, Equatable, Sendable, Identifiable {
        public var id: String
        public var title: String
        public var active: Bool
        public var cwd: String?
        /// Where cmux draws the pane, in the window's points; nil from an older `tools`.
        public var frame: Frame?
        public var container: Size?
        public var selectedSurfaceId: String?
        public var surfaces: [Surface]

        public init(
            id: String,
            title: String = "",
            active: Bool = false,
            cwd: String? = nil,
            frame: Frame? = nil,
            container: Size? = nil,
            selectedSurfaceId: String? = nil,
            surfaces: [Surface] = []
        ) {
            self.id = id
            self.title = title
            self.active = active
            self.cwd = cwd
            self.frame = frame
            self.container = container
            self.selectedSurfaceId = selectedSurfaceId
            self.surfaces = surfaces
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try c.decode(String.self, forKey: .id)
            title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
            active = try c.decodeIfPresent(Bool.self, forKey: .active) ?? false
            cwd = try c.decodeIfPresent(String.self, forKey: .cwd)
            frame = try c.decodeIfPresent(Frame.self, forKey: .frame)
            container = try c.decodeIfPresent(Size.self, forKey: .container)
            selectedSurfaceId = try c.decodeIfPresent(String.self, forKey: .selectedSurfaceId)
            surfaces = try c.decodeIfPresent([Surface].self, forKey: .surfaces) ?? []
        }
    }

    public struct Workspace: Codable, Equatable, Sendable, Identifiable {
        public var id: String
        public var name: String
        public var panes: [Pane]

        public init(id: String, name: String = "", panes: [Pane] = []) {
            self.id = id
            self.name = name
            self.panes = panes
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try c.decode(String.self, forKey: .id)
            name = try c.decodeIfPresent(String.self, forKey: .name) ?? ""
            panes = try c.decodeIfPresent([Pane].self, forKey: .panes) ?? []
        }
    }

    public struct Window: Codable, Equatable, Sendable, Identifiable {
        public var id: String
        /// "window:1"; the name cmux's CLI takes.
        public var ref: String?
        public var index: Int
        /// The front window.
        public var key: Bool
        public var workspaces: [Workspace]

        public init(id: String, ref: String? = nil, index: Int = 0, key: Bool = false, workspaces: [Workspace] = []) {
            self.id = id
            self.ref = ref
            self.index = index
            self.key = key
            self.workspaces = workspaces
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try c.decode(String.self, forKey: .id)
            ref = try c.decodeIfPresent(String.self, forKey: .ref)
            index = try c.decodeIfPresent(Int.self, forKey: .index) ?? 0
            key = try c.decodeIfPresent(Bool.self, forKey: .key) ?? false
            workspaces = try c.decodeIfPresent([Workspace].self, forKey: .workspaces) ?? []
        }

        public var label: String { ref ?? "window \(index + 1)" }
        /// What a new workspace in this window is opened with.
        public var target: String { ref ?? id }
    }

    public var fetchedAt: String
    public var available: Bool
    /// Why the tree is empty ("cmux is not running"), when `available` is false.
    public var error: String?
    public var windows: [Window]
    public var totalMs: Double

    public init(fetchedAt: String = "", available: Bool = false, error: String? = nil, windows: [Window] = [], totalMs: Double = 0) {
        self.fetchedAt = fetchedAt
        self.available = available
        self.error = error
        self.windows = windows
        self.totalMs = totalMs
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        fetchedAt = try c.decodeIfPresent(String.self, forKey: .fetchedAt) ?? ""
        available = try c.decodeIfPresent(Bool.self, forKey: .available) ?? false
        error = try c.decodeIfPresent(String.self, forKey: .error)
        windows = try c.decodeIfPresent([Window].self, forKey: .windows) ?? []
        totalMs = try c.decodeIfPresent(Double.self, forKey: .totalMs) ?? 0
    }

    /// Decodes the command's stdout. Anything printed before the JSON (a profiler line, a warning)
    /// is skipped: the object starts at the first `{` that begins a line.
    public static func decode(_ data: Data) throws -> CmuxTree {
        try JSONDecoder().decode(CmuxTree.self, from: jsonPayload(data))
    }

    static func jsonPayload(_ data: Data) -> Data {
        let bytes = [UInt8](data)
        var index = 0
        while index < bytes.count {
            if bytes[index] == UInt8(ascii: "{"), index == 0 || bytes[index - 1] == UInt8(ascii: "\n") {
                return Data(bytes[index...])
            }
            index += 1
        }
        return data
    }

    /// The surface a session runs in, if the journal places it in one.
    public func surface(of sessionId: String) -> (window: Window, workspace: Workspace, pane: Pane, surface: Surface)? {
        for window in windows {
            for workspace in window.workspaces {
                for pane in workspace.panes {
                    if let surface = pane.surfaces.first(where: { $0.holds(sessionId) }) {
                        return (window, workspace, pane, surface)
                    }
                }
            }
        }
        return nil
    }

    /// Every session id and 8-character hint in the tree, lowercased.
    public var liveSessionKeys: Set<String> {
        var keys = Set<String>()
        for window in windows {
            for workspace in window.workspaces {
                for pane in workspace.panes {
                    for surface in pane.surfaces {
                        if let id = surface.sessionId { keys.insert(id.lowercased()) }
                        if let hint = surface.sessionHint { keys.insert(hint.lowercased()) }
                    }
                }
            }
        }
        return keys
    }

    /// True when the session (full id) has a surface in the live tree.
    public func hostsSession(_ sessionId: String) -> Bool {
        let id = sessionId.lowercased()
        let keys = liveSessionKeys
        return keys.contains(id) || keys.contains(String(id.prefix(8)))
    }
}

/// Where to open something in cmux: the level decides what gets created.
public enum CmuxTarget: Hashable, Sendable {
    /// A new workspace (in this window, or the current one when nil).
    case newWorkspace(window: String?)
    /// A new pane (a split) in a workspace.
    case newPane(workspace: String)
    /// A new tab in a pane.
    case newTab(workspace: String, pane: String)
    /// Type into an existing surface.
    case surface(workspace: String, surface: String)

    public var label: String {
        switch self {
        case .newWorkspace(let window): return window.map { "a new workspace in \($0)" } ?? "a new workspace"
        case .newPane(let workspace): return "a new pane in \(workspace)"
        case .newTab(let workspace, let pane): return "a new tab in \(pane) (\(workspace))"
        case .surface(_, let surface): return "the existing tab \(surface)"
        }
    }

    /// The flags `tools claude cmux open-session` takes for this target; nil for a new workspace in
    /// the current window, which that command cannot name.
    public var openSessionArgs: [String]? {
        switch self {
        case .newWorkspace(let window): return window.map { ["--window", $0] }
        case .newPane(let workspace): return ["--workspace", workspace]
        case .newTab(let workspace, let pane): return ["--workspace", workspace, "--pane", pane]
        case .surface(let workspace, let surface): return ["--workspace", workspace, "--surface", surface]
        }
    }

    /// Where a session last ran, from its journalled refs: a new tab in its pane, else its tab.
    public static func lastPane(workspace: String?, pane: String?, surface: String?) -> CmuxTarget? {
        func nonempty(_ value: String?) -> String? {
            guard let value, !value.isEmpty else { return nil }
            return value
        }
        guard let workspace = nonempty(workspace) else { return nil }
        if let pane = nonempty(pane) {
            return .newTab(workspace: workspace, pane: pane)
        }
        if let surface = nonempty(surface) {
            return .surface(workspace: workspace, surface: surface)
        }
        return nil
    }
}
