import { allDevices, emptyToday, getMeta, saveNow, scheduleSave, type Device } from './store.js';
import { accrue, dailyMessage, dateKey, periodsOf, weeklyMessage } from './stats.js';
import { sendToSubscriptions } from './telegram.js';

// Статистика надсилається за 5 хвилин до півночі, а добові лічильники скидаються рівно опівночі.
const REPORT_HOUR = 23;
const REPORT_MINUTE = 55;

const HISTORY_DAYS = 14;

/** 'YYYY-MM-DD' -> [рік, місяць, день] */
const parseKey = (key: string): [number, number, number] => {
  const [y = 0, m = 1, d = 1] = key.split('-').map(Number);
  return [y, m, d];
};

/** Тижнева статистика надсилається в неділю, одразу після добової. */
function isSunday(key: string): boolean {
  const [y, m, d] = parseKey(key);
  return new Date(y, m - 1, d).getDay() === 0;
}

/** Ключі семи діб, що закінчуються днем endKey (від понеділка до неділі). */
function lastSevenKeys(endKey: string): string[] {
  const [y, m, d] = parseKey(endKey);
  return Array.from({ length: 7 }, (_, i) => dateKey(new Date(y, m - 1, d - 6 + i)));
}

/** Зберігає підсумок доби для тижневої статистики (повторний запис за ту саму добу замінює попередній). */
function recordDay(dev: Device, day: string, at: number): void {
  const { onHours, offHours } = dev.today;
  const history = (dev.history ?? []).filter((h) => h.date !== day);
  history.push({ date: day, onHours, offHours, periods: periodsOf(dev.today, at) });
  history.sort((a, b) => a.date.localeCompare(b.date));
  dev.history = history.slice(-HISTORY_DAYS);
}

/** Надсилає статистику за поточну добу (дані до моменту at). Лічильники не скидає. */
export function sendDailyReports(at: number): void {
  const meta = getMeta();
  const reportDay = meta.todayDate ?? dateKey(new Date(at - 1));
  const weekKeys = isSunday(reportDay) ? lastSevenKeys(reportDay) : null;
  for (const dev of allDevices()) {
    accrue(dev, at);
    const daily = sendToSubscriptions(dev.chats, (name: string) => dailyMessage(dev, name, reportDay, at));
    recordDay(dev, reportDay, at);
    if (weekKeys) {
      const days = dev.history.filter((h) => weekKeys.includes(h.date));
      // Після добової, щоб повідомлення прийшли в правильному порядку.
      if (days.length) void daily.then(() => sendToSubscriptions(dev.chats, (name: string) => weeklyMessage(days, name)));
    }
  }
  meta.reportedDate = reportDay;
  console.log(`[daily] надіслано статистику за ${reportDay}`);
  saveNow();
}

/** Закриває добу в момент boundary: якщо статистику ще не надіслано (сервер був вимкнений о 23:55), надсилає її, потім обнуляє лічильники. */
export function rollOver(boundary: number): void {
  const meta = getMeta();
  if (meta.todayDate && meta.reportedDate !== meta.todayDate) sendDailyReports(boundary);
  for (const dev of allDevices()) {
    accrue(dev, boundary);
    dev.today = emptyToday(dev.status);
  }
  meta.todayDate = dateKey(new Date(boundary));
  saveNow();
}

/** Щодня о hour:minute (локальний час) викликає fn(момент_запуску). hour = 24 — північ. */
function scheduleDaily(hour: number, minute: number, fn: (at: number) => void): void {
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0); // з урахуванням переходу на літній час
  if (next <= now) next.setDate(next.getDate() + 1);
  setTimeout(() => {
    fn(next.getTime());
    scheduleDaily(hour, minute, fn);
  }, next.getTime() - now.getTime() + 50);
}

export function startDailyScheduler(): void {
  const meta = getMeta();
  const today = dateKey();
  if (!meta.todayDate) {
    meta.todayDate = today;
    scheduleSave();
  } else if (meta.todayDate !== today) {
    // Сервер був вимкнений опівночі: закриваємо минулу добу (і надсилаємо пропущену статистику) з початку сьогоднішньої.
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    rollOver(startOfToday.getTime());
  }
  scheduleDaily(REPORT_HOUR, REPORT_MINUTE, sendDailyReports);
  scheduleDaily(24, 0, rollOver);
}
