import XCTest
@testable import GenesisKit

/// Every gate writes one line to the shared trail (Martin, 2026-10-16: "I want all permission gates to be audited").
final class GateAuditTests: XCTestCase {
    func testCredentialRedactionCoversArgumentsPurposesAndFullFactHelp() throws {
        let token = "fixture-secret-never-real"
        for flag in ["--token", "--api-key", "--key", "--password", "--secret"] {
            for args in [[flag, token], ["\(flag)=\(token)"]] {
                XCTAssertFalse(GateCredentialRedactor.arguments(args).joined(separator: " ").contains(token))
                XCTAssertFalse(GateCredentialRedactor.text("tools claude " + args.joined(separator: " ")).contains(token))
            }
        }
        XCTAssertEqual(GateCredentialRedactor.arguments(["tools", "wakeup", "daemon", "register", "-t", token]).last, "[REDACTED]")
        XCTAssertEqual(GateCredentialRedactor.arguments(["bun", "/repo/src/wakeup/index.ts", "daemon", "register", "-t=\(token)"]).last, "-t=[REDACTED]")
        XCTAssertEqual(GateCredentialRedactor.arguments(["tools", "claude", "tail", "-t", "5"]).last, "5")
        let command = "tools claude --token=\(token)"
        let shown = GateAudit.shown(title: "Approve", purpose: command,
                                    facts: [ApprovalFact("Command", "short", help: command)], warning: nil)
        let data = try JSONSerialization.data(withJSONObject: shown)
        XCTAssertFalse(String(decoding: data, as: UTF8.self).contains(token))
    }

