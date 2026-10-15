import Darwin
import Foundation
import XCTest
@testable import GenesisKit

final class VolumeSpaceTests: XCTestCase {
    func testStatfsReadsTheDataVolumeAndCostsMicroseconds() throws {
        let path = VolumeSpaceMonitor.defaultVolumePath
        let sample = try VolumeSpaceMonitor.read(path: path)
        XCTAssertGreaterThan(sample.total, 0)
        XCTAssertGreaterThan(sample.available, 0)
        XCTAssertLessThanOrEqual(sample.available, sample.total)
        XCTAssertNil(sample.importantUsage, "the timer read never asks CacheDelete")

        let rounds = 20_000
        var info = statfs()
        let rawStart = clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID)
        for _ in 0 ..< rounds { _ = statfs(path, &info) }
        let rawCPU = Double(clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID) - rawStart) / Double(rounds)
        let wrappedStart = clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID)
        for _ in 0 ..< rounds { _ = try VolumeSpaceMonitor.read(path: path) }
        let wrappedCPU = Double(clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID) - wrappedStart) / Double(rounds)
        print(String(format: "statfs cost: %.2f µs CPU per raw call, %.2f µs per VolumeSample read (%d rounds)",
                     rawCPU / 1000, wrappedCPU / 1000, rounds))
        XCTAssertLessThan(wrappedCPU, 50_000, "a sample must stay in the microseconds")
    }

    func testAMissingPathThrows() {
        XCTAssertThrowsError(try VolumeSpaceMonitor.read(path: "/no/such/volume-\(UUID())"))
    }

    func testPublishThresholdAndCadence() {
        let base = VolumeSample(volumePath: "/v", total: 100, free: 50_000_000, available: 50_000_000, date: Date())
        var moved = base
        moved.available += 999_999
        XCTAssertFalse(moved.differs(from: base, minimumChange: 1_000_000))
        moved.available += 1
        XCTAssertTrue(moved.differs(from: base, minimumChange: 1_000_000))
        var level = base
        level.lowDiskLevel = .low
        XCTAssertTrue(level.differs(from: base, minimumChange: 1_000_000))
        var detailed = base
        detailed.importantUsage = 60_000_000
        XCTAssertTrue(detailed.differs(from: base, minimumChange: 1_000_000))

        let config = VolumeSpaceMonitor.Configuration(floor: 10_000_000_000, nearBand: 5_000_000_000)
        XCTAssertEqual(config.interval(forAvailable: 20_000_000_000), 300)
        XCTAssertEqual(config.interval(forAvailable: 14_000_000_000), 30)
        XCTAssertEqual(config.interval(forAvailable: 0), 30)
    }

    func testTheKernelsLowDiskFlagsMapToALevel() {
        XCTAssertEqual(VolumeLowDiskLevel.from(fsEventFlags: 0x2004), .low, "LOWDISK|NEARLOWDISK seen at 10.7 GB")
        XCTAssertEqual(VolumeLowDiskLevel.from(fsEventFlags: 0x0204), .veryLow)
        XCTAssertEqual(VolumeLowDiskLevel.from(fsEventFlags: 0x2000), .nearLow)
        XCTAssertEqual(VolumeLowDiskLevel.from(fsEventFlags: 0x4001), .ok)
        XCTAssertNil(VolumeLowDiskLevel.from(fsEventFlags: 0x0001), "an update names no level")
        XCTAssertTrue(VolumeSampler.canWatchLowDiskEvents(), "EVFILT_FS needs no privileges")
    }

    func testMountedVolumesIncludeTheDataVolume() {
        let volumes = VolumeSpaceMonitor.mountedVolumes()
        XCTAssertTrue(volumes.contains { $0.isRoot && $0.path == VolumeSpaceMonitor.defaultVolumePath && $0.total > 0 })
    }
}

@MainActor
final class VolumeSpaceMonitorTests: XCTestCase {
    func testDetailedAndQueuedSamplesAreDiscardedAfterSwitchingVolumes() async {
        let monitor = VolumeSpaceMonitor(configuration: .init(volumePath: "/fixture-a", watchesWorkspace: false))
        let entered = expectation(description: "detailed read entered")
        let release = AsyncStream<Void>.makeStream()
        let stale = VolumeSample(volumePath: "/fixture-a", total: 100, free: 50, available: 50, date: Date())
        var published = 0
        monitor.onSample = { _ in published += 1 }
        let pending = Task {
            await monitor.refreshDetailed { _, _ in
                entered.fulfill()
                for await _ in release.stream { break }
                return stale
            }
        }
        await fulfillment(of: [entered], timeout: 5)
        monitor.configuration.volumePath = "/fixture-b"
        monitor.configuration.volumePath = "/fixture-a" // Same path again is still a different request generation.
        release.continuation.yield(())
        release.continuation.finish()
        let result = await pending.value
        XCTAssertNil(result)
        monitor.receive(stale, generation: 0)
        XCTAssertNil(monitor.sample)
        XCTAssertEqual(published, 0)
        monitor.receive(stale, generation: 2)
        XCTAssertEqual(monitor.sample, stale)
        XCTAssertEqual(published, 1)
    }

