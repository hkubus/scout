// Shared date formatters. Date#toLocale*String with an options object builds
// a new Intl.DateTimeFormat on every call (~30-45 µs), which adds up in row
// and chart-point loops; these are built once. Same locale and options, so
// the output is identical.

const plFormat = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("pl-PL", options);

/** 14:05:09 */
export const timeWithSeconds = plFormat({ hour: "2-digit", minute: "2-digit", second: "2-digit" });
/** 14:05 */
export const timeOfDay = plFormat({ hour: "2-digit", minute: "2-digit" });
/** 03 paź */
export const dayMonth = plFormat({ day: "2-digit", month: "short" });
/** 03 paź 2026 */
export const dayMonthYear = plFormat({ day: "2-digit", month: "short", year: "numeric" });
/** 3 paź, 14:05 */
export const monthDayTime = plFormat({ month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
/** 3 paź 2026, 14:05 */
export const mediumDateShortTime = plFormat({ dateStyle: "medium", timeStyle: "short" });

/** Format like Date#toLocale*String: an invalid date reads "Invalid Date" instead of throwing. */
export function formatDate(format: Intl.DateTimeFormat, value: Date | string | number) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "Invalid Date" : format.format(date);
}
