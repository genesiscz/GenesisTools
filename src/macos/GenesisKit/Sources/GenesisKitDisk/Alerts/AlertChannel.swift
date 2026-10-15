import Foundation
import GenesisKit

/// One way an alert reaches the user: a banner, a sound, speech, a screen glow, a menu tint. The app implements
/// each; the kit decides which ones an event goes to.
@MainActor
public protocol AlertChannel: AnyObject {
    /// Stable id, the column of an `AlertChannelMatrix` (`banner`, `sound`, `speech`, `glow`, `menu`).
    var id: String { get }
    /// True for a channel that interrupts (banner, sound, speech, glow): it gets a `.raised`, `.escalated` or
    /// `.reminder` only when the event `notifies`. False for a status channel (menu tint, a page), which gets every
    /// event, held back or not.
    var interrupts: Bool { get }
    /// True for an interrupting channel that shows a state and must take it back (an edge glow, a persistent
    /// banner): it also gets `.improved` and `.cleared` (with `notifies == false`) for the tier it was routed. The
    /// default is false, so a channel that only posts (a sound) is never called on a recovery.
    var receivesRecovery: Bool { get }
    func deliver(_ event: AlertEvent)
}

public extension AlertChannel {
    var receivesRecovery: Bool { false }
}

/// Which channels each tier uses: tier id to channel ids. A tier missing from the map uses `fallback`.
public struct AlertChannelMatrix: Codable, Equatable, Sendable {
    public var routes: [String: Set<String>]
    public var fallback: Set<String>

    public init(routes: [String: Set<String>] = [:], fallback: Set<String> = []) {
        self.routes = routes
        self.fallback = fallback
    }

    public func channels(for tierID: String?) -> Set<String> {
        guard let tierID else { return fallback }
        return routes[tierID] ?? fallback
    }

    public func contains(tierID: String, channelID: String) -> Bool {
        channels(for: tierID).contains(channelID)
    }

    public mutating func set(_ enabled: Bool, tierID: String, channelID: String) {
        var current = channels(for: tierID)
        if enabled { current.insert(channelID) } else { current.remove(channelID) }
        routes[tierID] = current
    }

    /// Every tier in `tierIDs` with an explicit route (a missing one gets `fallback`), for a settings grid that
    /// binds `routes` directly and would otherwise read a missing tier as "no channels".
    public func materialized(tierIDs: [String]) -> AlertChannelMatrix {
        var copy = self
        for id in tierIDs where copy.routes[id] == nil { copy.routes[id] = fallback }
        return copy
    }
}

/// Sends a policy's events to the app's channels by the matrix. An `.improved` or `.cleared` event goes to the
/// channels of the tier that ended (and, for `.improved`, of the milder tier now on): every status channel, and the
/// interrupting channels that set `receivesRecovery`, so a glow or a persistent banner can be taken back.
@MainActor
public final class AlertDispatcher {
    public private(set) var channels: [AlertChannel]
    public var matrix: AlertChannelMatrix

    public init(channels: [AlertChannel], matrix: AlertChannelMatrix) {
        self.channels = channels
        self.matrix = matrix
    }

    public func add(_ channel: AlertChannel) {
        channels.removeAll { $0.id == channel.id }
        channels.append(channel)
    }

    /// The channels an event reaches, in the order they were added.
    public func targets(for event: AlertEvent) -> [AlertChannel] {
        switch event.kind {
        case .improved, .cleared:
            var routed = matrix.channels(for: event.previousTier?.id)
            if let tier = event.tier { routed.formUnion(matrix.channels(for: tier.id)) }
            return channels.filter { routed.contains($0.id) && (!$0.interrupts || $0.receivesRecovery) }
        case .raised, .escalated, .reminder:
            let routed = matrix.channels(for: (event.tier ?? event.previousTier)?.id)
            return channels.filter { routed.contains($0.id) && (event.notifies || !$0.interrupts) }
        }
    }

    public func dispatch(_ events: [AlertEvent]) {
        for event in events {
            if event.kind == .escalated, let previous = event.previousTier {
                let retired = matrix.channels(for: previous.id)
                    .subtracting(matrix.channels(for: event.tier?.id))
                let clear = AlertEvent(kind: .cleared, tier: nil, previousTier: previous,
                                       value: event.value, date: event.date, notifies: false, suppression: nil)
                for channel in channels where retired.contains(channel.id) && (!channel.interrupts || channel.receivesRecovery) {
                    channel.deliver(clear)
                }
            }
            for channel in targets(for: event) { channel.deliver(event) }
        }
    }
}
