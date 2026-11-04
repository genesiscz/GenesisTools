import { listSimulators, type SimDevice } from "@genesiscz/utils/mobile/simulator";

/**
 * The simulator a command works on. An explicit udid wins; otherwise exactly one booted simulator must exist, because
 * picking one of several would drive (and maybe reboot) a simulator another session is using.
 */
export async function pickSimulator(udid?: string, options: { booted?: boolean } = {}): Promise<SimDevice> {
    const devices = await listSimulators();

    if (udid) {
        const device = devices.find((candidate) => candidate.udid === udid);

        if (!device) {
            throw new Error(`no simulator with udid ${udid}; list them with: xcrun simctl list devices`);
        }

        if (options.booted !== false && device.state !== "Booted") {
            throw new Error(
                `simulator ${device.name} (${udid}) is ${device.state}; boot it: xcrun simctl boot ${udid}`
            );
        }

        return device;
    }

    const booted = devices.filter((device) => device.state === "Booted");

    if (booted.length === 1) {
        return booted[0];
    }

    if (booted.length === 0) {
        throw new Error("no simulator is booted; boot one (xcrun simctl boot <udid>) or pass --udid");
    }

    const names = booted.map((device) => `${device.name} ${device.udid}`).join(", ");
    throw new Error(`${booted.length} simulators are booted (${names}); pass --udid so another session's is not used`);
}
