import Foundation

// Minimal stand-ins for GenesisAIMonitorKit types that the stolen files mention but the hub does
// not use (usage quotas, scored accounts). They keep Hub/Stolen/* verbatim so `steal-code
// --reconcile` can three-way merge them later. Replace a shim with a real steal if the hub starts
// showing quotas.


/// Referenced by SessionListClient.decodeScored, which the hub never calls.
public struct ScoredUsageEnvelope: Decodable {}
