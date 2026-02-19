import type { TelegramApiResponse, TelegramUser, TelegramMessage, TelegramUpdate, SendMessageParams } from "./types";

const BASE_URL = "https://api.telegram.org";

export function createTelegramApi(botToken: string) {
  const baseUrl = `${BASE_URL}/bot${botToken}`;

  async function callApi<T>(method: string, params?: object): Promise<T> {
    const response = await fetch(`${baseUrl}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: params ? JSON.stringify(params) : undefined,
    });
    const data = await response.json() as TelegramApiResponse<T>;
    if (!data.ok) throw new Error(`Telegram API: ${data.description} (${data.error_code})`);
    return data.result!;
  }

  return {
    getMe: () => callApi<TelegramUser>("getMe"),
    sendMessage: (params: SendMessageParams) => callApi<TelegramMessage>("sendMessage", params),
    getUpdates: (offset?: number, timeout = 30) =>
      callApi<TelegramUpdate[]>("getUpdates", { offset, timeout, allowed_updates: ["message"] }),
    deleteWebhook: () => callApi<boolean>("deleteWebhook", { drop_pending_updates: false }),
  };
}

export type TelegramApi = ReturnType<typeof createTelegramApi>;
