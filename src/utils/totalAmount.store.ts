/** In-process only: totalAmount from successful fees response (not persisted to disk). */

let cachedTotalAmount: string | null = null;

export function getTotalAmount(): string | null {
  return cachedTotalAmount;
}

export function setTotalAmount(totalAmount: string): void {
  const v = totalAmount.trim();
  if (!v) return;
  cachedTotalAmount = v;
}
