const toMinutes = (time: string): number => {
  const [hours, minutes] = time.split(':');
  return Number(hours) * 60 + Number(minutes);
};

/**
 * Whether `now` falls inside the window, in the date's local time. The start
 * minute is inside and the end minute is outside. A window whose start is
 * later than its end runs past midnight; equal times make an empty window.
 */
export const isWithinQuietHours = (now: Date, start: string, end: string): boolean => {
  const from = toMinutes(start);
  const to = toMinutes(end);
  if (from === to) return false;
  const minute = now.getHours() * 60 + now.getMinutes();
  return from < to ? minute >= from && minute < to : minute >= from || minute < to;
};
