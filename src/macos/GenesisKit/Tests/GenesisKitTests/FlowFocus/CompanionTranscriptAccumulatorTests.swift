// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground/Genesis/apps/Genesis/Tests/GenesisTests/Companion/CompanionTranscriptAccumulatorTests.swift at 2026-10-08T05:04:08+02:00 at commit hash 7bd89a24c79510fb90ab0c2a0701c1d085f2023e
//
//  CompanionTranscriptAccumulatorTests.swift
//  GenesisTests
//
//  Regression cover for the live 2026-07-24 bug: holding F6, speaking,
//  pausing, then speaking again while STILL holding wiped everything said
//  before the pause (`stt finish chars=0 … results=22`). These exercise the
//  accumulation rules without a microphone.
//

import XCTest
@testable import GenesisKit
#if canImport(Genesis)
@testable import Genesis
#endif

final class CompanionTranscriptAccumulatorTests: XCTestCase {

    func testRevisionsExtendTheLiveUtterance() {
        var acc = CompanionTranscriptAccumulator()
        acc.update("hello")
        acc.update("hello there")
        acc.update("hello there world")
        XCTAssertEqual(acc.text, "hello there world")
    }

    /// The exact reported flow: speak, pause (SFSpeech closes the utterance),
    /// keep holding, speak again.
    func testSecondUtteranceAfterAPauseKeepsTheFirst() {
        var acc = CompanionTranscriptAccumulator()
        acc.update("what is on my screen")
        acc.commit() // silence closed utterance 1
        acc.update("and who wrote it")
        XCTAssertEqual(acc.text, "what is on my screen and who wrote it")
    }

    /// The empty final callback that produced `chars=0` on a 13s hold.
    func testEmptyFinalNeverWipesTheHold() {
        var acc = CompanionTranscriptAccumulator()
        acc.update("summarize this file for me")
        acc.update("")
        acc.commit()
        acc.update("")
        XCTAssertEqual(acc.text, "summarize this file for me")
    }

    /// Within one utterance the recognizer freely rewrites the head as it
    /// gains context — that is a REVISION, not a second utterance. Committing
    /// on a head change duplicated every rewritten phrase (live:
    /// "Produce on See on my screen … Produce see on my screen …").
    func testHeadRewriteReplacesInsteadOfDuplicating() {
        var acc = CompanionTranscriptAccumulator()
        acc.update("Produce on")
        acc.update("Produce on See on my screen")
        acc.update("What do you see on my screen")
        XCTAssertEqual(acc.text, "What do you see on my screen")
    }

    func testCommitIsIdempotentAndTrims() {
        var acc = CompanionTranscriptAccumulator()
        acc.update("  padded words  ")
        acc.commit()
        acc.commit()
        acc.commit()
        XCTAssertEqual(acc.text, "padded words")
    }

    func testResetClearsEverything() {
        var acc = CompanionTranscriptAccumulator()
        acc.update("first")
        acc.commit()
        acc.update("second")
        acc.reset()
        XCTAssertEqual(acc.text, "")
    }

    /// Two utterances only ever come from an explicit task boundary.
    func testOnlyCommitStartsANewUtterance() {
        var acc = CompanionTranscriptAccumulator()
        acc.update("open the pull request")
        acc.commit()
        acc.update("and then merge it")
        XCTAssertEqual(acc.text, "open the pull request and then merge it")
    }

    /// `Locale.current.identifier` on macOS carries preference subtags that
    /// made SFSpeech resolution erratic (`en_US@rg=czzzzz` seen live).
    func testLocaleNormalizationStripsPreferenceSubtags() {
        let normalized = CompanionSpeechRecognizer.normalizedLocale(Locale(identifier: "en_US@rg=czzzzz"))
        XCTAssertEqual(normalized.identifier, "en_US")
    }
}