    private func waitUntil(_ message: String, timeout: TimeInterval = 5, _ condition: () -> Bool) async {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() {
            if Date() > deadline { return XCTFail("timed out: \(message)") }
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
    }

    func testPublishesOnStartThenOnlyWhatMovedAndPokesCoalesce() async {
        let monitor = VolumeSpaceMonitor(configuration: .init(
            minimumChange: 1 << 50, pokeSpacing: 0.2, watchesLowDiskEvents: true, watchesWorkspace: false))
        var published = 0
        monitor.onSample = { _ in published += 1 }
        monitor.start()
        defer { monitor.stop() }
        await waitUntil("first sample") { monitor.sample != nil }
        XCTAssertTrue(monitor.isRunning)
        for _ in 0 ..< 5 { monitor.poke() }
        try? await Task.sleep(nanoseconds: 600_000_000)
        XCTAssertEqual(published, 1, "nothing moved by a petabyte, so nothing was published again")

        monitor.configuration.minimumChange = 0
        await waitUntil("a configuration change reads again and publishes") { published >= 2 }
    }

    func testRefreshDetailedAddsFindersFigureAndKeepsItBetweenReads() async {
        let monitor = VolumeSpaceMonitor(configuration: .init(minimumChange: 0, watchesWorkspace: false))
        let detailed = await monitor.refreshDetailed()
        XCTAssertNotNil(detailed?.importantUsage)
        XCTAssertNotNil(monitor.sample?.importantUsage)
        monitor.start()
        defer { monitor.stop() }
        monitor.poke()
        try? await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertNotNil(monitor.sample?.importantUsage, "a plain read carries the purgeable part along")
    }

    func testSettlingAfterAReclaimReportsTheSpaceThatReturned() async throws {
        let monitor = VolumeSpaceMonitor(configuration: .init(settleSchedule: [0.05, 0.15], watchesWorkspace: false))
        let now = try VolumeSpaceMonitor.read(path: VolumeSpaceMonitor.defaultVolumePath)
        var before = now
        before.available -= 5_000_000_000
        monitor.beginSettling(label: "fixture reclaim", baseline: before)
        XCTAssertEqual(monitor.settling?.checksTotal, 2)
        XCTAssertEqual(monitor.settling?.finished, false)
        await waitUntil("settled") { monitor.settling?.finished == true }
        let gained = try XCTUnwrap(monitor.settling?.gained)
        XCTAssertGreaterThan(gained, 4_000_000_000)
        XCTAssertLessThan(gained, 6_000_000_000)
        monitor.endSettling()
        XCTAssertNil(monitor.settling)
    }
}

final class SpaceForecasterTests: XCTestCase {
    private let gb: Int64 = 1_000_000_000
    private let start = Date(timeIntervalSince1970: 1_791_892_800)

    private func series(_ minutes: Int, every step: Int = 5, _ value: (Int) -> Int64) -> [SpacePoint] {
        stride(from: 0, through: minutes, by: step).map { SpacePoint(date: start.addingTimeInterval(Double($0) * 60), available: value($0)) }
    }

    func testASteadyFillGivesARateAndBothTimes() throws {
        // 12 GB falling 1 GB per hour.
        let points = series(60) { 12 * self.gb - Int64($0) * self.gb / 60 }
        let forecast = SpaceForecaster(floor: 10 * gb).forecast(points)
        XCTAssertEqual(forecast.verdict, .filling)
        XCTAssertEqual(forecast.bytesPerHour, -1e9, accuracy: 1e7)
        XCTAssertEqual(try XCTUnwrap(forecast.timeToFloor), 3600, accuracy: 60, "11 GB left, 1 GB over the floor")
        XCTAssertEqual(try XCTUnwrap(forecast.timeToZero), 11 * 3600, accuracy: 600)
        XCTAssertGreaterThan(forecast.confidence, 0.8)
    }

