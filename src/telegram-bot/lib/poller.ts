import type { TelegramApi } from "./api";
import { dispatch } from "./dispatcher";
import logger from "@app/logger";

export async function startPolling(api: TelegramApi, authorizedChatId: number): Promise<void> {
  await api.deleteWebhook();

  let running = true;
  let offset: number | undefined;

  const shutdown = () => { running = false; };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  logger.info("Bot polling started");

  while (running) {
    try {
      const updates = await api.getUpdates(offset, 30);
      for (const update of updates) {
        offset = update.update_id + 1;
        if (update.message) {
          await dispatch(api, update.message, authorizedChatId);
        }
      }
    } catch (err) {
      logger.error({ err }, "Polling error, backing off 5s");
      await Bun.sleep(5_000);
    }
  }

  logger.info("Bot polling stopped");
}
