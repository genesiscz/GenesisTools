import Foundation

public let genesisAppBundleIdentifier = "com.genesiscz.genesistools"

/// The process macOS consults for every TCC decision about ax-tool, read from the kernel by the
/// caller. Its plain name is what the user has to find in System Settings.
public struct ResponsibleProcess: Equatable {
    public let pid: Int32
    public let bundleId: String?
    public let path: String
    /// NSRunningApplication's localized name, which is how the System Settings list shows it.
    public let localizedName: String?

    public init(pid: Int32, bundleId: String?, path: String, localizedName: String?) {
        self.pid = pid
        self.bundleId = bundleId
        self.path = path
        self.localizedName = localizedName
    }

    public var viaGenesisApp: Bool { bundleId == genesisAppBundleIdentifier }

    /// `/Applications/Foo.app` for a binary inside that bundle.
    var appBundlePath: String? {
        guard let range = path.range(of: #"^.*/[^/]+\.app(?=/|$)"#, options: .regularExpression) else { return nil }
        return String(path[range])
    }

    /// "Terminal", "GenesisTools", "agent": the entry to look for in the pane.
    public var displayName: String {
        if viaGenesisApp { return "GenesisTools" }
        if let name = localizedName?.trimmingCharacters(in: .whitespaces), !name.isEmpty { return name }
        if let bundle = appBundlePath { return ((bundle as NSString).lastPathComponent as NSString).deletingPathExtension }
        if !path.isEmpty { return (path as NSString).lastPathComponent }
        return bundleId ?? "the process that launched ax-tool"
    }

    /// "Terminal (com.apple.Terminal)": the plain name first, then what tells it apart.
    public var described: String {
        let id = bundleId ?? appBundlePath ?? (path.isEmpty ? nil : path)
        guard let id, id != displayName else { return displayName }
        return "\(displayName) (\(id))"
    }

    /// "2.1.286" when the binary sits under a version folder that the next update replaces.
    public var versionFolder: String? {
        (path as NSString).deletingLastPathComponent.split(separator: "/").map(String.init).first {
            $0.range(of: #"^v?\d+\.\d+\.\d+([-+.][0-9A-Za-z.-]+)?$"#, options: .regularExpression) != nil
        }
    }
}

public enum PermissionGrant {
    case accessibility
    case screenRecording

    var label: String {
        switch self {
        case .accessibility: return "Accessibility"
        case .screenRecording: return "Screen Recording"
        }
    }

    var reason: String {
        switch self {
        case .accessibility: return "accessibility-not-granted"
        case .screenRecording: return "screen-recording-not-granted"
        }
    }

    var pane: String {
        switch self {
        case .accessibility: return "accessibility"
        case .screenRecording: return "screen-recording"
        }
    }
}

/// The one message every refusal for a missing grant prints. It is a claim about the CALLER,
/// never about the target app: an untrusted client gets an empty window list from every app, and
/// reporting that as "no windows for X" sent a session chasing a window bug that did not exist
/// (handoff h_xt5ixzf9).
public func permissionRefusalMessage(_ grant: PermissionGrant, responsible: ResponsibleProcess) -> String {
    let name = responsible.displayName
    var parts = [
        "\(grant.label) is not granted to \(responsible.described), the app macOS holds responsible for ax-tool (pid \(responsible.pid)).",
        "Turn on \(name) in System Settings > Privacy & Security > \(grant.label) (`tools macos permissions open --pane \(grant.pane)`); add it with + if it is not listed.",
        // macOS applies a new Screen Recording grant to a process only after it restarts.
        grant == .screenRecording ? "If you just granted it, quit and reopen \(name), then re-run." : "Then re-run.",
    ]
    if let version = responsible.versionFolder {
        parts.append("\(name) runs from a versioned folder (…/\(version)/…), so its next update drops this grant; GenesisTools.app keeps one identity across updates.")
    }
    if !responsible.viaGenesisApp {
        parts.append("GenesisTools.app can hold this grant once for every terminal and agent.")
    }
    parts.append("`tools control doctor` shows every grant tools control needs.")
    return parts.joined(separator: " ")
}

/// The structured refusal: agents branch on `reason`, and the `responsible*` fields name the
/// identity to grant without parsing the message.
public func permissionRefusal(_ grant: PermissionGrant, responsible: ResponsibleProcess, pid: Int32) -> [String: Any] {
    [
        "ok": false,
        "error": permissionRefusalMessage(grant, responsible: responsible),
        "reason": grant.reason,
        "refusal": SnapshotRefusal.permission.rawValue,
        "pid": pid,
        "responsible": responsible.bundleId ?? "unknown",
        "responsiblePid": responsible.pid,
        "responsibleBundleId": responsible.bundleId ?? "",
        "responsiblePath": responsible.path,
        "responsibleName": responsible.displayName,
        "viaGenesisApp": responsible.viaGenesisApp,
    ]
}