    func testCleanupsThatOutweighTheWritingGiveNoFullTime() {
        // An hour of agent builds: 2 GB written every 10 minutes, and a 5 GB cleanup every 10 minutes in between.
        // Free space rose by 18 GB overall, so "full in N hours" would contradict the chart.
        var points: [SpacePoint] = []
        var free = 20 * gb
        for minute in stride(from: 0, through: 60, by: 5) {
            points.append(SpacePoint(date: start.addingTimeInterval(Double(minute) * 60), available: free))
            free += minute % 10 == 0 ? -(gb * 2 / 2) : 5 * gb
        }
        let forecast = SpaceForecaster(floor: 10 * gb).forecast(points)
        XCTAssertEqual(forecast.verdict, .erratic)
        XCTAssertNil(forecast.timeToZero)
        XCTAssertEqual(forecast.cleanedBytes, 30 * gb)
    }

    func testADeleteJumpIsIgnored() {
        var points = series(60) { 12 * self.gb - Int64($0) * self.gb / 60 }
        for index in points.indices where index >= 6 { points[index].available += 5 * gb }
        let forecast = SpaceForecaster(floor: 10 * gb).forecast(points)
        XCTAssertEqual(forecast.verdict, .filling)
        XCTAssertEqual(forecast.jumpsIgnored, 1)
        XCTAssertEqual(forecast.bytesPerHour, -1e9, accuracy: 1e7)
    }

    func testRefusesHonestly() {
        let forecaster = SpaceForecaster(floor: 10 * gb)
        XCTAssertEqual(forecaster.forecast([]).verdict, .notEnoughHistory)
        XCTAssertEqual(forecaster.forecast(series(5) { _ in 12 * self.gb }).verdict, .notEnoughHistory)
        XCTAssertEqual(forecaster.forecast(series(60) { 12 * self.gb + Int64($0 % 2) * 1_000_000 }).verdict, .stable)
        XCTAssertEqual(forecaster.forecast(series(60) { 12 * self.gb + Int64($0) * self.gb / 60 }).verdict, .freeing)
        let swings = forecaster.forecast(series(60) { 12 * self.gb + ($0 / 5 % 2 == 0 ? 0 : 900_000_000) })
        XCTAssertEqual(swings.verdict, .erratic)
    }

    func testUnderTheFloorAlreadyIsZeroTime() throws {
        let points = series(60) { 9 * self.gb - Int64($0) * self.gb / 60 }
        let forecast = SpaceForecaster(floor: 10 * gb).forecast(points)
        XCTAssertEqual(try XCTUnwrap(forecast.timeToFloor), 0)
    }

    func testOnlyTheWindowCounts() {
        // An old fast fill, then a flat hour.
        let old = series(60) { 50 * self.gb - Int64($0) * self.gb }
        let recent = (0 ... 12).map { SpacePoint(date: self.start.addingTimeInterval(7200 + Double($0) * 300), available: 10 * self.gb) }
        XCTAssertEqual(SpaceForecaster(floor: gb).forecast(old + recent).verdict, .stable)
    }
}

final class DiskHistoryStoreTests: XCTestCase {
    func testFailedInitializationRetriesLoadingBeforeCompaction() async throws {
        try Data("temporarily obstructed".utf8).write(to: directory)
        let store = DiskHistoryStore(directory: directory)
        do {
            _ = try await store.points()
            XCTFail("a file is not a history directory")
        } catch {}
        try FileManager.default.removeItem(at: directory)
        let original = DiskHistoryStore(directory: directory)
        let reading = sample(0, 1234)
        try await original.append(reading)
        try await store.compact(now: reading.date)
        let points = try await DiskHistoryStore(directory: directory).points()
        XCTAssertEqual(points, [DiskHistoryPoint(reading)])
    }

    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("disk-history-\(UUID())")
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    private func sample(_ seconds: TimeInterval, _ available: Int64) -> VolumeSample {
        VolumeSample(volumePath: "/v", total: 1_000_000_000_000, free: available, available: available,
                     date: Date(timeIntervalSince1970: 1_791_892_800 + seconds))
    }

    func testCloseReadingsAreSkippedUnlessSpaceMovedAndEverythingSurvivesARestart() async throws {
        let store = DiskHistoryStore(directory: directory)
        let first = try await store.append(sample(0, 10_000_000_000))
        let close = try await store.append(sample(10, 10_050_000_000))
        let moved = try await store.append(sample(20, 9_000_000_000))
        XCTAssertEqual([first, close, moved], [true, false, true])
        try await store.record(DiskHistoryEvent(date: Date(timeIntervalSince1970: 1_791_892_830), kind: "reclaim",
                                                label: "fixture", bytes: 2_000_000_000, availableBefore: 9, availableAfter: 11))
        let reopened = DiskHistoryStore(directory: directory)
        let points = try await reopened.points()
        let events = try await reopened.events()
        XCTAssertEqual(points.map(\.available), [10_000_000_000, 9_000_000_000])
        XCTAssertEqual(events.first?.label, "fixture")
        XCTAssertEqual(events.first?.bytes, 2_000_000_000)
        let health = await reopened.health
        XCTAssertEqual(health, .ok)
        let line = try String(contentsOf: directory.appendingPathComponent("samples.ndjson"), encoding: .utf8)
        XCTAssertLessThan(line.split(separator: "\n").first?.utf8.count ?? 999, 90, "a compact line")
    }

