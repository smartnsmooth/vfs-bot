/** In-process: first slot allocationId from lift-api /appointment/timeslot. */

let allocationId: string | null = null;

export function getAllocationId(): string | null {
  return allocationId;
}

export function setAllocationId(id: string): void {
  const v = id.trim();
  if (!v) return;
  allocationId = v;
}
