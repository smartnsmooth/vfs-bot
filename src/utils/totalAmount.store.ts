/** In-process only: totalAmount + currency from successful fees response (not persisted to disk). */

let cachedTotalAmount: string | null = null;
let cachedCurrency: string | null = null;

export function getTotalAmount(): string | null {
  return cachedTotalAmount;
}

export function setTotalAmount(totalAmount: string): void {
  const v = totalAmount.trim();
  if (!v) return;
  cachedTotalAmount = v;
}

export function getCurrency(): string | null {
  return cachedCurrency;
}

export function setCurrency(currency: string): void {
  const v = currency.trim();
  if (!v) return;
  cachedCurrency = v;
}
