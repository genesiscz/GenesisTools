import GenesisKit

// The hub's names for GenesisKit's profiling (Perf/PerfSpans.swift), which began here. The prefix is this
// app's `PerfConfiguration.spanPrefix` ("hub"), so app-perf.log reads as before and
// `scripts/perf-report.ts` needs no change. New code may use the GenesisKit names directly.

typealias HubPerf = PerfSpans
typealias HubMainBusy = PerfMainBusy
typealias HubStallTest = StallTest
