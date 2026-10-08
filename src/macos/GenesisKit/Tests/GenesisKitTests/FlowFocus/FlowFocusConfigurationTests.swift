import Foundation
import XCTest
@testable import GenesisKit

final class FlowFocusConfigurationTests: XCTestCase {
    private var directory: URL!
    private var client: URL { directory.appendingPathComponent("client.json") }

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("flow-focus-config-\(UUID())", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try FileManager.default.removeItem(at: directory)
    }

    @MainActor
    func testToolsTransformKeepsInputPrivateAndUsesTheSelectedAccountReference() async throws {
        let config = FlowFocusConfiguration(directory: directory)
        config.allowsWrites = true
        let adapter = FlowTransformTools(bridge: ToolsBridge(binaryPath: "/missing/fixture-tools"), configuration: config)
        adapter.save(accountID: "acc_work", model: "fixture-writer")
        await config.flush()
        var inputURL: URL?
        adapter.runCommand = { args, timeout in
            XCTAssertEqual(Array(args.prefix(2)), ["transforms", "run"])
            XCTAssertTrue(args.contains("@account/acc_work:fixture-writer"))
            XCTAssertFalse(args.contains("Private dictated fixture"))
            XCTAssertEqual(timeout, 35)
            let index = try XCTUnwrap(args.firstIndex(of: "--input"))
            let url = URL(fileURLWithPath: args[index + 1])
            inputURL = url
            let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
            let parent = try FileManager.default.attributesOfItem(atPath: url.deletingLastPathComponent().path)
            XCTAssertEqual((attributes[.posixPermissions] as? NSNumber)?.intValue, 0o600)
            XCTAssertEqual((parent[.posixPermissions] as? NSNumber)?.intValue, 0o700)
            let request = try JSONDecoder().decode(FlowTransformRequest.self, from: Data(contentsOf: url))
            XCTAssertEqual(request.text, "Private dictated fixture")
            return ToolsRunResult(stdout: #"{"text":"Rewritten fixture"}"#, stderr: "", exitCode: 0, wallMs: 1)
        }
        let result = try await adapter.run(.init(systemPrompt: "Rewrite faithfully.", text: "Private dictated fixture"))
        XCTAssertEqual(result, "Rewritten fixture")
        XCTAssertFalse(FileManager.default.fileExists(atPath: try XCTUnwrap(inputURL).path))
        let saved = try String(contentsOf: client, encoding: .utf8)
        let persisted = FlowFocusConfiguration(directory: directory)
        XCTAssertEqual((persisted.app["flowTransforms"] as? [String: String])?["modelRef"], "@account/acc_work:fixture-writer")
        XCTAssertFalse(saved.contains("Private dictated fixture"))
        adapter.runCommand = { args, _ in
            let index = try XCTUnwrap(args.firstIndex(of: "--input"))
            inputURL = URL(fileURLWithPath: args[index + 1])
            throw CocoaError(.fileReadUnknown)
        }
        do {
            _ = try await adapter.run(.init(systemPrompt: "Rewrite.", text: "Fixture"))
            XCTFail("expected execution failure")
        } catch { XCTAssertFalse(FileManager.default.fileExists(atPath: try XCTUnwrap(inputURL).path)) }
    }

    @MainActor
    func testToolsTransformMetadataAndMissingSelectionNeverExecuteARewrite() async throws {
        let config = FlowFocusConfiguration(directory: directory)
        let adapter = FlowTransformTools(bridge: ToolsBridge(binaryPath: "/missing/fixture-tools"), configuration: config)
        var calls = 0
        adapter.runCommand = { args, _ in
            calls += 1
            XCTAssertEqual(args, ["transforms", "configuration", "--json"])
            return ToolsRunResult(stdout: #"{"providers":[]}"#, stderr: "", exitCode: 0, wallMs: 1)
        }
        let choices = try await adapter.choices()
        XCTAssertTrue(choices.providers.isEmpty)
        do {
            _ = try await adapter.run(.init(systemPrompt: "Rewrite.", text: "Fixture"))
            XCTFail("missing account must not execute")
        } catch { XCTAssertTrue(error.localizedDescription.contains("Choose an AI account")) }
        XCTAssertEqual(calls, 1)
        XCTAssertFalse(FileManager.default.fileExists(atPath: client.path))
    }

    @MainActor
    func testFailedAsyncWriteRollsBackOptimisticStateAndPublishesTheError() async throws {
        try Data("{\"app\":{\"focusWhileListening\":true}}".utf8).write(to: client)
        let config = FlowFocusConfiguration(directory: directory)
        config.allowsWrites = true
        let corrupt = Data("{corrupt-after-loading".utf8)
        try corrupt.write(to: client)
        let failure = expectation(description: "visible persistence failure")
        config.onFailure = { _ in failure.fulfill() }
        config.setAppValue(false, forKey: "focusWhileListening")
        XCTAssertEqual(config.app["focusWhileListening"] as? Bool, false, "optimistic value while the write is pending")
        await fulfillment(of: [failure], timeout: 2)
        XCTAssertEqual(config.app["focusWhileListening"] as? Bool, true, "failed value rolls back")
        XCTAssertNotNil(config.lastError)
        XCTAssertEqual(try Data(contentsOf: client), corrupt)
    }

    func testNormalWriteMergesFreshUnknownTopLevelAndNestedKeys() throws {
        let original: [String: Any] = [
            "unknown": ["future": "preserved"],
            "app": ["otherFeature": true, "focus": ["custom": 42, "timer": ["futureTimer": "kept", "flowSec": 1500]]],
        ]
        try JSONSerialization.data(withJSONObject: original).write(to: client)
        let patch = try JSONSerialization.data(withJSONObject: ["focus": ["timer": ["flowSec": 1800]]])
        try FlowFocusConfiguration.persist(patch, directory: directory)
        let result = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: client)) as? [String: Any])
        XCTAssertEqual((result["unknown"] as? [String: String])?["future"], "preserved")
        let app = try XCTUnwrap(result["app"] as? [String: Any])
        XCTAssertEqual(app["otherFeature"] as? Bool, true)
        let focus = try XCTUnwrap(app["focus"] as? [String: Any])
        XCTAssertEqual(focus["custom"] as? Int, 42)
        let timer = try XCTUnwrap(focus["timer"] as? [String: Any])
        XCTAssertEqual(timer["futureTimer"] as? String, "kept")
        XCTAssertEqual(timer["flowSec"] as? Int, 1800)
    }

    func testCorruptClientIsPreservedRatherThanReplacedWithLegacyOrEmptyData() throws {
        let original = Data("{broken client data\n".utf8)
        try original.write(to: client)
        try Data("{\"app\":{\"legacy\":true}}".utf8)
            .write(to: directory.appendingPathComponent("config.json"))
        XCTAssertThrowsError(try FlowFocusConfiguration.persist(Data("{\"focus\":{}}".utf8), directory: directory))
        XCTAssertEqual(try Data(contentsOf: client), original)
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.appendingPathComponent("client.json.lock").path))
    }

    func testAValidJSONNonObjectIsNotSilentlyReplaced() throws {
        let original = Data("[1,2,3]".utf8)
        try original.write(to: client)
        XCTAssertThrowsError(try FlowFocusConfiguration.persist(Data("{}".utf8), directory: directory))
        XCTAssertEqual(try Data(contentsOf: client), original)
    }

    func testUnreadableClientPathIsPreserved() throws {
        try FileManager.default.createDirectory(at: client, withIntermediateDirectories: true)
        let marker = client.appendingPathComponent("keep.txt")
        try Data("preserve".utf8).write(to: marker)
        XCTAssertThrowsError(try FlowFocusConfiguration.persist(Data("{}".utf8), directory: directory))
        XCTAssertEqual(try Data(contentsOf: marker), Data("preserve".utf8))
    }

    func testMissingClientCanBeCreatedAndLegacyKeysSurvive() throws {
        let legacy = Data("{\"serverSecret\":\"excluded\",\"app\":{\"other\":7},\"auth\":{\"sessionToken\":\"fixture-session\",\"privateKey\":\"excluded\"}}".utf8)
        try legacy.write(to: directory.appendingPathComponent("config.json"))
        try FlowFocusConfiguration.persist(Data("{\"focus\":{\"captureEnabled\":false}}".utf8), directory: directory)
        let raw = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: client)) as? [String: Any])
        XCTAssertNil(raw["serverSecret"], "legacy server-owned keys do not enter client.json")
        XCTAssertEqual(raw["auth"] as? [String: String], ["sessionToken": "fixture-session"])
        XCTAssertEqual((raw["app"] as? [String: Any])?["other"] as? Int, 7)
        XCTAssertEqual(try Data(contentsOf: directory.appendingPathComponent("config.json")), legacy)
    }

    func testCustomBackendWithoutAValidURLStaysUnconfigured() {
        for raw in ["", " ui ", "file:///not-a-backend"] {
            let config = FlowFocusConfiguration.resolveTransformConfiguration(app: [
                "companion": ["aiBackend": ["kind": "custom", "baseURL": raw, "model": "work/provider/model"]],
            ])
            XCTAssertEqual(config.baseURL, "", "custom never silently falls back to a local backend")
            XCTAssertEqual(config.model, "work/provider/model")
        }
    }

    func testBackendKindsAndFeatureOverrideMatchTheOriginalResolution() {
        let openRouter = FlowFocusConfiguration.resolveTransformConfiguration(app: [
            "companion": ["aiBackend": ["kind": "openRouter", "baseURL": "invalid", "model": "work/provider/model"]],
            "ai": ["features": ["flow": ["model": ""]]],
        ])
        XCTAssertEqual(openRouter.baseURL, "https://openrouter.ai/api/v1")
        XCTAssertEqual(openRouter.model, "work/provider/model", "an empty feature override falls back")
        let unknown = FlowFocusConfiguration.resolveTransformConfiguration(app: [
            "companion": ["aiBackend": ["kind": "future-kind"]],
        ])
        XCTAssertEqual(unknown.baseURL, "http://127.0.0.1:8317/v1", "unknown kinds match the original aiProxy fallback")
        XCTAssertEqual(unknown.model, "", "the shared kit never invents a personal account")
        let explicit = FlowFocusConfiguration.resolveTransformConfiguration(app: [
            "companion": ["aiBackend": ["kind": "custom", "baseURL": " https://example.com/v1/ ", "model": "work/provider/default"]],
            "ai": ["features": ["flow": ["model": "work/provider/selected"]]],
        ])
        XCTAssertEqual(explicit.baseURL, "https://example.com/v1")
        XCTAssertEqual(explicit.model, "work/provider/selected")
    }

    @MainActor
    func testTheTransformRequestUsesTheHostsExistingResolver() async throws {
        let previous = FlowFocusHost.shared.transformConfiguration
        defer { FlowFocusHost.shared.transformConfiguration = previous }
        FlowFocusHost.shared.transformConfiguration = {
            FlowTransformConfiguration(baseURL: "https://flow-fixture.invalid/v1",
                                       model: "work/provider/existing-selection", token: "fixture-token")
        }
        FlowTransformFixtureProtocol.reset()
        URLProtocol.registerClass(FlowTransformFixtureProtocol.self)
        defer { URLProtocol.unregisterClass(FlowTransformFixtureProtocol.self) }
        let result = try await FlowTransformRunner.run(.init(name: "Fixture", prompt: "Preserve meaning"),
                                                       on: "Original words", timeout: 1)
        XCTAssertEqual(result, "Kept words")
        let request = try XCTUnwrap(FlowTransformFixtureProtocol.request())
        XCTAssertEqual(request.url?.absoluteString, "https://flow-fixture.invalid/v1/chat/completions")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer fixture-token")
        let body = try XCTUnwrap(request.httpBody)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(json["model"] as? String, "work/provider/existing-selection")
    }

    func testAnOldLockIsNotRemovedBasedOnlyOnItsModificationTime() throws {
        let lock = directory.appendingPathComponent("client.json.lock")
        let contents = Data("another writer".utf8)
        try contents.write(to: lock)
        try FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSinceNow: -60)], ofItemAtPath: lock.path)
        let before = try FileManager.default.attributesOfItem(atPath: lock.path)[.systemFileNumber] as? NSNumber
        XCTAssertThrowsError(try FlowFocusConfiguration.persist(Data("{}".utf8), directory: directory, lockTimeout: 0.1))
        XCTAssertEqual(try Data(contentsOf: lock), contents)
        XCTAssertEqual(try FileManager.default.attributesOfItem(atPath: lock.path)[.systemFileNumber] as? NSNumber, before)
        XCTAssertFalse(FileManager.default.fileExists(atPath: client.path))
    }
}

private final class FlowTransformFixtureProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    private static var captured: URLRequest?

    static func reset() { lock.lock(); defer { lock.unlock() }; captured = nil }
    static func request() -> URLRequest? { lock.lock(); defer { lock.unlock() }; return captured }

    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "flow-fixture.invalid" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        var capturedRequest = request
        if capturedRequest.httpBody == nil, let stream = request.httpBodyStream {
            stream.open()
            defer { stream.close() }
            var body = Data()
            var buffer = [UInt8](repeating: 0, count: 4096)
            while body.count < 128 * 1024 {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                body.append(contentsOf: buffer.prefix(count))
            }
            capturedRequest.httpBody = body
        }
        Self.lock.lock()
        Self.captured = capturedRequest
        Self.lock.unlock()
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data("{\"choices\":[{\"message\":{\"content\":\"Kept words\"}}]}".utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
