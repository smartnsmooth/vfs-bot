/** In-process: first calendar date from lift-api /appointment/calendar (for later steps). */

let slotDate: string | null = null;

export function getSlotDate(): string | null {
  return slotDate;
}

export function setSlotDate(date: string): void {
  const d = date.trim();
  if (!d) return;
  slotDate = d;
}