    func testDownsamplingKeepsADayAtFullResolutionThenTheLowestPerHourAndPerDay() {
        let now = Date(timeIntervalSince1970: 1_791_892_800)
        var points: [DiskHistoryPoint] = []
        for minute in stride(from: 0, to: 3 * 24 * 60, by: 10) {
            let date = now.addingTimeInterval(-Double(minute) * 60)
            points.append(DiskHistoryPoint(date: date, available: Int64(1_000 + minute), free: 0, total: 0))
        }
        points.append(DiskHistoryPoint(date: now.addingTimeInterval(-500 * 86_400), available: 1, free: 0, total: 0))
        let limits = DiskHistoryStore.Limits(fullResolution: 86_400, hourlyFor: 2 * 86_400)
        let kept = DiskHistoryStore.downsample(points, now: now, limits: limits)
        let recent = kept.filter { now.timeIntervalSince($0.date) <= 86_400 }
        XCTAssertEqual(recent.count, 145, "every 10-minute point of the last day")
        let hourly = kept.filter { (86_400 ... 2 * 86_400).contains(now.timeIntervalSince($0.date)) }
        XCTAssertLessThanOrEqual(hourly.count, 25)
        XCTAssertGreaterThanOrEqual(hourly.count, 23)
        XCTAssertFalse(kept.contains { $0.available == 1 }, "older than keepFor goes")
        // Each hourly bucket keeps its lowest value.
        let bucket = points.filter { $0.date >= now.addingTimeInterval(-30 * 3600) && $0.date < now.addingTimeInterval(-29 * 3600) }
        XCTAssertTrue(kept.contains { $0.available == bucket.map(\.available).min() })
    }

    func testCompactionRewritesTheFileSmaller() async throws {
        let store = DiskHistoryStore(directory: directory, limits: .init(minimumSpacing: 0, compactEvery: 10_000))
        let now: TimeInterval = 10 * 86_400
        for minute in 0 ..< 3000 {
            try await store.append(sample(now - Double(3000 - minute) * 240, Int64(minute)))
        }
        let url = directory.appendingPathComponent("samples.ndjson")
        let before = try Data(contentsOf: url).count
        try await store.compact(now: Date(timeIntervalSince1970: 1_791_892_800 + now))
        let after = try Data(contentsOf: url).count
        XCTAssertLessThan(after, before / 2)
        let reread = try await DiskHistoryStore(directory: directory).points()
        let stored = try await store.points()
        XCTAssertEqual(reread, stored)
    }

    func testAnUnreadableFileIsKeptByteForByteAndAppendsStop() async throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appendingPathComponent("samples.ndjson")
        let garbage = Data("not json\nstill not\n{\"t\":1,\"a\":2,\"f\":3,\"T\":4}\n".utf8)
        try garbage.write(to: url)
        let store = DiskHistoryStore(directory: directory)
        let stored = try await store.append(sample(0, 1))
        XCTAssertFalse(stored)
        try await store.compact()
        let health = await store.health
        XCTAssertEqual(health, .unreadable(url.path))
        XCTAssertEqual(try Data(contentsOf: url), garbage)
    }

    func testACutShortLastLineIsTolerated() async throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appendingPathComponent("samples.ndjson")
        try Data("{\"t\":1,\"a\":2,\"f\":3,\"T\":4}\n{\"t\":2,\"a\":5,\"f\":6,\"T\"".utf8).write(to: url)
        let store = DiskHistoryStore(directory: directory)
        let points = try await store.points()
        XCTAssertEqual(points.map(\.available), [2])
        let health = await store.health
        XCTAssertEqual(health, .ok)
    }
}

