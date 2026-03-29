/**
 * Converts a human-friendly local-time schedule into a UTC cron expression.
 * Uses Intl.DateTimeFormat for DST-aware timezone offset resolution — no
 * external date libraries required (Node.js 20+ has full IANA support).
 */

export interface BuildUtcCronOpts {
  /** Local hour 0-23 */
  hour: number;
  /** Local minute 0-59 */
  minute: number;
  /** Comma-separated day-of-week numbers (0=Sun … 6=Sat), or null/undefined for daily */
  daysOfWeek?: string | null;
  /** IANA timezone, e.g. "America/Chicago" */
  timezone: string;
  /** Reference date used to determine the current UTC offset (defaults to now) */
  referenceDate?: Date;
}

/**
 * Resolve the UTC offset (in minutes, positive = ahead of UTC) for a given
 * IANA timezone at a specific instant.
 *
 * Strategy: format the reference date in both UTC and the target timezone,
 * parse the parts, and compute the delta in minutes.
 */
function getTimezoneOffsetMinutes(timezone: string, date: Date): number {
  const utcParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const localParts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const get = (parts: Intl.DateTimeFormatPart[], type: string): number => {
    const val = parts.find((p) => p.type === type)?.value ?? '0';
    // Intl may return "24" for midnight in hour12:false — treat as 0
    return type === 'hour' && val === '24' ? 0 : Number(val);
  };

  // Build comparable minute-of-epoch for each
  const utcTotal =
    Date.UTC(get(utcParts, 'year'), get(utcParts, 'month') - 1, get(utcParts, 'day'), get(utcParts, 'hour'), get(utcParts, 'minute'));
  const localTotal =
    Date.UTC(get(localParts, 'year'), get(localParts, 'month') - 1, get(localParts, 'day'), get(localParts, 'hour'), get(localParts, 'minute'));

  return (localTotal - utcTotal) / 60_000;
}

/**
 * Build a UTC cron expression from local-time schedule fields.
 *
 * If the UTC conversion crosses midnight (e.g. 11 PM CDT → 4 AM UTC next day),
 * the day-of-week values are shifted +1 (wrapping 6→0). If `daysOfWeek` is
 * null (every day), the shift doesn't matter.
 */
export function buildUtcCron(opts: BuildUtcCronOpts): string {
  const { hour, minute, daysOfWeek, timezone, referenceDate } = opts;
  const ref = referenceDate ?? new Date();

  const offsetMinutes = getTimezoneOffsetMinutes(timezone, ref);

  // Convert local time to UTC
  let utcMinute = minute - (offsetMinutes % 60);
  let utcHour = hour - Math.trunc(offsetMinutes / 60);

  // Carry from minute → hour
  if (utcMinute < 0) {
    utcMinute += 60;
    utcHour -= 1;
  } else if (utcMinute >= 60) {
    utcMinute -= 60;
    utcHour += 1;
  }

  // Track day shift from hour → day
  let dayShift = 0;
  if (utcHour < 0) {
    utcHour += 24;
    dayShift = -1;
  } else if (utcHour >= 24) {
    utcHour -= 24;
    dayShift = 1;
  }

  // Build day-of-week field
  let dowField = '*';
  if (daysOfWeek) {
    const days = daysOfWeek.split(',').map(Number);
    if (dayShift !== 0) {
      const shifted = days.map((d) => ((d + dayShift) % 7 + 7) % 7);
      dowField = [...new Set(shifted)].sort((a, b) => a - b).join(',');
    } else {
      dowField = days.sort((a, b) => a - b).join(',');
    }
  }

  return `${utcMinute} ${utcHour} * * ${dowField}`;
}
