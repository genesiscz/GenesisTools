import Foundation
import Network

/// Local Network privacy: macOS asks the first time an app reaches a device on the local network and keeps the answer
/// in nehelper's rule store. No API reads that answer, so `status` reads the store itself.
///
/// The store is a keyed archive of `NEPathRule` objects: `SigningIdentifier`, an optional `Path`,
/// `MulticastPreferenceSet` (the user answered) and `DenyMulticast` (the answer was no). An executable outside the
/// installed bundle gets a rule of its own, keyed by its path: a process of an old GenesisTools build, whose bundle a
/// rebuild moved aside, is asked again on its first LAN access (measured 2026-10-12, five such rules in two weeks).
public enum LocalNetworkPrivacy {
    /// nehelper's store; every user can read it.
    public static let ruleStorePath = "/Library/Preferences/com.apple.networkextension.plist"

    /// One answer macOS keeps for an app.
    public struct Rule: Equatable, Sendable, Encodable {
        public let signingIdentifier: String
        /// The executable the answer is for; nil for the installed app's own answer.
        public let path: String?
        public let allowed: Bool

        public init(signingIdentifier: String, path: String?, allowed: Bool) {
            self.signingIdentifier = signingIdentifier
            self.path = path
            self.allowed = allowed
        }
    }

    /// The answered rules for `signingIdentifier` in a rule store; nil when the data is not a keyed archive.
    public static func answeredRules(for signingIdentifier: String, in data: Data) -> [Rule]? {
        guard let root = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
              let objects = root["$objects"] as? [Any] else { return nil }

        // Index 0 of every keyed archive is the string "$null", the target of an absent reference.
        func string(_ reference: Any?) -> String? {
            guard let reference, let index = uidValue(reference), objects.indices.contains(index),
                  let text = objects[index] as? String, text != "$null" else { return nil }
            return text
        }

        var rules: [Rule] = []
        for case let object as [String: Any] in objects where object["SigningIdentifier"] != nil {
            guard object["MulticastPreferenceSet"] as? Bool == true,
                  string(object["SigningIdentifier"]) == signingIdentifier else { continue }
            rules.append(Rule(
                signingIdentifier: signingIdentifier,
                path: string(object["Path"]),
                allowed: object["DenyMulticast"] as? Bool == false))
        }
        return rules
    }

    /// A keyed archive's reference prints as `<CFKeyedArchiverUID …>{value = N}`; Foundation has no public reader.
    package static func uidValue(_ reference: Any) -> Int? {
        let text = String(describing: reference)
        guard text.hasPrefix("<CFKeyedArchiverUID"), let marker = text.range(of: "{value = ") else { return nil }
        return Int(text[marker.upperBound...].prefix(while: \.isNumber))
    }

    /// What macOS answered for `path` (nil: the installed app). No rule means it has not asked yet.
    public static func status(of rules: [Rule], path: String? = nil) -> PermissionStatus {
        let matching = rules.filter { $0.path == path }
        if matching.isEmpty { return .notDetermined }
        return matching.contains(where: \.allowed) ? .granted : .denied
    }

    /// The installed app's answer, from the store as it is now.
    public static func status(for signingIdentifier: String) -> PermissionStatus {
        guard let rules = RuleStoreCache.shared.rules(for: signingIdentifier) else {
            return .unknown("rule store unreadable")
        }
        return status(of: rules)
    }

    /// Every answered rule for `signingIdentifier`; nil when the store cannot be read.
    public static func rules(for signingIdentifier: String) -> [Rule]? {
        RuleStoreCache.shared.rules(for: signingIdentifier)
    }