final class BigFileRadarTests: XCTestCase {
    func testDirectoryBudgetCountsDirectoriesAndSymlinks() throws {
        for index in 0..<20 {
            let folder = directory.appendingPathComponent("folder-\(index)")
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: false)
            try FileManager.default.createSymbolicLink(at: directory.appendingPathComponent("link-\(index)"),
                                                       withDestinationURL: folder)
        }
        let radar = BigFileRadar(configuration: .init(maxDirectoryEntries: 3)) { _ in }
        XCTAssertTrue(radar.processNow(FileEventBatch(rescanRoots: [directory.path])).isEmpty)
        XCTAssertEqual(radar.directoryEntryReads, 3)
        XCTAssertEqual(radar.statCount, 0)
    }

    func testAnIgnoredRescanRootIsNeverRead() throws {
        let radar = radar(ignore: ["*/node_modules/*"])
        _ = try write("node_modules/large.bin", bytes: 2_000_000)
        let ignored = directory.appendingPathComponent("node_modules").path
        XCTAssertTrue(radar.processNow(FileEventBatch(rescanRoots: [ignored])).isEmpty)
        XCTAssertEqual(radar.folderReads, 0)
        XCTAssertEqual(radar.statCount, 0)
    }

    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("radar-\(UUID())")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    private func write(_ name: String, bytes: Int, append: Bool = false) throws -> String {
        let url = directory.appendingPathComponent(name)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let chunk = Data(repeating: 0x5A, count: bytes)
        if append, let handle = try? FileHandle(forWritingTo: url) {
            try handle.seekToEnd()
            try handle.write(contentsOf: chunk)
            try handle.close()
        } else {
            try chunk.write(to: url)
        }
        return url.path
    }

    private func radar(threshold: Int64 = 1_000_000, step: Int64 = 1_000_000, ignore: [String] = []) -> BigFileRadar {
        BigFileRadar(configuration: .init(threshold: threshold, growthStep: step, ignorePatterns: ignore)) { _ in }
    }

    private func batch(_ paths: [String], flags: FileEventFlags = [.itemModified, .itemIsFile]) -> FileEventBatch {
        FileEventBatch(events: paths.map { FileEvent(path: $0, flags: flags, id: 1) })
    }

    func testANewBigFileIsReportedOnceThenAgainOnlyAfterItGrewAStep() throws {
        let radar = radar()
        let small = try write("small.bin", bytes: 100_000)
        let big = try write("session.jsonl", bytes: 2_000_000)
        let first = radar.processNow(batch([small, big]))
        XCTAssertEqual(first.map(\.path), [big])
        XCTAssertEqual(first.first?.isNew, true)
        XCTAssertEqual(first.first?.culprit, .jsonlLog)
        XCTAssertGreaterThanOrEqual(first.first?.allocatedBytes ?? 0, 2_000_000)
        XCTAssertTrue(radar.processNow(batch([big])).isEmpty, "unchanged")
        _ = try write("session.jsonl", bytes: 500_000, append: true)
        XCTAssertTrue(radar.processNow(batch([big])).isEmpty, "grew less than a step")
        _ = try write("session.jsonl", bytes: 700_000, append: true)
        let grown = radar.processNow(batch([big]))
        XCTAssertEqual(grown.first?.isNew, false)
        XCTAssertGreaterThanOrEqual(grown.first?.delta ?? 0, 1_000_000)
        XCTAssertEqual(radar.hits.map(\.path), [big])
    }

    func testIgnoredPathsAreNeverStatted() throws {
        let radar = radar(ignore: ["*/ignored/*"])
        let hidden = try write("ignored/big.bin", bytes: 2_000_000)
        XCTAssertTrue(radar.processNow(batch([hidden])).isEmpty)
    }

    func testAFolderEventAndARescanRootReadTheFoldersEntries() throws {
        let radar = radar()
        let big = try write("nested/big.raw", bytes: 2_000_000)
        let folder = directory.appendingPathComponent("nested").path
        let viaFolder = radar.processNow(batch([folder], flags: [.itemCreated, .itemIsDir]))
        XCTAssertEqual(viaFolder.map(\.path), [big])
        _ = try write("nested/big.raw", bytes: 1_500_000, append: true)
        let rescan = radar.processNow(FileEventBatch(rescanRoots: [directory.path]))
        XCTAssertEqual(rescan.map(\.path), [big], "a tracked file under a rescan root is checked again")
    }

    func testARemovedFileIsForgotten() throws {
        let radar = radar()
        let big = try write("gone.bin", bytes: 2_000_000)
        XCTAssertEqual(radar.processNow(batch([big])).count, 1)
        try FileManager.default.removeItem(atPath: big)
        XCTAssertTrue(radar.processNow(batch([big], flags: [.itemRemoved, .itemIsFile])).isEmpty)
        _ = try write("gone.bin", bytes: 2_000_000)
        XCTAssertEqual(radar.processNow(batch([big])).first?.isNew, true, "it comes back as new")
    }

    func testTheHitsCallbackMayReadTheRadarWithoutADeadlock() throws {
        final class Holder: @unchecked Sendable { var radar: BigFileRadar?; var seen = 0 }
        let holder = Holder()
        let done = expectation(description: "hits delivered")
        holder.radar = BigFileRadar(configuration: .init(threshold: 1_000_000)) { hits in
            holder.seen = holder.radar?.hits.count ?? -1
            _ = holder.radar?.configuration
            done.fulfill()
        }
        let big = try write("callback.bin", bytes: 2_000_000)
        holder.radar?.consume(batch([big]))
        wait(for: [done], timeout: 5)
        XCTAssertEqual(holder.seen, 1)
    }

    func testCulpritsAreRecognisedByPath() {
        let cases: [(String, RadarCulprit?)] = [
            ("/var/folders/ab/xyz/X/com.google.Chrome.code_sign_clone/code_sign_clone.aKu3zG/Google Chrome.app.bundle/Contents/MacOS/Google Chrome", .codeSignClone),
            ("/Users/alice/Library/Containers/com.docker.docker/Data/vms/0/data/Docker.raw", .dockerImage),
            ("/Users/alice/Library/Group Containers/HUAQ24HBR6.dev.orbstack/data/data.img.raw", .dockerImage),
            ("/Users/alice/Library/Developer/Xcode/DerivedData/App-abc/Build/x.o", .xcodeDerivedData),
            ("/Users/alice/Library/Developer/CoreSimulator/Devices/1/data/big", .simulatorRuntime),
            ("/Users/alice/Projects/kit/.build/arm64-apple-macosx/debug/x.o", .swiftPMBuild),
            ("/Users/alice/Projects/web/node_modules/pkg/big.wasm", .nodeModules),
            ("/Users/alice/.claude/projects/p/session.jsonl", .jsonlLog),
            ("/Users/alice/Library/Logs/app.log", .logFile),
            ("/private/tmp/cc/scratch/file.bin", .temporaryFile),
            ("/var/folders/ab/xyz/T/download.part", .temporaryFile),
            ("/Users/alice/Movies/clip.mov", nil),
        ]
        for (path, expected) in cases {
            XCTAssertEqual(RadarCulprit.classify(path: path), expected, path)
        }
        XCTAssertEqual(Set(RadarCulprit.all.map(\.id)).count, RadarCulprit.all.count)
    }
}

