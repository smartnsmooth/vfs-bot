/** In-process: first calendar date from lift-api /appointment/calendar (for later steps). */

let slotDate: string | null = null;
let calendarDatesCount = 1;

export function getSlotDate(): string | null {
  return slotDate;
}

export function setSlotDate(date: string): void {
  const d = date.trim();
  if (!d) return;
  slotDate = d;
}

export function clearSlotDate(): void {
  slotDate = null;
  calendarDatesCount = 1;
}

export function getCalendarDatesCount(): number {
  return calendarDatesCount;
}

export function setCalendarDatesCount(count: number): void {
  calendarDatesCount = Math.max(1, count);
}
