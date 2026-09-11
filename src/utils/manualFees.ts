/**
 * Setup-form override for appointment fees: skip POST /appointment/fees and use
 * the amount + currency entered on the form instead.
 *
 * Stored on instance 0 (global bot configuration), same as poll interval.
 */

import { getApplicantDetailsOverrides, setApplicantDetailsOverrides } from "./applicantDetails.store";
import { setTotalAmount, setCurrency, getTotalAmount, getCurrency } from "./totalAmount.store";
import { getCurrentInstanceId } from "../config/config";
import { replaceSharedFees } from "./calendarBookingCoord";

export const MANUAL_FEE_CURRENCIES = [
  "INR",
  "EUR",
  "USD",
  "GBP",
  "AED",
  "UZS",
  "SAR",
  "EGP",
  "BGN",
] as const;

export type ManualFeeCurrency = (typeof MANUAL_FEE_CURRENCIES)[number];

export const ROUTE_MANUAL_FEE_DEFAULTS: Record<string, { amount: string; currency: ManualFeeCurrency }> = {
  "ind-bgr": { amount: "0", currency: "EUR" },
  "ind-lva": { amount: "0", currency: "EUR" },
  "ind-deu": { amount: "0", currency: "INR" },
  "egy-prt": { amount: "0", currency: "EUR" },
  "sau-prt": { amount: "169.09", currency: "SAR" },
  "uzb-lva": { amount: "0", currency: "UZS" },
  "are-lva": { amount: "0", currency: "AED" },
};

const FALLBACK_FEE_DEFAULT = { amount: "0", currency: "EUR" as ManualFeeCurrency };

const CURRENCY_SET = new Set<string>(MANUAL_FEE_CURRENCIES);

export function isManualFeeCurrency(value: string): value is ManualFeeCurrency {
  return CURRENCY_SET.has(value);
}

export function getRouteManualFeeDefaults(
  countryCode?: unknown,
  missionCode?: unknown,
): { amount: string; currency: ManualFeeCurrency } {
  const cc = String(countryCode ?? "").trim().toLowerCase();
  const mc = String(missionCode ?? "").trim().toLowerCase();
  return ROUTE_MANUAL_FEE_DEFAULTS[`${cc}-${mc}`] ?? FALLBACK_FEE_DEFAULT;
}

function readGlobalDetails(): Record<string, unknown> {
  return getApplicantDetailsOverrides(0) ?? getApplicantDetailsOverrides(1) ?? {};
}

function currentRouteKey(): string {
  const id = getCurrentInstanceId();
  const inst = id != null ? getApplicantDetailsOverrides(id) : null;
  const g = readGlobalDetails();
  const src = inst ?? g;
  const cc = String(src.countryCode ?? g.countryCode ?? "").trim().toLowerCase();
  const mc = String(src.missionCode ?? g.missionCode ?? "").trim().toLowerCase();
  return cc && mc ? `${cc}-${mc}` : "";
}

function feeRowFromMap(map: unknown, routeKey: string): { amount: string; currency: string } | null {
  if (!routeKey || !map || typeof map !== "object") return null;
  const row = (map as Record<string, unknown>)[routeKey];
  if (!row || typeof row !== "object") return null;
  const rec = row as Record<string, unknown>;
  const amount = rec.amount != null ? String(rec.amount).replace(/,/g, "").trim() : "";
  const currency = rec.currency != null ? String(rec.currency).trim().toUpperCase() : "";
  if (!amount && !currency) return null;
  return { amount, currency };
}

/** True when the setup-form switch is on (skip Fees API). */
export function isUseManualFeesEnabled(): boolean {
  return readGlobalDetails().useManualFees === true;
}

function resolvedManualFeeValues(): { amount: string; currency: string } {
  const g = readGlobalDetails();
  const routeKey = currentRouteKey();
  const fromMap = feeRowFromMap(g.manualFeeValues, routeKey);
  const parts = routeKey.split("-");
  const defaults = getRouteManualFeeDefaults(parts[0], parts.slice(1).join("-"));
  const amount = String(fromMap?.amount || g.manualTotalAmount || defaults.amount || "")
    .replace(/,/g, "")
    .trim();
  const currency = String(fromMap?.currency || g.manualCurrency || defaults.currency || "")
    .trim()
    .toUpperCase();
  return { amount, currency };
}

/** Current Fees API switch + amount/currency for the Monitor tab. */
export function readManualFeesControl(): {
  useManualFees: boolean;
  manualTotalAmount: string;
  manualCurrency: string;
} {
  const resolved = resolvedManualFeeValues();
  return {
    useManualFees: isUseManualFeesEnabled(),
    manualTotalAmount: resolved.amount,
    manualCurrency: resolved.currency,
  };
}

/**
 * Latch setup-form amount + currency into the in-process store.
 * Returns true when manual mode is on and values were applied.
 * Throws when the switch is on but amount/currency are missing or invalid.
 */
export function applyManualFeesFromSetup(): boolean {
  if (!isUseManualFeesEnabled()) return false;

  const { amount, currency } = resolvedManualFeeValues();
  if (!amount || !Number.isFinite(Number.parseFloat(amount))) {
    throw new Error("Setup form totalAmount is missing or not numeric");
  }
  if (!currency || !isManualFeeCurrency(currency)) {
    throw new Error("Setup form currency is missing or not in the allowed list");
  }
  setTotalAmount(amount);
  setCurrency(currency);
  return true;
}

function applyLiveManualFeesToFleet(): void {
  if (!applyManualFeesFromSetup()) return;
  const amount = getTotalAmount();
  if (!amount) return;
  replaceSharedFees({ totalAmount: amount, currency: getCurrency() });
}

/**
 * Persist Fees API switch + amount/currency on instance 0 and, when manual
 * mode is on, overwrite the in-process store and shared fleet fees immediately.
 */
export function persistManualFeesFromMonitor(input: {
  useManualFees: boolean;
  amount: string;
  currency: string;
}): { ok: true } | { ok: false; error: string } {
  const amount = String(input.amount ?? "").replace(/,/g, "").trim();
  const currency = String(input.currency ?? "").trim().toUpperCase();

  if (input.useManualFees) {
    if (!amount || !Number.isFinite(Number.parseFloat(amount))) {
      return { ok: false, error: "Amount must be a number." };
    }
    if (!isManualFeeCurrency(currency)) {
      return { ok: false, error: "Currency is missing or not in the allowed list." };
    }
  } else if (currency && !isManualFeeCurrency(currency)) {
    return { ok: false, error: "Currency is missing or not in the allowed list." };
  }

  const global0: Record<string, unknown> = { ...(getApplicantDetailsOverrides(0) ?? {}) };
  const routeKey = currentRouteKey();
  const prevMap =
    global0.manualFeeValues && typeof global0.manualFeeValues === "object"
      ? (global0.manualFeeValues as Record<string, unknown>)
      : {};
  const manualFeeValues: Record<string, unknown> = { ...prevMap };
  if (routeKey) {
    manualFeeValues[routeKey] = { amount, currency };
  }
  global0.useManualFees = input.useManualFees === true;
  global0.manualTotalAmount = amount;
  global0.manualCurrency = currency;
  global0.manualFeeValues = manualFeeValues;
  setApplicantDetailsOverrides(global0, 0);

  if (input.useManualFees) {
    try {
      applyLiveManualFeesToFleet();
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  return { ok: true };
}
