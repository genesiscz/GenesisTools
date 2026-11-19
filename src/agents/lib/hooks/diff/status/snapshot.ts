import { type SnapshotModeSettings, type StatusModeModule, unbuiltArm } from "./types";

export const snapshotMode: StatusModeModule<SnapshotModeSettings> = {
    primary: (settings) => unbuiltArm(`snapshot:${settings.driver}`, "snapshot"),
    variants: (settings) => settings.shadowDrivers.map((driver) => unbuiltArm(`snapshot:${driver}`, "snapshot")),
};
