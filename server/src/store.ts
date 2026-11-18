import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { errorMessage, isErrnoException } from './util.js';

export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_NAME_LENGTH = 100;

export type Status = 'on' | 'off';
export type ChatId = number | string;

/** Підписка чату на пристрій. Кожен чат має свою назву для одного й того самого пристрою. */
export interface Subscription {
  chatId: ChatId;
  /** Назва пристрою, як її бачить цей чат */
  name: string;
}

export interface StatusEvent {
  at: number;
  status: Status;
}

export interface Period {
  status: Status;
  from: number;
  to: number;
}

/** Підсумок однієї доби для тижневої статистики. */
export interface DayRecord {
  date: string;
  onHours: number;
  offHours: number;
  periods: Period[];
}

/** Статистика за поточну добу. */
export interface TodayStats {
  onHours: number;
  offHours: number;
  switchCount: number;
  /** Скільки мс зі світлом було в кожному з 48 півгодинних проміжків */
  onSlots: number[];
  /** Статус на початок доби */
  startStatus: Status;
  /** Зміни статусу за добу */
  events: StatusEvent[];
}

export interface Device {
  id: string;
  status: Status;
  /** Підписані чати */
  chats: Subscription[];
  /** Час попередньої зміни статусу (ISO) */
  lastChange: string | null;
  /** Всього годин без світла */
  offHours: number;
  /** Всього годин зі світлом */
  onHours: number;
  /** Всього перемикань */
  switchCount: number;
  /** Час останнього запиту (ms) */
  lastSeen: number | null;
  /** До якого моменту вже пораховані години (ms) */
  statsUpdatedAt: number | null;
  /** Підсумки минулих діб (останні 14) для тижневої статистики */
  history: DayRecord[];
  today: TodayStats;
}

interface UnknownPing {
  firstSeen: number;
  lastSeen: number;
  count: number;
}

interface Meta {
  /** Доба ('YYYY-MM-DD'), для якої зараз ведуться лічильники */
  todayDate: string | null;
  /** Доба, за яку вже надіслано статистику */
  reportedDate?: string;
  unknown: Record<string, UnknownPing>;
}

const devices = new Map<string, Device>();
let meta: Meta = { todayDate: null, unknown: {} };
const MAX_UNKNOWN = 100;
let devicesFileMtime: number | 'missing' | null = null;
let saveTimer: NodeJS.Timeout | null = null;

export const SLOTS_PER_DAY = 48; // півгодинні проміжки доби

/** startStatus — статус на початок доби, events — зміни статусу за добу: [{at, status}]. */
export function emptyToday(startStatus: Status = 'off'): TodayStats {
  return { onHours: 0, offHours: 0, switchCount: 0, onSlots: new Array<number>(SLOTS_PER_DAY).fill(0), startStatus, events: [] };
}

function newDevice(id: string): Device {
  return {
    id,
    status: 'off',
    chats: [],
    lastChange: null,
    offHours: 0,
    onHours: 0,
    switchCount: 0,
    lastSeen: null,
    statsUpdatedAt: null,
    today: emptyToday(),
    history: [],
  };
}

/** Запис із state.json або devices.json: форма не гарантована, тому поля перевіряються під час читання. */
type RawRecord = Record<string, any>;

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') return fallback;
    throw err;
  }
}

/** Завантажує збережений стан, потім накладає на нього devices.json. */
export function loadState(): void {
  const state = readJson<RawRecord>(config.stateFile, { meta: {}, devices: [] });
  meta = { todayDate: null, unknown: {}, ...state.meta };
  for (const saved of (state.devices ?? []) as RawRecord[]) {
    if (!saved || typeof saved.id !== 'string') continue;
    // Назви й чати зі state.json (старий формат) ігноруємо: їх бере devices.json.
    const { name, chatIds, chats, ...stats } = saved;
    const today: TodayStats = { ...emptyToday(saved.status === 'on' ? 'on' : 'off'), ...saved.today };
    if (!Array.isArray(today.onSlots) || today.onSlots.length !== SLOTS_PER_DAY) today.onSlots = emptyToday().onSlots;
    devices.set(saved.id, { ...newDevice(saved.id), ...stats, today });
  }
  reloadDevicesConfig();
}

/** Розбирає чати запису з devices.json. Підтримує і новий формат, і старий (name + chatIds). */
function parseChats(cfg: RawRecord & { id: string }): Subscription[] {
  const legacyName = typeof cfg.name === 'string' && cfg.name.trim() ? cfg.name.trim() : cfg.id;
  const entries: { chatId: unknown; name: unknown }[] = Array.isArray(cfg.chats)
    ? cfg.chats.filter((s: unknown) => s && typeof s === 'object').map((s: RawRecord) => ({ chatId: s.chatId, name: s.name }))
    : Array.isArray(cfg.chatIds)
      ? cfg.chatIds.map((chatId: unknown) => ({ chatId, name: legacyName }))
      : [];

  const chats: Subscription[] = [];
  for (const { chatId, name } of entries) {
    if (typeof chatId !== 'number' && !(typeof chatId === 'string' && chatId.trim())) continue;
    if (chats.some((s) => String(s.chatId) === String(chatId))) continue;
    const cleanName = typeof name === 'string' ? name.trim().slice(0, MAX_NAME_LENGTH) : '';
    chats.push({ chatId, name: cleanName || cfg.id });
  }
  return chats;
}

