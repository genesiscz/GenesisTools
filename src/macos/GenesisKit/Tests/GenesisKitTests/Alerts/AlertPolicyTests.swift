import Foundation
import XCTest
@testable import GenesisKit

final class AlertPolicyTests: XCTestCase {
    private let gb = 1_000_000_000.0
    private var utc: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }

    /// 2026-10-13 12:00 UTC plus `minutes`.
    private func at(_ minutes: Double) -> Date {
        Date(timeIntervalSince1970: 1_791_892_800 + minutes * 60)
    }

    private func diskPolicy(repeatInterval: TimeInterval? = 3600, quiet: AlertQuietHours? = nil) -> AlertPolicy {
        AlertPolicy(direction: .below, tiers: [
            AlertTier(id: "emergency", threshold: 0.3 * gb, severity: .emergency),
            AlertTier(id: "warn", threshold: 10 * gb, severity: .warning),
            AlertTier(id: "critical", threshold: 1 * gb, severity: .critical),
        ], hysteresisFraction: 0.1, repeatInterval: repeatInterval, quietHours: quiet)
    }

    private func run(_ policy: AlertPolicy, _ values: [(Double, Double)], state: inout AlertState) -> [AlertEvent] {
        values.flatMap { minute, value in policy.evaluate(value, at: at(minute), state: &state, calendar: utc) }
    }

    func testTiersAreOrderedFromMildestToWorstWhateverTheInputOrder() {
        XCTAssertEqual(diskPolicy().orderedTiers.map(\.id), ["warn", "critical", "emergency"])
        let above = AlertPolicy(direction: .above, tiers: [
            AlertTier(id: "hot", threshold: 90, severity: .critical),
            AlertTier(id: "warm", threshold: 70, severity: .warning),
        ])
        XCTAssertEqual(above.orderedTiers.map(\.id), ["warm", "hot"])
    }

    func testNothingHappensAboveEveryThreshold() {
        var state = AlertState()
        XCTAssertTrue(run(diskPolicy(), [(0, 50 * gb), (1, 20 * gb), (2, 10.5 * gb)], state: &state).isEmpty)
        XCTAssertNil(state.tierID)
    }

    func testCrossingRaisesThenEscalatesStepByStepAndAJumpGoesStraightToTheWorstTier() {
        var state = AlertState()
        let events = run(diskPolicy(), [(0, 9 * gb), (1, 0.9 * gb), (2, 0.2 * gb)], state: &state)
        XCTAssertEqual(events.map(\.kind), [.raised, .escalated, .escalated])
        XCTAssertEqual(events.map { $0.tier?.id }, ["warn", "critical", "emergency"])
        XCTAssertEqual(events[1].previousTier?.id, "warn")
        XCTAssertTrue(events.allSatisfy(\.notifies))

        var jump = AlertState()
        let direct = run(diskPolicy(), [(0, 0.1 * gb)], state: &jump)
        XCTAssertEqual(direct.map(\.kind), [.raised])
        XCTAssertEqual(direct.first?.tier?.id, "emergency")
    }

    func testAValueHoveringAtAThresholdRaisesOnceAndNeverFlaps() {
        var state = AlertState()
        let wobble = (0 ..< 40).map { minute in (Double(minute), (minute % 2 == 0 ? 9.95 : 10.05) * gb) }
        let events = run(diskPolicy(repeatInterval: nil), wobble, state: &state)
        XCTAssertEqual(events.map(\.kind), [.raised], "inside the 10-11 GB band it stays on")
        XCTAssertEqual(state.tierID, "warn")
    }

    func testRecoveryNeedsTheClearMarginAndThenClearsOnce() {
        var state = AlertState()
        let events = run(diskPolicy(), [(0, 9 * gb), (1, 10.9 * gb), (2, 11.1 * gb), (3, 11.0 * gb)], state: &state)
        XCTAssertEqual(events.map(\.kind), [.raised, .cleared])
        XCTAssertEqual(events.last?.previousTier?.id, "warn")
        XCTAssertNil(events.last?.tier)
        XCTAssertFalse(events.last?.notifies ?? true, "a recovery does not interrupt")
        XCTAssertEqual(events.last?.severity, .warning, "a cleared event routes on the tier that ended")
        XCTAssertNil(state.tierID)
        XCTAssertNil(state.lastNotified)
    }

    func testRecoveringFromCriticalStepsDownThroughImprovedWithHysteresis() {
        var state = AlertState()
        let events = run(diskPolicy(), [(0, 0.5 * gb), (1, 1.05 * gb), (2, 1.2 * gb), (3, 12 * gb)], state: &state)
        XCTAssertEqual(events.map(\.kind), [.raised, .improved, .cleared])
        XCTAssertEqual(events[1].tier?.id, "warn")
        XCTAssertEqual(events[1].previousTier?.id, "critical")
    }

    func testAPerTierClearMarginOverridesTheFraction() {
        let policy = AlertPolicy(tiers: [AlertTier(id: "low", threshold: 100, severity: .warning, clearMargin: 50)])
        XCTAssertEqual(policy.clearPoint(of: policy.tiers[0]), 150)
        var state = AlertState()
        XCTAssertEqual(policy.evaluate(90, at: at(0), state: &state).map(\.kind), [.raised])
        XCTAssertTrue(policy.evaluate(140, at: at(1), state: &state).isEmpty)
        XCTAssertEqual(policy.evaluate(151, at: at(2), state: &state).map(\.kind), [.cleared])
    }

    func testTheAboveDirectionMirrorsEverything() {
        let policy = AlertPolicy(direction: .above, tiers: [
            AlertTier(id: "warm", threshold: 70, severity: .warning),
            AlertTier(id: "hot", threshold: 90, severity: .critical),
        ], hysteresisFraction: 0.05, repeatInterval: nil)
        var state = AlertState()
        let events = run(policy, [(0, 71), (1, 69), (2, 91), (3, 86), (4, 85), (5, 66)], state: &state)
        XCTAssertEqual(events.map(\.kind), [.raised, .escalated, .improved, .cleared])
        XCTAssertEqual(policy.clearPoint(of: policy.tiers[1]), 85.5)
    }

    func testRemindersFollowTheRepeatIntervalAndATiersOwnInterval() {
        var state = AlertState()
        let events = run(diskPolicy(repeatInterval: 600), [(0, 5 * gb), (5, 5 * gb), (10, 5 * gb), (15, 5 * gb), (20, 5 * gb)],
                         state: &state)
        XCTAssertEqual(events.map(\.kind), [.raised, .reminder, .reminder])
        XCTAssertEqual(events.map(\.date), [at(0), at(10), at(20)])

        var never = AlertState()
        XCTAssertEqual(run(diskPolicy(repeatInterval: nil), [(0, 5 * gb), (600, 5 * gb)], state: &never).count, 1)

        var tiered = diskPolicy(repeatInterval: nil)
        tiered.tiers[1].repeatInterval = 60
        var custom = AlertState()
        XCTAssertEqual(run(tiered, [(0, 5 * gb), (1, 5 * gb)], state: &custom).map(\.kind), [.raised, .reminder])
    }

    func testQuietHoursHoldBackAnAlertAndItNotifiesWhenTheyEnd() {
        // 12:00 to 12:30 UTC is quiet.
        let policy = diskPolicy(quiet: AlertQuietHours(startMinute: 12 * 60, endMinute: 12 * 60 + 30))
        var state = AlertState()
        let held = run(policy, [(0, 5 * gb), (10, 5 * gb)], state: &state)
        XCTAssertEqual(held.map(\.kind), [.raised])
        XCTAssertEqual(held.first?.notifies, false)
        XCTAssertEqual(held.first?.suppression, .quietHours)
        XCTAssertNil(state.lastNotified)
        let after = run(policy, [(31, 5 * gb)], state: &state)
        XCTAssertEqual(after.map(\.kind), [.reminder])
        XCTAssertEqual(after.first?.notifies, true)
        XCTAssertEqual(state.lastNotified, at(31))
    }

    func testAnEmergencyBreaksThroughQuietHoursAndANilOverrideLetsNothingThrough() {
        let policy = diskPolicy(quiet: AlertQuietHours(startMinute: 12 * 60, endMinute: 13 * 60))
        var state = AlertState()
        let events = run(policy, [(0, 5 * gb), (1, 0.1 * gb)], state: &state)
        XCTAssertEqual(events.map(\.notifies), [false, true])
        XCTAssertNil(events.last?.suppression)

        var strict = policy
        strict.emergencyOverride = nil
        var silent = AlertState()
        XCTAssertEqual(run(strict, [(0, 0.1 * gb)], state: &silent).first?.suppression, .quietHours)
    }

    func testQuietHoursWrapPastMidnight() {
        let quiet = AlertQuietHours(startMinute: 22 * 60, endMinute: 7 * 60)
        func time(_ hour: Int, _ minute: Int) -> Date {
            utc.date(from: DateComponents(year: 2026, month: 10, day: 13, hour: hour, minute: minute))!
        }
        XCTAssertTrue(quiet.contains(time(23, 0), calendar: utc))
        XCTAssertTrue(quiet.contains(time(3, 0), calendar: utc))
        XCTAssertFalse(quiet.contains(time(7, 0), calendar: utc), "the end minute is outside")
        XCTAssertFalse(quiet.contains(time(12, 0), calendar: utc))
        XCTAssertFalse(AlertQuietHours(startMinute: 60, endMinute: 60).contains(time(1, 0), calendar: utc), "an empty window")
    }

    func testASnoozeHoldsItsTierBackAWorseSeverityBreaksItAndItExpires() {
        let policy = diskPolicy(repeatInterval: 300)
        var state = AlertState()
        XCTAssertEqual(run(policy, [(0, 5 * gb)], state: &state).first?.notifies, true)
        state = policy.snoozed(state, until: at(60))
        XCTAssertEqual(state.snooze?.severity, .warning)
        XCTAssertTrue(run(policy, [(10, 5 * gb), (20, 5 * gb)], state: &state).isEmpty, "no reminder while snoozed")

        let escalated = run(policy, [(30, 0.8 * gb)], state: &state)
        XCTAssertEqual(escalated.map(\.kind), [.escalated])
        XCTAssertEqual(escalated.first?.notifies, true, "critical is worse than the snoozed warning")
        XCTAssertNil(state.snooze)

        var expiring = AlertState()
        _ = run(policy, [(0, 5 * gb)], state: &expiring)
        expiring = policy.snoozed(expiring, until: at(30))
        XCTAssertTrue(run(policy, [(10, 5 * gb)], state: &expiring).isEmpty)
        let due = run(policy, [(31, 5 * gb)], state: &expiring)
        XCTAssertEqual(due.map(\.kind), [.reminder])
        XCTAssertNil(expiring.snooze)
    }

    func testARaiseDuringASnoozeIsHeldAndShownWhenItEnds() {
        let policy = diskPolicy(repeatInterval: nil)
        var state = policy.snoozed(AlertState(), until: at(30), severity: .warning)
        let raised = run(policy, [(0, 5 * gb)], state: &state)
        XCTAssertEqual(raised.first?.suppression, .snoozed)
        XCTAssertEqual(run(policy, [(31, 5 * gb)], state: &state).map(\.kind), [.reminder],
                       "never shown, so it is shown once even without a repeat interval")
        XCTAssertTrue(run(policy, [(90, 5 * gb)], state: &state).isEmpty)
    }

    func testStateAndPolicyRoundTripThroughJSON() throws {
        let policy = diskPolicy(quiet: AlertQuietHours(startMinute: 1320, endMinute: 420))
        var state = AlertState()
        _ = run(policy, [(0, 5 * gb)], state: &state)
        state = policy.snoozed(state, until: at(60))
        let decodedPolicy = try JSONDecoder().decode(AlertPolicy.self, from: JSONEncoder().encode(policy))
        let decodedState = try JSONDecoder().decode(AlertState.self, from: JSONEncoder().encode(state))
        XCTAssertEqual(decodedPolicy, policy)
        XCTAssertEqual(decodedState, state)
    }

    func testConfirmationNeedsConsecutiveSamplesAndOneGoodSampleResetsIt() {
        var policy = diskPolicy(repeatInterval: nil)
        policy.confirmSamples = 2
        var state = AlertState()
        let dip = run(policy, [(0, 9 * gb), (1, 12 * gb), (2, 9 * gb)], state: &state)
        XCTAssertTrue(dip.isEmpty, "a single sample under the floor, twice, never in a row")
        XCTAssertEqual(state.pendingCount, 1)
        let held = run(policy, [(3, 9 * gb)], state: &state)
        XCTAssertEqual(held.map(\.kind), [.raised])
        XCTAssertEqual(state.pendingCount, 0)
        let escalation = run(policy, [(4, 0.5 * gb), (5, 0.5 * gb)], state: &state)
        XCTAssertEqual(escalation.map(\.kind), [.escalated], "an escalation waits for confirmation too")
        XCTAssertEqual(escalation.first?.date, at(5))
        XCTAssertEqual(run(policy, [(6, 12 * gb)], state: &state).map(\.kind), [.cleared], "recovery is at once")
    }

    func testChangingThePendingTierRestartsItsCountAndDuration() {
        var policy = diskPolicy(repeatInterval: nil)
        policy.confirmSamples = 2
        policy.confirmDuration = 300
        var state = AlertState()
        XCTAssertTrue(run(policy, [(0, 9 * gb), (4, 9 * gb), (5, 0.5 * gb)], state: &state).isEmpty)
        XCTAssertEqual(state.pendingTierID, "critical")
        XCTAssertEqual(state.pendingCount, 1)
        XCTAssertEqual(state.pendingSince, at(5))
        XCTAssertTrue(run(policy, [(9, 0.5 * gb)], state: &state).isEmpty)
        XCTAssertEqual(run(policy, [(10, 0.5 * gb)], state: &state).map(\.kind), [.raised])
        XCTAssertEqual(state.tierID, "critical")
    }

    func testConfirmationByDurationWaitsForTheValueToStayPastTheThreshold() {
        var policy = diskPolicy(repeatInterval: nil)
        policy.confirmDuration = 300
        var state = AlertState()
        XCTAssertTrue(run(policy, [(0, 9 * gb), (4, 9 * gb)], state: &state).isEmpty)
        XCTAssertEqual(run(policy, [(5, 9 * gb)], state: &state).map(\.kind), [.raised])
    }

    func testAPolicyStoredByAnOlderBuildDecodesWithDefaults() throws {
        let old = Data(#"{"direction":"below","tiers":[{"id":"warn","threshold":10,"severity":1}],"hysteresisFraction":0.2}"#.utf8)
        let policy = try JSONDecoder().decode(AlertPolicy.self, from: old)
        XCTAssertEqual(policy.confirmSamples, 1)
        XCTAssertEqual(policy.confirmDuration, 0)
        XCTAssertNil(policy.repeatInterval)
        XCTAssertEqual(policy.tiers.first?.severity, .warning)
        let state = try JSONDecoder().decode(AlertState.self, from: Data(#"{"tierID":"warn"}"#.utf8))
        XCTAssertEqual(state.tierID, "warn")
        XCTAssertEqual(state.pendingCount, 0)
    }

    func testAStaleTierIdFromAnEditedPolicyIsTreatedAsNoTier() {
        var state = AlertState(tierID: "removed-tier", lastNotified: at(0))
        let events = diskPolicy().evaluate(5 * gb, at: at(1), state: &state, calendar: utc)
        XCTAssertEqual(events.map(\.kind), [.raised])
        XCTAssertEqual(state.tierID, "warn")
    }
}

@MainActor
private final class RecordingChannel: AlertChannel {
    let id: String
    let interrupts: Bool
    var delivered: [AlertEvent] = []

    init(id: String, interrupts: Bool) {
        self.id = id
        self.interrupts = interrupts
    }

    func deliver(_ event: AlertEvent) { delivered.append(event) }
}

@MainActor
final class AlertDispatcherTests: XCTestCase {
    private func event(_ kind: AlertEvent.Kind, tier: String?, previous: String? = nil, notifies: Bool) -> AlertEvent {
        AlertEvent(kind: kind, tier: tier.map { AlertTier(id: $0, threshold: 1, severity: .warning) },
                   previousTier: previous.map { AlertTier(id: $0, threshold: 1, severity: .warning) },
                   value: 0, date: Date(timeIntervalSince1970: 0), notifies: notifies,
                   suppression: notifies ? nil : .quietHours)
    }

    func testTheMatrixRoutesEachTierAndAHeldBackEventReachesOnlyStatusChannels() {
        let banner = RecordingChannel(id: "banner", interrupts: true)
        let sound = RecordingChannel(id: "sound", interrupts: true)
        let menu = RecordingChannel(id: "menu", interrupts: false)
        var matrix = AlertChannelMatrix(routes: ["warn": ["banner", "menu"]], fallback: ["menu"])
        matrix.set(true, tierID: "critical", channelID: "sound")
        XCTAssertTrue(matrix.contains(tierID: "critical", channelID: "sound"))
        XCTAssertFalse(matrix.contains(tierID: "critical", channelID: "banner"), "a new row starts from the fallback")
        let dispatcher = AlertDispatcher(channels: [banner, sound, menu], matrix: matrix)

        dispatcher.dispatch([event(.raised, tier: "warn", notifies: true)])
        XCTAssertEqual(banner.delivered.count, 1)
        XCTAssertEqual(sound.delivered.count, 0)
        XCTAssertEqual(menu.delivered.count, 1)

        dispatcher.dispatch([event(.raised, tier: "warn", notifies: false)])
        XCTAssertEqual(banner.delivered.count, 1, "held back: no banner")
        XCTAssertEqual(menu.delivered.count, 2, "the menu tint still follows")

        dispatcher.dispatch([event(.cleared, tier: nil, previous: "warn", notifies: false)])
        XCTAssertEqual(menu.delivered.last?.kind, .cleared, "a cleared event goes to the ended tier's channels")

        dispatcher.dispatch([event(.escalated, tier: "critical", notifies: true)])
        XCTAssertEqual(sound.delivered.count, 1)
        XCTAssertEqual(menu.delivered.count, 4)

        dispatcher.matrix.set(false, tierID: "warn", channelID: "banner")
        dispatcher.dispatch([event(.reminder, tier: "warn", notifies: true)])
        XCTAssertEqual(banner.delivered.count, 1)
    }

    func testEscalationClearsOnlyTheRetiredStatefulRoutes() {
        let old = RecoveryChannel(id: "old")
        let shared = RecoveryChannel(id: "shared")
        let next = RecoveryChannel(id: "next")
        let sound = RecordingChannel(id: "sound", interrupts: true)
        let matrix = AlertChannelMatrix(routes: [
            "warn": ["old", "shared", "sound"], "critical": ["shared", "next"],
        ])
        let dispatcher = AlertDispatcher(channels: [old, shared, next, sound], matrix: matrix)
        dispatcher.dispatch([event(.raised, tier: "warn", notifies: true),
                             event(.escalated, tier: "critical", previous: "warn", notifies: true),
                             event(.cleared, tier: nil, previous: "critical", notifies: false)])
        XCTAssertEqual(old.delivered.map(\.kind), [.raised, .cleared])
        XCTAssertNil(old.delivered.last?.tier)
        XCTAssertEqual(old.delivered.last?.notifies, false)
        XCTAssertEqual(shared.delivered.map(\.kind), [.raised, .escalated, .cleared])
        XCTAssertEqual(next.delivered.map(\.kind), [.escalated, .cleared])
        XCTAssertEqual(sound.delivered.map(\.kind), [.raised])
    }

    func testAddingAChannelWithTheSameIdReplacesIt() {
        let first = RecordingChannel(id: "banner", interrupts: true)
        let second = RecordingChannel(id: "banner", interrupts: true)
        let dispatcher = AlertDispatcher(channels: [first], matrix: AlertChannelMatrix(fallback: ["banner"]))
        dispatcher.add(second)
        dispatcher.dispatch([event(.raised, tier: "x", notifies: true)])
        XCTAssertEqual(first.delivered.count, 0)
        XCTAssertEqual(second.delivered.count, 1)
    }
}

private final class RecoveryChannel: AlertChannel {
    let id: String
    let interrupts = true
    let receivesRecovery = true
    var delivered: [AlertEvent] = []

    init(id: String) {
        self.id = id
    }

    func deliver(_ event: AlertEvent) { delivered.append(event) }
}

extension AlertDispatcherTests {
    /// M3: an edge glow must learn that its tier improved or cleared, or it stays after recovery.
    func testARecoveryReachesAnInterruptingChannelThatAsksForIt() {
        let glow = RecoveryChannel(id: "glow")
        let sound = RecordingChannel(id: "sound", interrupts: true)
        let matrix = AlertChannelMatrix(routes: ["critical": ["glow", "sound"], "low": ["glow"]], fallback: [])
        let dispatcher = AlertDispatcher(channels: [glow, sound], matrix: matrix)
        dispatcher.dispatch([event(.raised, tier: "critical", notifies: true)])
        dispatcher.dispatch([event(.improved, tier: "low", previous: "critical", notifies: false)])
        dispatcher.dispatch([event(.cleared, tier: nil, previous: "low", notifies: false)])
        XCTAssertEqual(glow.delivered.map(\.kind), [.raised, .improved, .cleared])
        XCTAssertEqual(sound.delivered.map(\.kind), [.raised], "a channel that only posts is not called on a recovery")
    }

    func testAMaterializedMatrixNamesTheFallbackForEveryTier() {
        let matrix = AlertChannelMatrix(routes: ["low": ["banner"]], fallback: ["menu"])
        XCTAssertEqual(matrix.materialized(tierIDs: ["low", "critical"]).routes, ["low": ["banner"], "critical": ["menu"]])
    }
}

extension AlertPolicyTests {
    func testANonFiniteReadingChangesNothing() {
        let policy = AlertPolicy.freeSpace()
        var state = AlertState()
        let start = Date(timeIntervalSince1970: 1_791_892_800)
        _ = policy.evaluate(500_000_000, at: start, state: &state)
        _ = policy.evaluate(500_000_000, at: start.addingTimeInterval(60), state: &state)
        let armed = state.tierID
        XCTAssertNotNil(armed)
        XCTAssertTrue(policy.evaluate(.nan, at: start.addingTimeInterval(120), state: &state).isEmpty)
        XCTAssertTrue(policy.evaluate(.infinity, at: start.addingTimeInterval(180), state: &state).isEmpty)
        XCTAssertEqual(state.tierID, armed, "a NaN does not clear the alert")
    }
}