    func testAuditHeaderCredentialsAreRedactedWhileSafeHeadersRemain() throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("gate-headers-\(UUID().uuidString)").path
        setenv("GENESIS_TOOLS_HOME", home, 1)
        defer { unsetenv("GENESIS_TOOLS_HOME"); try? FileManager.default.removeItem(atPath: home) }
        let token = "fixture-header-secret-never-real"
        let headers = [
            ("Authorization: Bearer {token}", "Authorization: Bearer [REDACTED]"),
            ("authorization:Basic {token}", "authorization:Basic [REDACTED]"),
            ("Proxy-Authorization: Basic {token}", "Proxy-Authorization: Basic [REDACTED]"),
            ("pRoXy-AuThOrIzAtIoN:Bearer {token}", "pRoXy-AuThOrIzAtIoN:Bearer [REDACTED]"),
            ("Authorization:{token}", "Authorization:[REDACTED]"),
            ("X-Api-Key:{token}", "X-Api-Key:[REDACTED]"),
            ("x-aUtH-tOkEn: {token}", "x-aUtH-tOkEn: [REDACTED]"),
            ("X-Client-Secret: {token}", "X-Client-Secret: [REDACTED]"),
            ("Cookie:session={token}; other={token}", "Cookie:[REDACTED]"),
            ("Set-Cookie: session={token}; Path=/", "Set-Cookie: [REDACTED]"),
        ]
        let argv = ["curl"] + headers.flatMap { ["--header", $0.0.replacingOccurrences(of: "{token}", with: token)] }
            + ["--header", "Accept: application/json", "https://api.example.test/deploy"]
        let command = argv.map { "\"\($0)\"" }.joined(separator: " ")
        GateAudit.write(gate: "link-command", event: "prompted",
                        ["argv": argv, "shown": ["facts": [["label": "Command", "help": command],
                                                           ["label": "Unquoted command", "help": argv.joined(separator: " ")]]]])
        let text = try String(contentsOfFile: GateAudit.path, encoding: .utf8)
        XCTAssertFalse(text.contains(token))
        // JSONSerialization writes "/" as "\/", so the safe header is checked in the parsed entry, not the raw line.
        let entry = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
        let written = try XCTUnwrap(entry["argv"] as? [String])
        XCTAssertTrue(written.contains("Accept: application/json"))
        for (_, expected) in headers { XCTAssertTrue(written.contains(expected), expected) }
        let shown = try XCTUnwrap(entry["shown"] as? [String: Any])
        let facts = try XCTUnwrap(shown["facts"] as? [[String: String]])
        XCTAssertEqual(facts.count, 2)
        for fact in facts {
            let help = try XCTUnwrap(fact["help"])
            XCTAssertTrue(help.contains("Accept: application/json"))
            XCTAssertTrue(help.contains("Authorization: Bearer [REDACTED]"))
        }
    }

    func testQuotedHeaderValuesAreRedactedInAccountCommandsAndShownFacts() throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("gate-quoted-headers-\(UUID().uuidString)").path
        setenv("GENESIS_TOOLS_HOME", home, 1)
        defer { unsetenv("GENESIS_TOOLS_HOME"); try? FileManager.default.removeItem(atPath: home) }
        let cookie = "fixture-cookie"
        let bearer = "fixture-bearer"
        for header in ["Cookie: session=\"\(cookie)\"", "Cookie: session='\(cookie)'", "X-Api-Key: \"\(cookie)\"",
                       "Cookie: session=\"prefix --header \(cookie)\"", "Cookie: session=\"prefix Accept: \(cookie)\"",
                       "Cookie: session= \" --header \(cookie)\""] {
            let argv = ["curl", "--header", header, "--header", "Authorization: Bearer \(bearer)",
                        "--header", "Accept: application/json", "https://api.example.test/deploy"]
            let original = argv
            let command = String((["bun", "/fixture/client.ts"] + Array(argv.dropFirst())).joined(separator: " ").prefix(200))
            let shown = GateAudit.shown(title: "Account approval", purpose: "Read account", facts: [
                ApprovalFact("Quoted command", argv.map { "\"\($0)\"" }.joined(separator: " ")),
                ApprovalFact("Unquoted command", argv.joined(separator: " ")),
                ApprovalFact("Mixed quoted command", "curl -H \"Cookie: session='\(cookie)'\" --header Authorization: Bearer \(bearer) --header Accept: application/json"),
            ], warning: nil)
            GateAudit.write(gate: "ai-account", event: "prompted", ["argv": argv, "client": ["command": command],
                "command": command, "shown": shown,
                "ambiguous": "bun --header Cookie: session=\"\(cookie) --header Accept: application/json"])
            let text = try String(contentsOfFile: GateAudit.path, encoding: .utf8)
            XCTAssertFalse(text.contains(cookie))
            XCTAssertFalse(text.contains(bearer))
            let line = try XCTUnwrap(text.split(separator: "\n").last)
            let entry = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any])
            let written = try XCTUnwrap(entry["argv"] as? [String])
            XCTAssertTrue(written.contains("Accept: application/json"))
            let client = try XCTUnwrap(entry["client"] as? [String: String])
            let savedShown = try XCTUnwrap(entry["shown"] as? [String: Any])
            let facts = try XCTUnwrap(savedShown["facts"] as? [[String: String]])
            XCTAssertEqual(facts.count, 3)
            let commands = [try XCTUnwrap(client["command"]), try XCTUnwrap(entry["command"] as? String)]
                + facts.compactMap { $0["value"] }
            for saved in commands {
                XCTAssertFalse(saved.contains(cookie))
                XCTAssertFalse(saved.contains(bearer))
                XCTAssertTrue(saved.contains("Accept: application/json"))
                XCTAssertTrue(saved.contains("Authorization: Bearer [REDACTED]"))
            }
            XCTAssertTrue((entry["ambiguous"] as? String)?.contains("[REDACTED]") == true)
            XCTAssertEqual(argv, original)
        }
    }

    func testQuotedShellHeaderBoundariesAndEqualsFlags() throws {
        let secret = "fixture-cookie-r5"
        let safe = "Accept: application/json"
        var commands = [
            "curl -H \"Cookie: session=\(secret)\" -H \"\(safe)\"",
            "curl -H \"Cookie: session=\(secret)\" -H \"Authorization: Bearer \(secret)\" -H \"\(safe)\"",
            "curl -H \"Cookie: session='\(secret)'\" -H \"\(safe)\"",
            "curl --header Cookie: session=\"prefix --header \(secret)\" --header \(safe)",
        ]
        for flag in ["--header", "-H"] {
            for header in ["Authorization: Bearer \(secret)", "Proxy-Authorization: Basic \(secret)",
                           "Cookie: session='\(secret)'", "X-Api-Key:\(secret)"] {
                let argv = ["wget", "\(flag)=\(header)", "\(flag)=\(safe)"]
                let original = argv
                let sanitized = GateCredentialRedactor.arguments(argv).joined(separator: " ")
                XCTAssertFalse(sanitized.contains(secret))
                XCTAssertTrue(sanitized.contains(safe))
                XCTAssertEqual(argv, original)
                commands += [argv.joined(separator: " "), argv.map { "\"\($0)\"" }.joined(separator: " ")]
            }
        }
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("gate-r5-\(UUID().uuidString)").path
        setenv("GENESIS_TOOLS_HOME", home, 1)
        defer { unsetenv("GENESIS_TOOLS_HOME"); try? FileManager.default.removeItem(atPath: home) }
        for command in commands {
            GateAudit.write(gate: "ai-account", event: "prompted", ["command": command])
            let lines = try String(contentsOfFile: GateAudit.path, encoding: .utf8).split(separator: "\n")
            let line = try XCTUnwrap(lines.last)
            let entry = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any])
            let saved = try XCTUnwrap(entry["command"] as? String)
            XCTAssertFalse(saved.contains(secret), command)
            XCTAssertTrue(saved.contains(safe), command)
            if command.contains("Authorization: Bearer") {
                XCTAssertTrue(saved.contains("Authorization: Bearer [REDACTED]"), command)
            }
        }
    }

    func testCredentialFlagValuesConsumeEscapedQuotesAndMalformedRemainders() throws {
        let secret = "fixture-secret-suffix-r6"
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("gate-flags-r6-\(UUID().uuidString)").path
        setenv("GENESIS_TOOLS_HOME", home, 1)
        defer { unsetenv("GENESIS_TOOLS_HOME"); try? FileManager.default.removeItem(atPath: home) }
        for flag in ["--token", "--api-key", "--key", "--password", "--secret"] {
            for separator in [" ", "="] {
                for quote in ["\"", "'"] {
                    let value = [quote, "prefix\\", quote, secret, quote].joined()
                    let input = ["tools claude", flag + separator + value, "--format json"].joined(separator: " ")
                    let expected = ["tools claude", flag + separator + "[REDACTED]", "--format json"].joined(separator: " ")
                    XCTAssertEqual(GateCredentialRedactor.text(input), expected)
                    let unfinished = ["tools claude", flag + separator + String(value.dropLast()), "--format json\\"].joined(separator: " ")
                    XCTAssertEqual(GateCredentialRedactor.text(unfinished),
                                   ["tools claude", flag + separator + "[REDACTED]"].joined(separator: " "))
                    GateAudit.write(gate: "vault", event: "prompted", ["command": input, "shown": [["help": input]]])
                    let text = try String(contentsOfFile: GateAudit.path, encoding: .utf8)
                    XCTAssertFalse(text.contains(secret))
                    let line = try XCTUnwrap(text.split(separator: "\n").last)
                    let entry = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any])
                    XCTAssertEqual(entry["command"] as? String, expected)
                    let shown = try XCTUnwrap(entry["shown"] as? [[String: String]])
                    XCTAssertEqual(shown.first?["help"], expected)
                }
            }
        }
        let relay = ["tools wakeup daemon register -t \"prefix\\\"", secret, "\" --format json"].joined()
        XCTAssertEqual(GateCredentialRedactor.text(relay), "tools wakeup daemon register -t [REDACTED] --format json")
        XCTAssertEqual(GateCredentialRedactor.text("tools claude tail -t \"safe\\\"value\""),
                       "tools claude tail -t \"safe\\\"value\"")
    }

    func testHeaderNewlinesUseCodeUnitsAndLongRunsAreLinear() {
        let safe = "Accept: application/json"
        for newline in ["\r", "\n", "\r\n"] {
            XCTAssertEqual(GateCredentialRedactor.text("Cookie: session=🔒fixture-cookie-r5\(newline)\(safe)"),
                           "Cookie: [REDACTED]\(newline)\(safe)")
        }
        let started = Date()
        for value in ["x" + String(repeating: " ", count: 131_072) + "!", String(repeating: "\"x\"", count: 43_691)] {
            XCTAssertEqual(GateCredentialRedactor.text("curl --header Cookie: \(value)"), "curl --header Cookie: [REDACTED]")
        }
        XCTAssertLessThan(Date().timeIntervalSince(started), 2)
    }

    func testAuditURLsRedactUserinfoQueryCredentialsAndEncodedPrompts() throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("gate-url-\(UUID().uuidString)").path
        setenv("GENESIS_TOOLS_HOME", home, 1)
        defer { unsetenv("GENESIS_TOOLS_HOME"); try? FileManager.default.removeItem(atPath: home) }
        let token = "fixture'url-secret"
        var link = URLComponents(string: "https://example.com/run")!
        link.user = "fixture-user"
        link.password = token
        link.queryItems = [URLQueryItem(name: "token", value: token), URLQueryItem(name: "api_key", value: token),
                           URLQueryItem(name: "prompt", value: "tools claude --token \(token)"), URLQueryItem(name: "safe", value: "kept")]
        let url = try XCTUnwrap(link.string)
        var nested = URLComponents(string: "https://example.com/open")!
        nested.queryItems = [URLQueryItem(name: "next", value: url)]
        var callback = URLComponents(string: "genesis://oauth/callback")!
        var fragment = URLComponents()
        fragment.queryItems = [URLQueryItem(name: "access_token", value: token), URLQueryItem(name: "state", value: "kept-state")]
        callback.percentEncodedFragment = fragment.percentEncodedQuery
        GateAudit.write(gate: "link-command", event: "denied",
                        ["link": url, "url": try XCTUnwrap(nested.string), "open": [url, try XCTUnwrap(callback.string)]])
        let text = try String(contentsOfFile: GateAudit.path, encoding: .utf8)
        XCTAssertFalse(text.contains(token))
        XCTAssertFalse(text.contains("fixture-user"))
        XCTAssertFalse(text.contains("url-secret"))
        XCTAssertTrue(text.contains("safe=kept"))
        XCTAssertTrue(text.contains("state=kept-state"))
        XCTAssertTrue(text.contains("example.com"))
        XCTAssertTrue(text.contains("REDACTED"))
    }

    func testConcurrentProcessesAppendWithoutOverwritingDecisions() throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("gate-append-\(UUID().uuidString)").path
        setenv("GENESIS_TOOLS_HOME", home, 1)
        defer { unsetenv("GENESIS_TOOLS_HOME"); try? FileManager.default.removeItem(atPath: home) }
        let path = GateAudit.path
        try FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        let writers = (0..<4).map { index -> Process in
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/bin/sh")
            process.arguments = ["-c", #"i=0; while [ "$i" -lt 200 ]; do printf '{"external":%s,"i":%s}\n' "$1" "$i" >> "$2"; i=$((i+1)); done"#, "audit-writer", "\(index)", path]
            return process
        }
        let completed = expectation(description: "external audit writers finished")
        completed.expectedFulfillmentCount = writers.count
        for writer in writers {
            writer.terminationHandler = { _ in completed.fulfill() }
            try writer.run()
        }
        for index in 0..<200 { GateAudit.write(gate: "test", event: "allowed", ["i": index]) }
        wait(for: [completed], timeout: 10)
        for writer in writers { XCTAssertEqual(writer.terminationStatus, 0) }
        let lines = try String(contentsOfFile: path, encoding: .utf8).split(separator: "\n")
        XCTAssertEqual(lines.count, 1_000)
        for line in lines { XCTAssertNoThrow(try JSONSerialization.jsonObject(with: Data(line.utf8))) }
    }

    func testALineCarriesTheGateTheEventTheWriterAndWhatTheWindowShowed() throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("gate-audit-\(UUID().uuidString)").path
        setenv("GENESIS_TOOLS_HOME", home, 1)
        defer {
            unsetenv("GENESIS_TOOLS_HOME")
            try? FileManager.default.removeItem(atPath: home)
        }

        let shown = GateAudit.shown(title: "“x” wants the vault key", purpose: "Why.",
                                    facts: [ApprovalFact("Folder", "~/work", help: "/Users/x/work")],
                                    warning: "Extra code may be loaded.", onceOnly: "extra code may be loaded")
        GateAudit.write(gate: "vault", event: "prompted", ["shown": shown, "optional": Optional<String>.none as Any])

        let path = GateAudit.path
        XCTAssertTrue(path.hasPrefix(home))
        let text = try String(contentsOfFile: path, encoding: .utf8)
        let line = try XCTUnwrap(text.split(separator: "\n").last)
        let entry = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any])
        XCTAssertEqual(entry["gate"] as? String, "vault")
        XCTAssertEqual(entry["event"] as? String, "prompted")
        XCTAssertNotNil(entry["writer"])
        let written = try XCTUnwrap(entry["shown"] as? [String: Any])
        XCTAssertEqual(written["warning"] as? String, "Extra code may be loaded.")
        XCTAssertEqual((written["facts"] as? [[String: String]])?.first?["value"], "/Users/x/work")
        let mode = try XCTUnwrap(FileManager.default.attributesOfItem(atPath: path)[.posixPermissions] as? Int)
        XCTAssertEqual(mode & 0o777, 0o600)
    }
}
