// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground/Genesis/apps/Genesis/Sources/Genesis/Companion/Shared/ConstraintLoopDetector.swift at 2026-10-08T05:07:50+02:00 at commit hash 7bd89a24c79510fb90ab0c2a0701c1d085f2023e
// Copied from /Users/Martin/Tresors/Projects/Rewind/apps/timetravel-app/TimeTravel/TimeTravel/Shared/ConstraintLoopDetector.swift at 2026-07-20T00:25:25+02:00 at commit hash 39b6b2f1865aed017e1ea1a0f6a4c0434df36311
//
//  ConstraintLoopDetector.swift
//  TimeTravel
//
//  Detects and logs constraint update loops in debug builds.
//  Helps catch the "Update Constraints in Window pass" NSGenericException early.
//

import Foundation
import os

/// Detects constraint update loops by counting updates per window per run loop cycle.
/// When too many updates occur (indicating a loop), it logs a fault and triggers an assertion.
@MainActor
final class ConstraintLoopDetector {

    // MARK: - Singleton

    static let shared = ConstraintLoopDetector()

    // MARK: - Properties

    private var updateCounts: [ObjectIdentifier: Int] = [:]
    // Increased from 50 to 100 to accommodate timeline scroll with many segments
    private let maxUpdatesPerCycle = 100
    private let logger = Logger(subsystem: "foltyn.TimeTravel", category: "Constraints")
    private var hasScheduledReset = false

    // MARK: - Initialization

    private init() {
        logger.info("ConstraintLoopDetector initialized")
    }

    // MARK: - Public Methods

    /// Call at start of each constraint update cycle for a window.
    /// Returns `true` if safe to proceed, `false` if loop detected (caller should skip super).
    /// - Parameter window: The window being updated
    @discardableResult
    func beginUpdate(for window: AnyObject) -> Bool {
        let id = ObjectIdentifier(window)
        updateCounts[id, default: 0] += 1

        // Schedule reset for end of run loop cycle if not already scheduled
        if !hasScheduledReset {
            hasScheduledReset = true
            RunLoop.main.perform { [weak self] in
                self?.resetCycle()
            }
        }

        let count = updateCounts[id]!
        if count > maxUpdatesPerCycle {
            let windowDesc = String(describing: type(of: window))
            logger.fault("Constraint loop detected! \(windowDesc) has \(count) updates — BREAKING loop")

            #if DEBUG
            // Log stack trace once at threshold+1 only (not every subsequent call)
            if count == maxUpdatesPerCycle + 1 {
                let symbols = Thread.callStackSymbols.prefix(15).joined(separator: "\n")
                logger.error("Stack trace:\n\(symbols)")
            }
            #endif

            return false  // Signal caller to skip super call
        } else if count > 50 {
            let windowDesc = String(describing: type(of: window))
            logger.warning("High constraint update count: \(windowDesc) has \(count) updates")
        }

        return true
    }

    /// Manually reset the cycle counts.
    /// Called automatically at end of run loop, but can be called manually if needed.
    func resetCycle() {
        updateCounts.removeAll(keepingCapacity: true)
        hasScheduledReset = false
    }

    /// Get current update count for a window (for testing/debugging)
    func updateCount(for window: AnyObject) -> Int {
        updateCounts[ObjectIdentifier(window)] ?? 0
    }
}