    /// Reaches the local network once, which makes macOS ask while the answer is open: one TCP connection to the
    /// gateway of the Wi-Fi or Ethernet network, port 80 (a refused connection reached it too). Returns once the
    /// connection got through, `answered()` says the store holds the answer, or `deadline` passes. False when no
    /// local network is up.
    package static func reach(within deadline: TimeInterval, answered: @escaping @Sendable () -> Bool) -> Bool {
        let queue = DispatchQueue(label: "genesiskit.local-network")
        guard let (gateway, interface) = gatewayOfLocalNetwork(queue: queue) else {
            KitHost.log("permission local-network probe: no Wi-Fi or Ethernet gateway")
            return false
        }

        let parameters = NWParameters.tcp
        parameters.requiredInterface = interface
        let connection = NWConnection(to: .hostPort(host: gateway, port: 80), using: parameters)
        let reached = DispatchSemaphore(value: 0)
        connection.stateUpdateHandler = { state in
            switch state {
            case .ready, .failed: reached.signal()
            default: break
            }
        }
        connection.start(queue: queue)
        defer { connection.cancel() }

        // While macOS shows its prompt the connection waits; a refusal never lets it through, so the store says when
        // the user answered. One look per second, never past the deadline.
        let end = Date().addingTimeInterval(deadline)
        while Date() < end {
            if reached.wait(timeout: .now() + 1) == .success {
                KitHost.log("permission local-network probe reached \(gateway)")
                // The store may record the answer a moment after the connection got through.
                for _ in 0..<3 where !answered() { Thread.sleep(forTimeInterval: 1) }
                return true
            }

            if answered() { return true }
        }
        KitHost.log("permission local-network probe had no answer after \(Int(deadline)) s")
        return true
    }

    /// The first gateway of the Wi-Fi or Ethernet path, IPv4 first, with that path's interface. Waits at most 2 s for
    /// the path monitor's first answer.
    private static func gatewayOfLocalNetwork(queue: DispatchQueue) -> (NWEndpoint.Host, NWInterface)? {
        let monitor = NWPathMonitor(prohibitedInterfaceTypes: [.cellular, .loopback, .other])
        let seen = DispatchSemaphore(value: 0)
        let box = PathBox()
        monitor.pathUpdateHandler = { path in
            box.path = path
            seen.signal()
        }
        monitor.start(queue: queue)
        defer { monitor.cancel() }
        guard seen.wait(timeout: .now() + 2) == .success, let path = box.path, path.status == .satisfied,
              let interface = path.availableInterfaces.first(where: { $0.type == .wifi || $0.type == .wiredEthernet })
        else { return nil }

        let hosts = path.gateways.compactMap { endpoint -> NWEndpoint.Host? in
            if case .hostPort(let host, _) = endpoint { return host }
            return nil
        }
        let ipv4 = hosts.first { host in
            if case .ipv4 = host { return true }
            return false
        }
        return (ipv4 ?? hosts.first).map { ($0, interface) }
    }
}

private final class PathBox: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: NWPath?

    var path: NWPath? {
        get { lock.lock(); defer { lock.unlock() }; return stored }
        set { lock.lock(); stored = newValue; lock.unlock() }
    }
}

/// The store's rules per signing identifier, read again only when the file's modification date or size changes:
/// the permission dialog reads the status on every poll.
private final class RuleStoreCache: @unchecked Sendable {
    static let shared = RuleStoreCache()
    private struct Stamp: Equatable {
        let modified: Date?
        let size: Int?
    }

    private let lock = NSLock()
    private var stamp: Stamp?
    private var rulesByIdentifier: [String: [LocalNetworkPrivacy.Rule]] = [:]

    func rules(for signingIdentifier: String) -> [LocalNetworkPrivacy.Rule]? {
        let path = LocalNetworkPrivacy.ruleStorePath
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: path) else {
            KitHost.log("permission local-network: cannot stat \(path)")
            return nil
        }

        let current = Stamp(modified: attributes[.modificationDate] as? Date, size: attributes[.size] as? Int)
        lock.lock()
        defer { lock.unlock() }
        if current != stamp { rulesByIdentifier = [:] }

        if let cached = rulesByIdentifier[signingIdentifier] { return cached }

        guard let data = FileManager.default.contents(atPath: path),
              let rules = LocalNetworkPrivacy.answeredRules(for: signingIdentifier, in: data) else {
            KitHost.log("permission local-network: \(path) is not a readable keyed archive")
            return nil
        }

        stamp = current
        rulesByIdentifier[signingIdentifier] = rules
        return rules
    }
}
