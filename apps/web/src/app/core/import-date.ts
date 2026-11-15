import { DateTime } from 'luxon';

/** Demo imports explicitly use US dates and Phoenix time unless an ISO offset is supplied. */
export function parseImportDate(value: string): string | null {
  const options = { locale: 'en-US', zone: 'America/Phoenix' };
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value) || /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(value);
  let date: DateTime;
  if (/^\d{1,2}\/\d{1,2}\/\d{4}(?:, (?:0?[1-9]|1[0-2]):[0-5]\d (?:AM|PM))?$/.test(value)) {
    date = DateTime.fromFormat(value, dateOnly ? 'M/d/yyyy' : 'M/d/yyyy, h:mm a', options);
  } else if (/^\d{4}-\d{2}-\d{2}(?:T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:0\d|1[0-3]):[0-5]\d|[+-]14:00))?$/.test(value)) {
    date = DateTime.fromISO(value, { ...options, setZone: true });
  } else return null;
  if (!date.isValid) return null;
  return (dateOnly ? date.set({ hour: 12 }) : date).toISO({ suppressMilliseconds: true });
}
