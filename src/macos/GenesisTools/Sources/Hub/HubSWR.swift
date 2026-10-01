import Foundation

// Stale-while-revalidate for the hub's slow reads. The pieces both apps share are GenesisKit's:
// `DiskCache` (with `load` off the main thread), `SWR` (changed rows, flash, row transition),
// `.swrFlash` and `RefreshingMark`. This file is the hub's glue: its cache folder and its perf line.
// The PR list (`PRsModel`, Hub/HubPRs.swift) is the reference; destructive actions (worktree removal,
// a process stop) never trust a cached row and keep their own live re-check.

enum HubSWR {
    /// `~/.genesis-tools/hub/cache/<namespace>-<hash>.json`.
    static func cache(_ namespace: String) -> DiskCache {
        DiskCache(folder: "hub", namespace: namespace)
    }

    /// "hub.<area> cache painted: <detail>" in app-perf.log, before that area's fresh span ends. The
    /// first one per area also prints its offset from launch (`phase hub.<area>.cache-painted +N ms`).
    static func painted(_ area: String, _ detail: String) {
        HubPerf.log("\(area) cache painted: \(detail)")
        PerfLog.markOnce("hub.\(area).cache-painted")
    }
}