final class DiskSystemProbeTests: XCTestCase {
    func testCPUWindowKeepsItsReferenceWithUnevenSampling() {
        var gate = FseventsdGate(growthWindow: 60, cpuLimit: 1.5, cpuWindow: 600)
        for index in 0...30 {
            let seconds = Double(index * 61)
            let hot = gate.update(FseventsdHealth(pid: 340, rssBytes: 1000, cpuSeconds: seconds * 2,
                                                 date: Date(timeIntervalSince1970: seconds)))
            XCTAssertEqual(hot, index >= 10)
            XCTAssertLessThanOrEqual(gate.history.count, 11)
        }
    }

    func testTheFreeSpaceDefaultMatchesTheDesign() {
        let policy = AlertPolicy.freeSpace()
        XCTAssertEqual(policy.orderedTiers.map(\.id), ["watch", "low", "critical"])
        XCTAssertEqual(policy.orderedTiers.map(\.severity), [.warning, .critical, .emergency])
        XCTAssertEqual(policy.confirmSamples, 2)
        XCTAssertEqual(policy.clearPoint(of: policy.orderedTiers[0]), 15_000_000_000, "re-arms only above 1.5 x the floor")
        var state = AlertState()
        XCTAssertTrue(policy.evaluate(9e9, at: Date(timeIntervalSince1970: 0), state: &state).isEmpty)
        XCTAssertEqual(policy.evaluate(9e9, at: Date(timeIntervalSince1970: 60), state: &state).map(\.kind), [.raised])
    }

    func testFseventsdParsingAndALiveRead() throws {
        let output = """
          1 12345 0:01.00 /sbin/launchd
        340 28672 283:12.34 /System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/FSEvents.framework/Versions/A/Support/fseventsd
        900 100 0:00.10 /usr/bin/not-fseventsd-helper
        """
        let parsed = try XCTUnwrap(FseventsdHealth.parse(psOutput: output, now: Date(timeIntervalSince1970: 0)))
        XCTAssertEqual(parsed.pid, 340)
        XCTAssertEqual(parsed.rssBytes, 28672 * 1024)
        XCTAssertEqual(parsed.cpuSeconds, 283 * 60 + 12.34, accuracy: 0.001)
        XCTAssertEqual(FseventsdHealth.cpuSeconds("1-02:03:04"), 86_400 + 7384)
        XCTAssertNil(FseventsdHealth.cpuSeconds("x:1"))
        XCTAssertNotNil(FseventsdHealth.read(), "fseventsd always runs")
    }

