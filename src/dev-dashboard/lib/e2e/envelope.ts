// The E2eEnvelope codec is DEFINED once in the RN-safe contract (Task 0) so the Agent
// and the mobile app can never drift. This Agent-side file just re-exports it, keeping
// the shim/relay's `@app/dev-dashboard/lib/e2e/envelope` import path stable.
export { decodeEnvelope, type E2eEnvelope, encodeEnvelope } from "@app/dev-dashboard/contract/e2e-envelope";
