import { config } from './config.js';
import { SLOTS_PER_DAY, type DayRecord, type Device, type Period, type Status, type TodayStats } from './store.js';

/** Мінімум від пристрою, потрібний для повідомлень (зручно для тестових даних). */
type DeviceView = Pick<Device, 'status' | 'today'>;

export const HOUR_MS = 3_600_000;
const SLOT_MS = 1_800_000; // 30 хв
const DAY_HOURS = 24;
const ICON_ON = '⚡️'; // ⚡️
const ICON_OFF = '\u{1F56F}️'; // 🕯️

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Розкладає інтервал [from, to) зі світлом по півгодинних проміжках доби, в якій він закінчується. */
function addOnSlots(slots: number[], from: number, to: number): void {
  let t = Math.max(from, startOfDay(to - 1));
  while (t < to) {
    const d = new Date(t);
    const slot = d.getHours() * 2 + (d.getMinutes() >= 30 ? 1 : 0);
    const toSlotEnd = SLOT_MS - (d.getMinutes() % 30) * 60_000 - d.getSeconds() * 1000 - d.getMilliseconds();
    const next = Math.min(to, t + toSlotEnd);
    slots[slot] = (slots[slot] ?? 0) + (next - t);
    t = next;
  }
}

/** Додає час з останнього підрахунку до лічильників поточного статусу. */
export function accrue(dev: Device, at: number): void {
  if (dev.statsUpdatedAt == null) {
    dev.statsUpdatedAt = at;
    return;
  }
  if (at <= dev.statsUpdatedAt) return;
  const hours = (at - dev.statsUpdatedAt) / HOUR_MS;
  if (dev.status === 'on') {
    dev.onHours += hours;
    dev.today.onHours += hours;
    addOnSlots(dev.today.onSlots, dev.statsUpdatedAt, at);
  } else {
    dev.offHours += hours;
    dev.today.offHours += hours;
  }
  dev.statsUpdatedAt = at;
}

export function formatHours(hours: number): string {
  const totalMinutes = Math.round(hours * 60);
  const days = Math.floor(totalMinutes / 1440);
  const h = Math.floor((totalMinutes % 1440) / 60);
  const m = totalMinutes % 60;
  const parts: string[] = [];
  if (days) parts.push(`${days} д`);
  if (h || days) parts.push(`${h} год`);
  parts.push(`${m} хв`);
  return parts.join(' ');
}

export function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString('uk-UA', { timeZone: config.timezone, hour: '2-digit', minute: '2-digit' });
}

/** 'YYYY-MM-DD' -> 'DD.MM.YYYY' */
export function formatDateKey(key: string): string {
  const [y, m, d] = key.split('-');
  return `${d}.${m}.${y}`;
}