/**
 * Перечитує devices.json, якщо файл змінився. Звідти беруться id і чати з назвами;
 * статус і статистика живуть у data/state.json.
 */
export function reloadDevicesConfig(): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(config.devicesFile);
  } catch (err) {
    if (!isErrnoException(err) || err.code !== 'ENOENT') throw err;
    if (devicesFileMtime !== 'missing') {
      console.warn(`[devices] файл ${config.devicesFile} не знайдено, пристроїв немає`);
      devicesFileMtime = 'missing';
    }
    return;
  }
  if (stat.mtimeMs === devicesFileMtime) return;
  devicesFileMtime = stat.mtimeMs;

  let list: unknown;
  try {
    list = JSON.parse(fs.readFileSync(config.devicesFile, 'utf8'));
  } catch (err) {
    console.error(`[devices] помилка в devices.json, зміни не застосовано: ${errorMessage(err)}`);
    return;
  }
  if (!Array.isArray(list)) {
    console.error('[devices] devices.json має бути масивом об\'єктів');
    return;
  }

  const seen = new Set<string>();
  let legacyFormat = false;
  for (const cfg of list as RawRecord[]) {
    if (!cfg || typeof cfg.id !== 'string' || !ID_RE.test(cfg.id)) {
      console.warn(`[devices] пропущено запис з некоректним id: ${JSON.stringify(cfg)}`);
      continue;
    }
    if (seen.has(cfg.id)) {
      console.warn(`[devices] id "${cfg.id}" повторюється, використано перший запис`);
      continue;
    }
    seen.add(cfg.id);
    if (!Array.isArray(cfg.chats) && ('name' in cfg || 'chatIds' in cfg)) legacyFormat = true;
    const dev = devices.get(cfg.id) ?? newDevice(cfg.id);
    dev.chats = parseChats(cfg as RawRecord & { id: string });
    devices.set(cfg.id, dev);
  }
  for (const id of [...devices.keys()]) {
    if (!seen.has(id)) devices.delete(id);
  }
  console.log(`[devices] завантажено пристроїв: ${devices.size}`);

  if (legacyFormat) {
    // Перезаписуємо файл у новому форматі (назви тепер прив'язані до чатів).
    console.log('[devices] devices.json переведено на формат із назвами для кожного чату');
    writeDevicesConfig();
  }
  scheduleSave();
}

/** Створює новий пристрій у пам'яті (збережіть через writeDevicesConfig). */
export function addDevice(id: string): Device {
  const dev = newDevice(id);
  devices.set(id, dev);
  return dev;
}

/** Записує пристрої та їхні чати з назвами назад у devices.json (для команд бота). */
export function writeDevicesConfig(): void {
  const list = allDevices().map(({ id, chats }) => ({
    id,
    chats: chats.map(({ chatId, name }) => ({ chatId, name })),
  }));
  const tmp = `${config.devicesFile}.tmp`;
  fs.mkdirSync(path.dirname(config.devicesFile), { recursive: true });
  fs.writeFileSync(tmp, `${JSON.stringify(list, null, 2)}\n`);
  fs.renameSync(tmp, config.devicesFile);
  // Щоб reloadDevicesConfig не перечитував наш же запис.
  devicesFileMtime = fs.statSync(config.devicesFile).mtimeMs;
}

/** Запам'ятовує запит від id, якого немає в devices.json (щоб адмін міг його знайти й додати). */
export function recordUnknownPing(id: string, now: number): void {
  const known = meta.unknown;
  const entry = known[id];
  if (entry) {
    entry.lastSeen = now;
    entry.count += 1;
  } else {
    const ids = Object.keys(known);
    if (ids.length >= MAX_UNKNOWN) {
      // Не даємо списку рости безмежно (сканери, випадкові id): прибираємо найстаріший.
      const lastSeen = (key: string) => known[key]?.lastSeen ?? 0;
      const oldest = ids.reduce((a, b) => (lastSeen(a) <= lastSeen(b) ? a : b));
      delete known[oldest];
    }
    known[id] = { firstSeen: now, lastSeen: now, count: 1 };
  }
  scheduleSave();
}

export function unknownPings(): (UnknownPing & { id: string })[] {
  return Object.entries(meta.unknown).map(([id, e]) => ({ id, ...e }));
}

export function forgetUnknown(id: string): void {
  if (id in meta.unknown) {
    delete meta.unknown[id];
    scheduleSave();
  }
}

export function getDevice(id: string): Device | undefined {
  return devices.get(id);
}

export function allDevices(): Device[] {
  return [...devices.values()];
}

export function getMeta(): Meta {
  return meta;
}

export function scheduleSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveNow();
  }, 1000);
}

export function saveNow(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  try {
    fs.mkdirSync(path.dirname(config.stateFile), { recursive: true });
    const tmp = `${config.stateFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ meta, devices: allDevices() }, null, 2));
    fs.renameSync(tmp, config.stateFile);
  } catch (err) {
    console.error(`[state] не вдалося зберегти стан: ${errorMessage(err)}`);
  }
}
