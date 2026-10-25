//
//  NativeString.swift
//  GenesisKit
//
//  A path that enters a model is made native once, so the model never compares or hashes a bridged string.
//

import Foundation

/// Native string storage for paths shared between filesystem listings and the viewer.
extension String {
    /// The same text in Swift's own contiguous UTF-8 storage. A path from `URL.path` or a Foundation listing is a
    /// bridged `NSString` when it holds a non-ASCII letter (a vault folder named "Účty"); comparing, hashing or
    /// searching one walks it through CoreFoundation a character at a time. Measured 2026-10-15 on 636 vault paths:
    /// finding one 0.42 ms bridged, 0.02 ms native; building a `Set` 1.42 ms against 0.36 ms.
    var nativeUTF8: String {
        var copy = self
        copy.makeContiguousUTF8()
        return copy
    }
}
