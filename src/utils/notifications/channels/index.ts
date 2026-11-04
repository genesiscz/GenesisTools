import type { ChannelTable } from "../types";
import { phoneChannel } from "./phone";
import { sayChannel } from "./say";
import { systemChannel } from "./system";
import { telegramChannel } from "./telegram";
import { webhookChannel } from "./webhook";

/**
 * Every notification channel, one entry each. A new channel is one entry here plus its config type in `ChannelConfigs`;
 * the dispatcher, Monitor, the notify wizard and the shops channels read this table.
 */
export const CHANNELS: ChannelTable = {
    system: systemChannel,
    telegram: telegramChannel,
    webhook: webhookChannel,
    say: sayChannel,
    phone: phoneChannel,
};

/** The channel names in their display order. */
export const CHANNEL_NAMES = Object.keys(CHANNELS) as (keyof ChannelTable)[];
