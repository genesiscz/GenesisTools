// GenesisTools.app's executable: the parts this build links (Parts.swift), then the host's entry point
// (Host/HostMain.swift).

import GenesisToolsHost

registerLinkedParts()
// The process starts on the main thread; the host and its faces are main-actor code.
MainActor.assumeIsolated { runHost() }
