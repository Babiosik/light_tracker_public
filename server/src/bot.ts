import { config } from './config.js';
import {
  ID_RE, addDevice, allDevices, forgetUnknown, getDevice, reloadDevicesConfig, saveNow, unknownPings, writeDevicesConfig,
  type ChatId, type Device,
} from './store.js';
import { escapeHtml, sampleDailyMessage, sampleWeeklyMessage } from './stats.js';
import { callApi, sendMessage } from './telegram.js';
import { errorMessage } from './util.js';

/** Лише поля оновлення Telegram, які використовує бот. */
export interface TelegramUpdate {
  update_id: number;
  message?: { text?: string; chat: { id: ChatId } };
}

const MAX_NAME_LENGTH = 100;
let botUsername = '';

const COMMANDS = [
  { command: 'start', description: 'ID чату та довідка' },
  { command: 'add', description: 'Підписати чат на пристрій: /add <id> [назва для цього чату]' },
  { command: 'remove', description: 'Відписати чат від пристрою: /remove <id>' },
  { command: 'list', description: 'Пристрої цього чату' },
];

const sameChat = (a: ChatId, b: ChatId): boolean => String(a) === String(b);

function isAllowed(chatId: ChatId): boolean {
  return config.botAllowedChatIds.length === 0 || config.botAllowedChatIds.some((id) => sameChat(id, chatId));
}

/** Лише адмін (ADMIN_CHAT_ID) може перезапускати сервер. Для інших команда просто ігнорується. */
function isAdmin(chatId: ChatId): boolean {
  return !!config.adminChatId && sameChat(config.adminChatId, chatId);
}

function statusLabel(dev: Device): string {
  return dev.status === 'on' ? '💡 світло є' : '🌑 світла немає';
}

function helpText(chatId: ChatId): string {
  return [
    '<b>Light Tracker</b> 💡',
    `ID цього чату: <code>${escapeHtml(chatId)}</code>`,
    '',
    'Команди:',
    '/add &lt;id&gt; [назва] — підписати цей чат на пристрій; назва — як цей чат бачитиме пристрій (новий пристрій буде створено)',
    '/remove &lt;id&gt; — відписати цей чат від пристрою',
    '/list — пристрої цього чату',
    '',
    'id пристрою — це кінець адреси у скетчі: <code>/api/light/&lt;id&gt;</code>',
  ].join('\n');
}

function cmdAdd(chatId: ChatId, args: string[]): string {
  const [id, ...nameParts] = args;
  if (!id) return 'Вкажіть id пристрою: <code>/add &lt;id&gt; [назва]</code>';
  if (!ID_RE.test(id)) return 'id може містити лише латинські літери, цифри, <code>_</code> і <code>-</code> (до 64 символів).';
  const name = nameParts.join(' ').slice(0, MAX_NAME_LENGTH).trim();

  reloadDevicesConfig(); // підхопити ручні зміни devices.json перед записом
  const existing = getDevice(id);
  const created = !existing;
  const dev = existing ?? addDevice(id);
  if (created) forgetUnknown(id);

  // Назва зберігається для цього чату, інші чати на той самий пристрій її не змінюють.
  let sub = dev.chats.find((s) => sameChat(s.chatId, chatId));
  const alreadySubscribed = !!sub;
  if (sub) {
    if (name) sub.name = name;
  } else {
    sub = { chatId, name: name || id };
    dev.chats.push(sub);
  }
  writeDevicesConfig();
  saveNow();
  console.log(`[bot] /add ${id} від чату ${chatId}${created ? ' (новий пристрій)' : ''}`);

  const lines = [];
  if (created) {
    lines.push(`✅ Пристрій <code>${escapeHtml(id)}</code> створено, цей чат підписано.`);
    lines.push(`Пристрій має надсилати запити на <code>/api/light/${escapeHtml(id)}</code>.`);
  } else if (alreadySubscribed) {
    lines.push(`Цей чат уже підписано на <code>${escapeHtml(id)}</code>.${name ? ' Назву для цього чату оновлено.' : ''}`);
  } else {
    lines.push(`✅ Цей чат підписано на <code>${escapeHtml(id)}</code>.`);
  }
  lines.push(`📍 ${escapeHtml(sub.name)} — ${statusLabel(dev)}`);
  return lines.join('\n');
}

function cmdRemove(chatId: ChatId, args: string[]): string {
  const [id] = args;
  if (!id) return 'Вкажіть id пристрою: <code>/remove &lt;id&gt;</code>';
  reloadDevicesConfig();
  const dev = ID_RE.test(id) ? getDevice(id) : undefined;
  const sub = dev?.chats.find((s) => sameChat(s.chatId, chatId));
  if (!dev || !sub) {
    return `Цей чат не підписано на <code>${escapeHtml(id)}</code>.`;
  }
  dev.chats = dev.chats.filter((s) => s !== sub);
  writeDevicesConfig();
  saveNow();
  console.log(`[bot] /remove ${id} від чату ${chatId}`);
  return `Цей чат відписано від <code>${escapeHtml(id)}</code> (${escapeHtml(sub.name)}).`;
}

