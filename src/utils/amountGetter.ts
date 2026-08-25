/**
 * The amountGetter role.
 *
 * One instance — always Bot #1 — never polls CheckIsSlotAvailable and never books.
 * It logs in, calls applicants for a URN and fees for the totalAmount, and publishes
 * that amount to `calendar-booking-coord.json` so the instances that do find a slot
 * can go straight to schedule instead of spending fees round-robin turns on it.
 *
 * If the amount is not shared by the time a peer holds a URN, the existing fees
 * round-robin in the booking flow still runs — this role only shortens the path.
 *
 * With the setup-form toggle off — or outside cluster mode, where there is no fleet
 * to hand the amount to — Bot #1 is an ordinary polling instance.
 */

import { getApplicantDetailsOverrides } from "./applicantDetails.store";

export const AMOUNT_GETTER_INSTANCE_ID = 1;
export const DEFAULT_AMOUNT_GETTER_ENABLED = true;

/** Setup-form "Amount getter (Bot #1)" toggle. */
export function resolveAmountGetterEnabled(details?: Record<string, unknown> | null): boolean {
  const globalDet = details ?? getApplicantDetailsOverrides(0);
  if (globalDet && typeof globalDet.amountGetterEnabled === "boolean") {
    return globalDet.amountGetterEnabled;
  }
  return DEFAULT_AMOUNT_GETTER_ENABLED;
}

export function isAmountGetterEnabled(): boolean {
  return process.env.BOT_CLUSTER_MODE === "true" && resolveAmountGetterEnabled();
}

export function isAmountGetter(instanceId?: number): boolean {
  const id =
    typeof instanceId === "number" && Number.isFinite(instanceId) && instanceId >= 1
      ? Math.floor(instanceId)
      : 1;
  return id === AMOUNT_GETTER_INSTANCE_ID && isAmountGetterEnabled();
}