    func testTheGateTripsOnMemoryGrowthAndSustainedCPU() {
        func reading(_ seconds: TimeInterval, rss: Int64, cpu: Double, pid: Int32 = 340) -> FseventsdHealth {
            FseventsdHealth(pid: pid, rssBytes: rss, cpuSeconds: cpu, date: Date(timeIntervalSince1970: seconds))
        }
        var gate = FseventsdGate()
        XCTAssertFalse(gate.update(reading(0, rss: 30_000_000, cpu: 100)))
        XCTAssertFalse(gate.update(reading(60, rss: 31_000_000, cpu: 136)), "0.6 of a core is its normal load")
        XCTAssertTrue(gate.update(reading(120, rss: 31_000_000, cpu: 236)), "1.67 cores over a minute")
        var memory = FseventsdGate()
        XCTAssertFalse(memory.update(reading(0, rss: 100_000_000, cpu: 0)))
        XCTAssertTrue(memory.update(reading(300, rss: 700_000_000, cpu: 1)), "grew 600 MB in 5 minutes")
        var big = FseventsdGate()
        XCTAssertTrue(big.update(reading(0, rss: 1 << 30, cpu: 0)))
        XCTAssertFalse(big.update(reading(10, rss: 20_000_000, cpu: 0, pid: 341)), "a restarted daemon starts over")
    }

    func testTempLocationsResolveTheUsersFolders() throws {
        let locations = TempLocation.standard()
        let temp = try XCTUnwrap(locations.first { $0.id == "user-temp" })
        XCTAssertTrue(FileManager.default.fileExists(atPath: temp.path))
        XCTAssertEqual(temp.cleanTime, "03:35")
        XCTAssertEqual(temp.maxAgeDays, 3)
        let x = try XCTUnwrap(locations.first { $0.id == "user-x" })
        XCTAssertTrue(x.path.hasSuffix("/X"))
        XCTAssertTrue(x.cleanedAtBoot)
        XCTAssertNil(x.cleanTime)
        XCTAssertEqual(locations.first { $0.id == "tmp" }?.cleanTime, "00:00")
    }

    func testCodeSignClonesAreListedAtFixedDepthAndAHardLinkedOneIsCurrent() throws {
        let x = FileManager.default.temporaryDirectory.appendingPathComponent("x-\(UUID())")
        defer { try? FileManager.default.removeItem(at: x) }
        let installed = x.appendingPathComponent("installed-executable")
        try FileManager.default.createDirectory(at: x, withIntermediateDirectories: true)
        try Data("exe".utf8).write(to: installed)
        func clone(_ name: String, linked: Bool) throws {
            let macOS = x.appendingPathComponent("com.example.Browser.code_sign_clone/\(name)/Example Browser.app.bundle/Contents/MacOS")
            try FileManager.default.createDirectory(at: macOS, withIntermediateDirectories: true)
            let executable = macOS.appendingPathComponent("Example Browser")
            if linked {
                try FileManager.default.linkItem(at: installed, to: executable)
            } else {
                try Data("old".utf8).write(to: executable)
            }
        }
        try clone("code_sign_clone.current", linked: true)
        try clone("code_sign_clone.stale", linked: false)
        try FileManager.default.createDirectory(at: x.appendingPathComponent("com.example.Empty.code_sign_clone"),
                                                withIntermediateDirectories: true)
        let clones = CodeSignClone.scan(xFolder: x.path)
        XCTAssertEqual(clones.count, 2)
        XCTAssertEqual(Set(clones.map(\.bundleID)), ["com.example.Browser"])
        XCTAssertEqual(clones.first { $0.path.hasSuffix("current") }?.state, .current)
        XCTAssertEqual(clones.first { $0.path.hasSuffix("stale") }?.state, .stale)
    }
}

// MARK: - Review fixes (2026-10-13)

extension BigFileRadarTests {
    /// H5: `hits` lists only files that are still there at or above the threshold.
    func testHitsDropARemovedAMovedAndAShrunkFile() throws {
        let radar = radar()
        let removed = try write("removed.bin", bytes: 2_000_000)
        let moved = try write("folder/moved.bin", bytes: 2_000_000)
        let shrunk = try write("shrunk.bin", bytes: 2_000_000)
        XCTAssertEqual(radar.processNow(batch([removed, moved, shrunk])).count, 3)
        XCTAssertEqual(Set(radar.hits.map(\.path)), [removed, moved, shrunk])

        try FileManager.default.removeItem(atPath: removed)
        _ = radar.processNow(batch([removed], flags: [.itemRemoved, .itemIsFile]))
        XCTAssertFalse(radar.hits.contains { $0.path == removed }, "a removed file leaves hits")

        let folder = directory.appendingPathComponent("folder").path
        try FileManager.default.moveItem(atPath: folder, toPath: folder + "-trashed")
        _ = radar.processNow(batch([folder], flags: [.itemRenamed, .itemIsDir]))
        XCTAssertFalse(radar.hits.contains { $0.path == moved }, "a file in a moved folder leaves hits")

        try Data(repeating: 0x5A, count: 10_000).write(to: URL(fileURLWithPath: shrunk))
        _ = radar.processNow(batch([shrunk]))
        XCTAssertTrue(radar.hits.isEmpty, "a file below the threshold leaves hits")
    }

