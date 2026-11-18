import { config } from './config.js';
import type { ChatId, Subscription } from './store.js';
import { errorMessage } from './util.js';

/** Виклик методу Telegram Bot API. Кидає помилку, якщо Telegram відповів ok: false. */
export async function callApi<T = unknown>(method: string, params: object = {}, timeoutMs = 15_000): Promise<T> {
  const res = await fetch(`https://api.telegram.org/bot${config.botToken}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let data: { ok: boolean; result: T; error_code?: number; description?: string };
  try {
    data = (await res.json()) as typeof data;
  } catch {
    throw new Error(`${method}: HTTP ${res.status}`);
  }
  if (!data.ok) throw new Error(`${method}: ${data.error_code} ${data.description}`);
  return data.result;
}

/** Надсилає повідомлення в один чат. Помилки лише логуються. */
export async function sendMessage(chatId: ChatId, text: string): Promise<void> {
  try {
    await callApi('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true });
  } catch (err) {
    console.error(`[telegram] чат ${chatId}: ${errorMessage(err)}`);
  }
}

/** Надсилає повідомлення адміну (ADMIN_CHAT_ID). Якщо адміна не задано — нічого не робить. */
export function notifyAdmin(text: string): Promise<void> {
  if (!config.adminChatId) return Promise.resolve();
  return sendToChats([config.adminChatId], text);
}

/**
 * Надсилає кожному підписаному чату персональний текст: build(name) отримує назву пристрою для цього чату.
 * Помилки лише логуються, щоб не зупиняти сервер.
 */
export async function sendToSubscriptions(subs: Subscription[], build: (name: string) => string): Promise<void> {
  if (!subs.length) return;
  if (!config.botToken) {
    for (const sub of subs) {
      console.warn(`[telegram] TELEGRAM_BOT_TOKEN не задано, повідомлення для чату ${sub.chatId} не надіслано:\n${build(sub.name)}\n`);
    }
    return;
  }
  await Promise.allSettled(subs.map((sub) => sendMessage(sub.chatId, build(sub.name))));
}

/** Надсилає повідомлення в усі чати. Помилки лише логуються, щоб не зупиняти сервер. */
export async function sendToChats(chatIds: ChatId[], text: string): Promise<void> {
  if (!chatIds.length) return;
  if (!config.botToken) {
    console.warn(`[telegram] TELEGRAM_BOT_TOKEN не задано, повідомлення не надіслано:\n${text}\n`);
    return;
  }
  await Promise.allSettled(chatIds.map((id) => sendMessage(id, text)));
}
