import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Часовий пояс задаємо до будь-якої роботи з датами: від нього залежить "північ".
if (!process.env.TZ) process.env.TZ = 'Europe/Kyiv';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function positiveNumber(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const config = {
  host: process.env.HOST || '0.0.0.0',
  port: positiveNumber(process.env.PORT, 8080),
  botToken: process.env.TELEGRAM_BOT_TOKEN || '',
  // Адмін: отримує повідомлення про перезапуск сервера і єдиний може виконати /restart.
  adminChatId: (process.env.ADMIN_CHAT_ID || '').trim(),
  // Чати, яким дозволено /add і /remove. Порожньо — дозволено всім.
  botAllowedChatIds: (process.env.BOT_ALLOWED_CHAT_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  timezone: process.env.TZ ?? 'Europe/Kyiv',
  // Як часто пристрій надсилає запит (має збігатися з INTERVAL_MS у скетчі).
  heartbeatIntervalSec: positiveNumber(process.env.HEARTBEAT_INTERVAL_SEC, 30),
  // Скільки запитів поспіль можна пропустити, перш ніж вважати світло вимкненим.
  missedHeartbeats: positiveNumber(process.env.MISSED_HEARTBEATS, 3),
  // Як часто перевіряти пропущені запити.
  checkIntervalSec: positiveNumber(process.env.CHECK_INTERVAL_SEC, 5),
  devicesFile: path.resolve(serverRoot, process.env.DEVICES_FILE || 'devices.json'),
  stateFile: path.resolve(serverRoot, process.env.STATE_FILE || 'data/state.json'),
};

export const offlineTimeoutMs = config.heartbeatIntervalSec * config.missedHeartbeats * 1000;
