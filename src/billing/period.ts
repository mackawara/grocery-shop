// A billing period is one calendar month in a billing time zone, written
// "YYYY-MM". Rate versions are keyed by period rather than by an instant, so a
// change can only ever start on a month boundary: "never mid-month" (F2) holds
// by construction instead of depending on a validator someone has to call.
//
// Pure: no clock and no I/O. Callers pass `now` and the time zone.

export type BillingPeriod = string;

const PERIOD_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;

export const isBillingPeriod = (value: unknown): value is BillingPeriod =>
  typeof value === 'string' && PERIOD_PATTERN.test(value);

const parsePeriod = (period: BillingPeriod): { year: number; month: number } => {
  const match = PERIOD_PATTERN.exec(period);
  if (!match) {
    throw new RangeError(`Invalid billing period "${period}"; expected YYYY-MM`);
  }
  return { year: Number(match[1]), month: Number(match[2]) };
};

const formatPeriod = (year: number, month: number): BillingPeriod =>
  `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;

// Periods are zero-padded and fixed-width, so string order is time order.
export const comparePeriods = (a: BillingPeriod, b: BillingPeriod): number => {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
};

export const addMonths = (period: BillingPeriod, months: number): BillingPeriod => {
  const { year, month } = parsePeriod(period);
  const index = year * 12 + (month - 1) + months;
  return formatPeriod(Math.floor(index / 12), (index % 12) + 1);
};

// --- Time zone conversion ---------------------------------------------------
// Built on Intl so there is no time zone dependency to keep up to date: Node
// ships the IANA database. An unknown zone throws a RangeError on first use.

const formatters = new Map<string, Intl.DateTimeFormat>();

const formatterFor = (timeZone: string): Intl.DateTimeFormat => {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
};

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const wallClock = (instant: Date, timeZone: string): WallClock => {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const field = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value);
  return {
    year: field('year'),
    month: field('month'),
    day: field('day'),
    hour: field('hour'),
    minute: field('minute'),
    second: field('second'),
  };
};

// How far `timeZone` is ahead of UTC at `instant`, in milliseconds.
const utcOffsetMs = (instant: number, timeZone: string): number => {
  const wall = wallClock(new Date(instant), timeZone);
  const wallAsUtc = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second,
  );
  // The wall clock has whole seconds; compare against the instant truncated to
  // match, or sub-second instants would report a fractional offset.
  return wallAsUtc - Math.floor(instant / 1000) * 1000;
};

// The billing period that contains `instant` in `timeZone`.
export const periodOf = (instant: Date, timeZone: string): BillingPeriod => {
  const { year, month } = wallClock(instant, timeZone);
  return formatPeriod(year, month);
};

// The instant `period` begins: local midnight on the 1st in `timeZone`.
export const periodStart = (period: BillingPeriod, timeZone: string): Date => {
  const { year, month } = parsePeriod(period);
  const wallAsUtc = Date.UTC(year, month - 1, 1);
  // Apply the zone's offset, then re-check it at the resulting instant: if a
  // daylight-saving change falls between the two, the second offset is right.
  const firstGuess = wallAsUtc - utcOffsetMs(wallAsUtc, timeZone);
  return new Date(wallAsUtc - utcOffsetMs(firstGuess, timeZone));
};