/** Ключ доби в локальному часовому поясі: 'YYYY-MM-DD'. */
export function dateKey(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function escapeHtml(text: string | number): string {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const percent = (hours: number, base: number): number => (base > 0 ? Math.round(Math.min(100, (hours / base) * 100)) : 0);

/** Статистика за поточну добу: відсотки від пройденого часу доби та від усієї доби. */
function todayLines(dev: Pick<Device, 'today'>): string[] {
  const { onHours, offHours } = dev.today;
  const passed = onHours + offHours;
  const row = (hours: number) => `${formatHours(hours)} (${percent(hours, passed)}%, ${percent(hours, DAY_HOURS)}%)`;
  return [
    '📊 <b>Сьогодні</b> (від пройденого часу, від доби):',
    `💡 ${row(onHours)}`,
    `🌑 ${row(offHours)}`,
  ];
}

// name — назва пристрою, як її бачить конкретний чат.
export function lightOnMessage(dev: Pick<Device, 'today'>, name: string, prevDurationHours: number | null, at: number): string {
  return [
    '💡 <b>Світло з\'явилося</b>',
    `📍 ${escapeHtml(name)}`,
    `🕒 ${formatTime(at)}`,
    `⏱ Було вимкнено: ${prevDurationHours == null ? 'невідомо' : formatHours(prevDurationHours)}`,
    ...todayLines(dev),
  ].join('\n');
}

export function lightOffMessage(dev: Pick<Device, 'today'>, name: string, prevDurationHours: number | null, at: number): string {
  return [
    '🌑 <b>Світло вимкнено</b>',
    `📍 ${escapeHtml(name)}`,
    `🕒 ~${formatTime(at)}`,
    `⏱ Було увімкнено: ${prevDurationHours == null ? 'невідомо' : formatHours(prevDurationHours)}`,
    ...todayLines(dev),
  ].join('\n');
}

const slotLabel = (i: number): string => `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`;

/**
 * Таблиця доби: 12 рядків × 4 блоки (час + значок) = 8 стовпчиків, по півгодини на клітинку.
 * at — до якого моменту є дані (пізніші проміжки позначаються "·"); без нього вважається, що доба повна.
 */
export function scheduleTable(onSlots: number[], at?: number): string {
  const dayStart = at == null ? null : startOfDay(at - 1);
  const icon = (i: number): string => {
    const covered = at == null || dayStart == null ? SLOT_MS : Math.min(SLOT_MS, at - (dayStart + i * SLOT_MS));
    if (covered <= 0) return '·';
    return (onSlots[i] ?? 0) * 2 >= covered ? ICON_ON : ICON_OFF;
  };
  const rows: string[] = [];
  for (let r = 0; r < SLOTS_PER_DAY / 4; r += 1) {
    const cells = [0, 1, 2, 3].map((c) => {
      const i = c * (SLOTS_PER_DAY / 4) + r;
      return ` ${slotLabel(i)} ${icon(i)}`;
    });
    rows.push(cells.join('│'));
  }
  const rule = '─'.repeat(39);
  return `<pre>${[rule, ...rows, rule].join('\n')}</pre>`;
}

/** Періоди доби, в якій закінчується момент at: [{status, from, to}] (мс). */
export function periodsOf(today: Pick<TodayStats, 'startStatus' | 'events'>, at: number): Period[] {
  const dayStart = startOfDay(at - 1);
  const periods: Period[] = [];
  let status: Status = today.startStatus === 'on' ? 'on' : 'off';
  let from = dayStart;
  const close = (to: number): void => {
    if (to > from) periods.push({ status, from, to });
  };
  for (const ev of today.events ?? []) {
    if (ev.status === status || ev.at >= at) continue;
    const t = Math.max(ev.at, dayStart);
    close(t);
    status = ev.status;
    from = t;
  }
  close(at);
  return periods;
}

/** Коротка зведення за часом: ⚡️ 00:00 - 01:34 / 🕯️ 01:34 - 12:03 ... */
export function formatPeriods(periods: Period[]): string[] {
  return periods.map((p) => `${p.status === 'on' ? ICON_ON : ICON_OFF} ${formatTime(p.from)} - ${formatTime(p.to)}`);
}

export const periodsLines = (today: Pick<TodayStats, 'startStatus' | 'events'>, at: number): string[] => formatPeriods(periodsOf(today, at));

const WEEKDAYS = ['Нд', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

/** 'YYYY-MM-DD' -> 'Пн (10.11)' */
function weekdayLabel(key: string): string {
  const [y = 0, m = 1, d = 1] = key.split('-').map(Number);
  return `${WEEKDAYS[new Date(y, m - 1, d).getDay()]} (${String(d).padStart(2, '0')}.${String(m).padStart(2, '0')})`;
}

/**
 * Статистика за тиждень в одному повідомленні.
 * days — [{date, onHours, offHours, periods}] за порядком дат. Якщо текст не вміщається в ліміт Telegram, графіки прибираються.
 */
export function weeklyMessage(days: DayRecord[], name: string): string {
  const first = days[0];
  const last = days[days.length - 1];
  if (!first || !last) return '';
  const pct = (h: number, sum: number): string => (sum > 0 ? ` (${Math.round((h / sum) * 100)}%)` : '');
  const totals = (on: number, off: number): string[] => [
    `💡 Зі світлом: ${formatHours(on)}${pct(on, on + off)}`,
    `🌑 Без світла: ${formatHours(off)}${pct(off, on + off)}`,
  ];
  const build = (withGraphs: boolean): string => {
    const lines = [
      `📆 <b>Статистика за тиждень ${formatDateKey(first.date)} – ${formatDateKey(last.date)}</b>`,
      `📍 ${escapeHtml(name)}`,
      '',
    ];
    for (const day of days) {
      lines.push(`<b>${weekdayLabel(day.date)}:</b>`, ...totals(day.onHours, day.offHours));
      if (withGraphs) lines.push('Графік:', ...formatPeriods(day.periods));
      lines.push('');
    }
    const on = days.reduce((s, d) => s + d.onHours, 0);
    const off = days.reduce((s, d) => s + d.offHours, 0);
    lines.push('<b>Усього за тиждень:</b>', ...totals(on, off));
    return lines.join('\n');
  };
  const full = build(true);
  return full.length <= 4000 ? full : build(false);
}

export function dailyMessage(dev: DeviceView, name: string, dayKey: string, at?: number): string {
  const { onHours, offHours, onSlots } = dev.today;
  const sum = onHours + offHours;
  const pct = (h: number): string => (sum > 0 ? ` (${Math.round((h / sum) * 100)}%)` : '');
  return [
    `📅 <b>Статистика за ${formatDateKey(dayKey)}</b>`,
    `📍 ${escapeHtml(name)}`,
    `💡 Зі світлом: ${formatHours(onHours)}${pct(onHours)}`,
    `🌑 Без світла: ${formatHours(offHours)}${pct(offHours)}`,
    `Зараз: ${dev.status === 'on' ? '💡 світло є' : '🌑 світла немає'}`,
    '',
    ...(at == null ? [] : [...periodsLines(dev.today, at), '']),
    `🗓 По півгодини: ${ICON_ON} світло є · ${ICON_OFF} немає`,
    scheduleTable(onSlots, at),
  ].join('\n');
}

/** Вигадана доба для тестів: today, як у dev.today, і момент кінця доби. shift змінює тривалість проміжків. */
function sampleDay(dayStart: number, shift = 0): { today: TodayStats; end: number } {
  const ranges: [number, number][] = [[0, 6 + shift], [14, 22], [30, 38 - shift], [44, 48]]; // півгодинні проміжки зі світлом
  const onSlots = Array.from({ length: SLOTS_PER_DAY }, (_, i) => (ranges.some(([a, b]) => i >= a && i < b) ? SLOT_MS : 0));
  const onHours = onSlots.filter(Boolean).length / 2;
  const events: TodayStats['events'] = [];
  let on = true;
  for (let i = 1; i < SLOTS_PER_DAY; i += 1) {
    const slotOn = (onSlots[i] ?? 0) > 0;
    if (slotOn !== on) events.push({ at: dayStart + i * SLOT_MS, status: slotOn ? 'on' : 'off' });
    on = slotOn;
  }
  const today: TodayStats = { onHours, offHours: DAY_HOURS - onHours, switchCount: 0, onSlots, startStatus: 'on', events };
  return { today, end: dayStart + DAY_HOURS * HOUR_MS };
}

/** Приклад повідомлення зі статистикою на вигаданих даних — для перевірки вигляду таблиці. */
export function sampleDailyMessage(): string {
  const { today, end } = sampleDay(startOfDay(Date.now()));
  return `🧪 <i>Тестові дані</i>\n${dailyMessage({ status: 'on', today }, 'Шаблон', dateKey(), end)}`;
}

/** Приклад тижневої статистики на вигаданих даних. */
export function sampleWeeklyMessage(): string {
  const now = new Date();
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6 + i);
    const { today, end } = sampleDay(d.getTime(), i);
    return { date: dateKey(d), onHours: today.onHours, offHours: today.offHours, periods: periodsOf(today, end) };
  });
  return `🧪 <i>Тестові дані</i>\n${weeklyMessage(days, 'Шаблон')}`;
}
