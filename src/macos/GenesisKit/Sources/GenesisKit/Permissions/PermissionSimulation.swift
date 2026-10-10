import Foundation

/// Makes chosen kinds report what a Mac without the grant would, so the real app shows every permission dialog
/// without touching TCC. The defaults key holds comma-separated kind ids (`bun scripts/native/staging.ts deny <ids>`
/// writes it, `allow` removes it). A kind may carry a mode:
///
/// - `input-monitoring`: denied. The dialog explains the grant and opens System Settings.
/// - `microphone:ask`: not asked yet. The dialog offers Continue, which lifts the simulation for this process
///   instead of showing a macOS prompt.
/// - `input-monitoring:stale`: denied in this process, granted for a new one. The dialog offers Relaunch.
///
/// `all` (optionally `all:ask`) applies to every kind. Requests for a simulated kind never reach macOS.
public struct PermissionSimulation: Equatable, Sendable {
    public enum Mode: String, Sendable, CaseIterable {
        case denied
        case ask
        case stale
    }

    public static let defaultsKey = "GenesisToolsSimulateDeniedPermissions"

    public private(set) var modes: [PermissionKind: Mode]
    /// Entries that named no kind, so a caller can say which ones it ignored.
    public private(set) var ignored: [String]

    public init(modes: [PermissionKind: Mode] = [:], ignored: [String] = []) {
        self.modes = modes
        self.ignored = ignored
    }

    public var isEmpty: Bool { modes.isEmpty }

    public static func parse(_ text: String?) -> PermissionSimulation {
        var modes: [PermissionKind: Mode] = [:]
        var ignored: [String] = []
        for raw in (text ?? "").split(whereSeparator: { $0 == "," || $0 == " " || $0 == "\n" }) {
            let entry = String(raw)
            let parts = entry.split(separator: ":", maxSplits: 1).map(String.init)
            let mode: Mode
            if parts.count == 2 {
                guard let parsed = Mode(rawValue: parts[1].lowercased()) else {
                    ignored.append(entry)
                    continue
                }

                mode = parsed
            } else {
                mode = .denied
            }

            if parts[0].lowercased() == "all" {
                for kind in PermissionKind.allCases { modes[kind] = mode }
                continue
            }

            guard let kind = PermissionKind(id: parts[0]) else {
                ignored.append(entry)
                continue
            }

            modes[kind] = mode
        }

        return PermissionSimulation(modes: modes, ignored: ignored)
    }

    public static func current(defaults: UserDefaults = .standard) -> PermissionSimulation {
        parse(defaults.string(forKey: defaultsKey))
    }

    public func mode(for kind: PermissionKind) -> Mode? {
        modes[kind]
    }

    /// The status this process reports while the kind is simulated.
    public func status(for kind: PermissionKind) -> PermissionStatus? {
        switch modes[kind] {
        case .denied, .stale: return .denied
        case .ask: return .notDetermined
        case nil: return nil
        }
    }

    /// The status a NEW process would report: only a stale simulation differs from this process.
    public func freshStatus(for kind: PermissionKind) -> PermissionStatus? {
        switch modes[kind] {
        case .stale: return .granted
        case .denied: return .denied
        case .ask: return .notDetermined
        case nil: return nil
        }
    }

    /// The defaults value that parses back to this simulation, kinds in declaration order.
    public var serialized: String {
        PermissionKind.allCases.compactMap { kind in
            modes[kind].map { $0 == .denied ? kind.rawValue : "\(kind.rawValue):\($0.rawValue)" }
        }.joined(separator: ",")
    }
}
