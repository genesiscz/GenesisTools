import Foundation
import XCTest
@testable import GenesisKit

final class ClientConfigFileTests: XCTestCase {
    private var directory: URL!
    private var client: URL { directory.appendingPathComponent("client.json") }
    private var lock: URL { directory.appendingPathComponent("client.json.lock") }

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("client-config-\(UUID())", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try FileManager.default.removeItem(at: directory)
    }

    private func stored() throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: client)) as? [String: Any])
    }

    func testReplaceSwapsTheWholeValueSoARemovedNestedKeyGoesAndEverythingElseStays() async throws {
        let original: [String: Any] = [
            "unknown": ["future": "kept"],
            "auth": ["sessionToken": "fixture-session"],
            "app": ["companion": ["toolsBinaryPath": "/fixture/tools"],
                    "posture": ["sensitivity": 3, "slots": ["home": ["pitch": 1], "office": ["pitch": 2]]]],
        ]
        try JSONSerialization.data(withJSONObject: original).write(to: client)
        let file = ClientConfigFile(directory: directory)
        try await file.replaceAppValue(["sensitivity": 4, "slots": ["home": ["pitch": 1]]], forKey: "posture")
        let raw = try stored()
        XCTAssertEqual((raw["unknown"] as? [String: String])?["future"], "kept")
        XCTAssertEqual((raw["auth"] as? [String: String])?["sessionToken"], "fixture-session")
        let app = try XCTUnwrap(raw["app"] as? [String: Any])
        XCTAssertEqual((app["companion"] as? [String: String])?["toolsBinaryPath"], "/fixture/tools")
        let posture = try XCTUnwrap(app["posture"] as? [String: Any])
        XCTAssertEqual(posture["sensitivity"] as? Int, 4)
        let slots = try XCTUnwrap(posture["slots"] as? [String: Any])
        XCTAssertEqual(Set(slots.keys), ["home"], "a deleted slot is gone, which a deep merge cannot do")
        XCTAssertEqual(file.readAppValue("posture").flatMap { ($0 as? [String: Any])?["sensitivity"] as? Int }, 4)
    }

    func testNilRemovesTheKey() async throws {
        try Data(#"{"app":{"disk":{"floor":1},"other":true}}"#.utf8).write(to: client)
        try await ClientConfigFile(directory: directory).replaceAppValue(nil, forKey: "disk")
        let app = try XCTUnwrap(try stored()["app"] as? [String: Any])
        XCTAssertNil(app["disk"])
        XCTAssertEqual(app["other"] as? Bool, true)
    }

    func testAnUnchangedValueIsNotWrittenAgain() async throws {
        let file = ClientConfigFile(directory: directory)
        try await file.replaceAppValue(["floor": 10], forKey: "disk")
        let inode = try FileManager.default.attributesOfItem(atPath: client.path)[.systemFileNumber] as? NSNumber
        let wrote = try await file.mutate { raw in
            raw["app"] = ["disk": ["floor": 10]]
        }
        XCTAssertFalse(wrote)
        XCTAssertEqual(try FileManager.default.attributesOfItem(atPath: client.path)[.systemFileNumber] as? NSNumber, inode,
                       "the same file: no rename happened")
        XCTAssertFalse(FileManager.default.fileExists(atPath: lock.path))
    }

    func testAValueJSONCannotHoldIsRefusedBeforeTheLock() async throws {
        let original = Data(#"{"app":{"keep":1}}"#.utf8)
        try original.write(to: client)
        do {
            try await ClientConfigFile(directory: directory).replaceAppValue(Date(), forKey: "fixtureDate")
            XCTFail("a Date is not JSON")
        } catch {
            XCTAssertEqual((error as NSError).code, 3)
        }
        XCTAssertEqual(try Data(contentsOf: client), original)
        XCTAssertFalse(FileManager.default.fileExists(atPath: lock.path))
    }

    func testAMalformedFileIsLeftIntactAndReadsLenientlyAsEmpty() async throws {
        let broken = Data("{broken".utf8)
        try broken.write(to: client)
        let file = ClientConfigFile(directory: directory)
        XCTAssertTrue(file.readApp().isEmpty)
        do {
            try await file.replaceAppValue(["floor": 1], forKey: "disk")
            XCTFail("a malformed file must not be replaced")
        } catch {
            XCTAssertEqual((error as NSError).domain, NSCocoaErrorDomain)
        }
        XCTAssertEqual(try Data(contentsOf: client), broken)
        XCTAssertFalse(FileManager.default.fileExists(atPath: lock.path))
    }

    func testABareLockOlderThanTheStaleAgeIsReclaimedAndAFreshOneIsNot() async throws {
        // ConfigStore's format: the pid alone, no marker.
        try Data("12345".utf8).write(to: lock)
        try FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSinceNow: -60)], ofItemAtPath: lock.path)
        let file = ClientConfigFile(directory: directory, lockTimeout: 0.5, staleLockAge: 10)
        try await file.replaceAppValue(1, forKey: "fixture")
        XCTAssertEqual((try stored()["app"] as? [String: Any])?["fixture"] as? Int, 1)
        XCTAssertFalse(FileManager.default.fileExists(atPath: lock.path))

        try Data("12345".utf8).write(to: lock)
        let started = Date()
        do {
            try await ClientConfigFile(directory: directory, lockTimeout: 0.2, staleLockAge: 10).replaceAppValue(2, forKey: "fixture")
            XCTFail("a fresh lock of another writer must be waited for")
        } catch {
            XCTAssertEqual((error as NSError).code, 1, "timed out")
        }
        XCTAssertLessThan(Date().timeIntervalSince(started), 2, "the wait has a deadline")
        XCTAssertEqual(try Data(contentsOf: lock), Data("12345".utf8), "the live writer's lock stays")
    }

    func testWithoutAStaleAgeAnOldBareLockIsNeverRemoved() async throws {
        try Data("another writer".utf8).write(to: lock)
        try FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSinceNow: -600)], ofItemAtPath: lock.path)
        do {
            try await ClientConfigFile(directory: directory, lockTimeout: 0.1, staleLockAge: nil).replaceAppValue(1, forKey: "x")
            XCTFail("expected a lock timeout")
        } catch {
            XCTAssertEqual((error as NSError).code, 1)
        }
        XCTAssertEqual(try Data(contentsOf: lock), Data("another writer".utf8))
    }

    func testAMarkerLockOfALiveOwnerIsNeverRemovedByAgeAndADeadOwnersIs() async throws {
        try Data("\(ClientConfigFile.lockMarkerPrefix)\(getppid())\n".utf8).write(to: lock)
        try FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSinceNow: -600)], ofItemAtPath: lock.path)
        do {
            try await ClientConfigFile(directory: directory, lockTimeout: 0.1, staleLockAge: 10).replaceAppValue(1, forKey: "x")
            XCTFail("a live owner keeps its lock however old")
        } catch {
            XCTAssertEqual((error as NSError).code, 1)
        }
        try Data("\(ClientConfigFile.lockMarkerPrefix)99999999\n".utf8).write(to: lock)
        try await ClientConfigFile(directory: directory, lockTimeout: 0.5).replaceAppValue(1, forKey: "x")
        XCTAssertFalse(FileManager.default.fileExists(atPath: lock.path))
    }

    func testTheFileIsOwnerOnlyTheFolderIsCreatedPrivateAndNoTemporaryStays() async throws {
        let nested = directory.appendingPathComponent("fresh")
        try await ClientConfigFile(directory: nested).replaceAppValue(true, forKey: "fixture")
        let file = nested.appendingPathComponent("client.json")
        let mode = try XCTUnwrap(FileManager.default.attributesOfItem(atPath: file.path)[.posixPermissions] as? NSNumber)
        XCTAssertEqual(mode.intValue & 0o777, 0o600)
        let folder = try XCTUnwrap(FileManager.default.attributesOfItem(atPath: nested.path)[.posixPermissions] as? NSNumber)
        XCTAssertEqual(folder.intValue & 0o777, 0o700)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: nested.path), ["client.json"])
    }

    func testALegacyConfigIsReadAndOnlyItsClientKeysAreCarriedOver() async throws {
        let legacy = Data(#"{"serverSecret":"excluded","app":{"other":7},"auth":{"sessionToken":"s","privateKey":"excluded"}}"#.utf8)
        try legacy.write(to: directory.appendingPathComponent("config.json"))
        let file = ClientConfigFile(directory: directory)
        XCTAssertEqual(file.readAppValue("other") as? Int, 7)
        try await file.replaceAppValue(1, forKey: "disk")
        let raw = try stored()
        XCTAssertNil(raw["serverSecret"])
        XCTAssertEqual(raw["auth"] as? [String: String], ["sessionToken": "s"])
        XCTAssertEqual((raw["app"] as? [String: Any])?["other"] as? Int, 7)
        XCTAssertEqual(try Data(contentsOf: directory.appendingPathComponent("config.json")), legacy, "legacy file untouched")
    }

    func testConcurrentWritersInterleaveUnderTheLockWithoutLosingAWrite() async throws {
        let file = ClientConfigFile(directory: directory)
        try await withThrowingTaskGroup(of: Void.self) { group in
            for _ in 0 ..< 2 {
                group.addTask {
                    for _ in 0 ..< 15 {
                        try await file.mutate { raw in
                            var app = raw["app"] as? [String: Any] ?? [:]
                            app["count"] = (app["count"] as? Int ?? 0) + 1
                            raw["app"] = app
                        }
                    }
                }
            }
            try await group.waitForAll()
        }
        XCTAssertEqual(file.readAppValue("count") as? Int, 30)
    }
}

extension ClientConfigFileTests {
    /// Low 1: a malformed client.json reads as empty; only a missing one falls back to the legacy config.json.
    func testAMalformedClientFileDoesNotFallBackToTheLegacyFile() throws {
        try Data(#"{"app":{"legacy":1}}"#.utf8).write(to: directory.appendingPathComponent("config.json"))
        try Data("{ not json".utf8).write(to: directory.appendingPathComponent("client.json"))
        XCTAssertTrue(ClientConfigFile(directory: directory).read().isEmpty)
    }
}