function cmdList(chatId: ChatId): string {
  const mine = allDevices()
    .flatMap((dev) => {
      const sub = dev.chats.find((s) => sameChat(s.chatId, chatId));
      return sub ? [{ dev, sub }] : [];
    });
  if (!mine.length) return 'Цей чат не підписано на жоден пристрій. Додайте: <code>/add &lt;id&gt; [назва]</code>';
  return [
    '<b>Пристрої цього чату:</b>',
    ...mine.map(({ dev, sub }) => `• <code>${escapeHtml(dev.id)}</code> — ${escapeHtml(sub.name)} — ${statusLabel(dev)}`),
  ].join('\n');
}

function ago(ms: number): string {
  const min = Math.max(0, Math.round((Date.now() - ms) / 60_000));
  if (min < 1) return 'щойно';
  if (min < 60) return `${min} хв тому`;
  const h = Math.floor(min / 60);
  return h < 48 ? `${h} год тому` : `${Math.floor(h / 24)} дн тому`;
}

/** Пристрої, що шлють запити, але на які не підписано жодного чату. Лише для адміна. */
function cmdUnassigned(): string {
  reloadDevicesConfig();
  const rows = [];
  // Є в devices.json, але без чатів
  for (const dev of allDevices()) {
    if (dev.chats.length === 0 && dev.lastSeen != null) {
      rows.push({ id: dev.id, lastSeen: dev.lastSeen, note: 'є в списку, без чатів' });
    }
  }
  // Невідомі id: сервер відповів їм 404, але запам'ятав
  for (const u of unknownPings()) {
    if (getDevice(u.id)) {
      forgetUnknown(u.id);
      continue;
    }
    rows.push({ id: u.id, lastSeen: u.lastSeen, note: `новий, запитів: ${u.count}` });
  }
  if (!rows.length) return 'Пристроїв без чату не знайдено.';
  rows.sort((a, b) => b.lastSeen - a.lastSeen);
  return [
    '<b>Пристрої без чату:</b>',
    ...rows.map((r) => `• <code>${escapeHtml(r.id)}</code> — востаннє ${ago(r.lastSeen)} (${escapeHtml(r.note)})`),
    '',
    'Додати: <code>/add &lt;id&gt; [назва]</code>',
  ].join('\n');
}

/** Обробляє одне оновлення від Telegram. Повертає текст відповіді (або null) — зручно для тестів. */
export async function handleUpdate(update: TelegramUpdate): Promise<string | null> {
  const msg = update.message;
  if (!msg?.text?.startsWith('/')) return null;
  const chatId = msg.chat.id;

  const [rawCommand = '', ...args] = msg.text.trim().split(/\s+/);
  const [command, target] = rawCommand.slice(1).toLowerCase().split('@');
  // У групах команда може бути адресована іншому боту: /add@OtherBot
  if (target && botUsername && target !== botUsername.toLowerCase()) return null;

  let reply;
  let restart = false;
  switch (command) {
    case 'start':
    case 'help':
      reply = helpText(chatId);
      break;
    case 'restart':
      if (!isAdmin(chatId)) return null; // не відповідаємо, щоб не показувати команду іншим
      reply = '🔄 Перезапускаю сервер…';
      restart = true;
      break;
    case 'unassigned':
      if (!isAdmin(chatId)) return null;
      reply = cmdUnassigned();
      break;
    case 'add':
    case 'remove':
      if (!isAllowed(chatId)) {
        reply = `⛔ Цьому чату заборонено керувати пристроями.\nID чату: <code>${escapeHtml(chatId)}</code>`;
      } else {
        reply = command === 'add' ? cmdAdd(chatId, args) : cmdRemove(chatId, args);
      }
      break;
    case 'list':
      reply = cmdList(chatId);
      break;
    case 'template': // тест вигляду таблиці статистики, у меню не показується
      reply = args[0]?.toLowerCase() === 'week' ? sampleWeeklyMessage() : sampleDailyMessage();
      break;
    default:
      return null;
  }
  await sendMessage(chatId, reply);
  if (restart) restartProcess();
  return reply;
}

/**
 * Завершує процес після відповіді адміну. Під systemd (Restart=always) сервіс підніметься сам,
 * і при старті адмін отримає повідомлення про перезавантаження.
 */
export function restartProcess(): void {
  console.log('[bot] перезапуск за командою адміна');
  saveNow();
  setTimeout(() => process.exit(0), 200);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Long polling: отримує команди від Telegram, поки працює сервер. */
export async function startBot(): Promise<void> {
  if (!config.botToken) return;

  try {
    const me = await callApi<{ username?: string }>('getMe');
    botUsername = me.username ?? '';
    await callApi('setMyCommands', { commands: COMMANDS });
    console.log(`[bot] @${botUsername} слухає команди`);
  } catch (err) {
    console.error(`[bot] не вдалося ініціалізувати бота: ${errorMessage(err)}`);
  }

  let offset = 0;
  for (;;) {
    try {
      const updates = await callApi<TelegramUpdate[]>('getUpdates', { offset, timeout: 50, allowed_updates: ['message'] }, 65_000);
      for (const update of updates) {
        offset = update.update_id + 1;
        try {
          await handleUpdate(update);
        } catch (err) {
          console.error(`[bot] помилка обробки оновлення ${update.update_id}: ${errorMessage(err)}`);
        }
      }
    } catch (err) {
      console.error(`[bot] getUpdates: ${errorMessage(err)}`);
      await sleep(5000);
    }
  }
}
