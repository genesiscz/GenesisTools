//
//  GitFailureNotice.swift
//  GenesisKit
//
//  A failed git read where its content would be: the sentence, a button that tries again, and git's raw text behind
//  Details. One shape for the Changes pane, a commit's files and the repository panel.
//

import SwiftUI

public struct GitFailureNotice: View {
    let failure: GitFailure
    let retryLabel: String
    let retry: (() -> Void)?

    public init(_ failure: GitFailure, retryLabel: String = "Try again", retry: (() -> Void)?) {
        self.failure = failure
        self.retryLabel = retryLabel
        self.retry = retry
    }

    public var body: some View {
        NoticePill(
            text: failure.message,
            more: failure.detail,
            tone: .error,
            fixes: retry.map { retry in [.button(retryLabel, symbol: "arrow.clockwise") { retry() }] } ?? []
        )
        .frame(maxWidth: 460)
        .accessibilityIdentifier("git-failure")
    }
}