    func testRemovalsReachOnRemoveAndAListedFileShowsItsCurrentSize() throws {
        let radar = radar(step: 10_000_000)
        let big = try write("big.raw", bytes: 2_000_000)
        let gone = try write("sub/gone.raw", bytes: 2_000_000)
        _ = radar.processResultNow(batch([big, gone]))
        _ = try write("big.raw", bytes: 600_000, append: true)
        let grownLess = radar.processResultNow(batch([big]))
        XCTAssertTrue(grownLess.found.isEmpty, "less than a step: no new hit")
        XCTAssertGreaterThanOrEqual(radar.hits.first { $0.path == big }?.logicalBytes ?? 0, 2_600_000,
                                    "the listed size follows the file")
        try FileManager.default.removeItem(at: directory.appendingPathComponent("sub"))
        // A directory-granularity event names the parent folder only.
        let result = radar.processResultNow(batch([directory.path], flags: []))
        XCTAssertEqual(result.removed, [gone])
        XCTAssertEqual(radar.hits.map(\.path), [big])
    }

    func testAnIgnoredFolderIsNotListed() throws {
        let radar = radar(ignore: ["*/node_modules/*"])
        _ = try write("app/node_modules/a.bin", bytes: 2_000_000)
        let folder = directory.appendingPathComponent("app/node_modules").path
        XCTAssertTrue(radar.processNow(batch([folder], flags: [.itemModified, .itemIsDir])).isEmpty)
        XCTAssertEqual(radar.folderReads, 0)
        XCTAssertEqual(radar.statCount, 0)
    }
}

extension DiskHistoryStoreTests {
    /// M5: a file it cannot read is unreadable, never an empty history that a later compaction overwrites.
    func testAFileThatCannotBeReadIsNeverOverwritten() async throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appendingPathComponent("samples.ndjson")
        let original = Data("{\"available\":5,\"date\":1791892800}\n".utf8)
        try original.write(to: url)
        try FileManager.default.setAttributes([.posixPermissions: 0o000], ofItemAtPath: url.path)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path) }
        let store = DiskHistoryStore(directory: directory)
        let stored = try await store.append(sample(0, 10_000_000_000))
        XCTAssertFalse(stored)
        guard case .unreadable = await store.health else { return XCTFail("unreadable") }
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        XCTAssertEqual(try Data(contentsOf: url), original)
    }

    func testAFileWithoutOneReadableLineIsUnreadable() async throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appendingPathComponent("samples.ndjson")
        try Data("garbage without newlines".utf8).write(to: url)
        let store = DiskHistoryStore(directory: directory)
        let stored = try await store.append(sample(0, 10_000_000_000))
        XCTAssertFalse(stored)
        XCTAssertEqual(try String(contentsOf: url, encoding: .utf8), "garbage without newlines")
    }

    /// M9: a write cut short does not swallow the next line.
    func testATornLastLineDoesNotSwallowTheNextAppend() async throws {
        let store = DiskHistoryStore(directory: directory)
        _ = try await store.append(sample(0, 10_000_000_000))
        let url = directory.appendingPathComponent("samples.ndjson")
        let handle = try FileHandle(forWritingTo: url)
        try handle.seekToEnd()
        try handle.write(contentsOf: Data("{\"available\":12".utf8))
        try handle.close()
        let reopened = DiskHistoryStore(directory: directory)
        _ = try await reopened.append(sample(600, 8_000_000_000))
        let points = try await DiskHistoryStore(directory: directory).points()
        XCTAssertEqual(points.map(\.available), [10_000_000_000, 8_000_000_000])
    }
}

extension SpaceForecasterTests {
    /// M7: one large copy is not a pace, and the time since the last reading counts.
    func testOneLargeCopyIsLeftOutAndAQuietStretchFadesThePace() throws {
        let points = series(60) { $0 <= 30 ? 50 * self.gb : 30 * self.gb }
        let forecaster = SpaceForecaster(floor: 10 * gb)
        let copied = forecaster.forecast(points)
        XCTAssertEqual(copied.jumpsIgnored, 1)
        XCTAssertNotEqual(copied.verdict, .filling, "a 20 GB copy is not a fill rate")

        let filling = series(60) { 12 * self.gb - Int64($0) * self.gb / 60 }
        XCTAssertEqual(forecaster.forecast(filling).verdict, .filling)
        let now = start.addingTimeInterval(4 * 3600)
        let later = forecaster.forecast(filling, now: now)
        XCTAssertEqual(later.asOf, now)
        XCTAssertNotEqual(later.verdict, .filling, "three quiet hours fade the old pace")
    }
}

