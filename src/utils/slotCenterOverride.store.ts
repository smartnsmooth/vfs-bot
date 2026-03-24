/**
 * Runtime overrides for centerCode and visaCategoryCode.
 * When any instance finds a slot, all instances use the founder's center/category.
 */

let overrideCenterCode: string | null = null;
let overrideVisaCategoryCode: string | null = null;

export function setSlotCenterOverride(centerCode: string, visaCategoryCode: string): void {
  overrideCenterCode = centerCode;
  overrideVisaCategoryCode = visaCategoryCode;
}

export function getSlotCenterOverride(): { centerCode: string; visaCategoryCode: string } | null {
  if (!overrideCenterCode || !overrideVisaCategoryCode) return null;
  return { centerCode: overrideCenterCode, visaCategoryCode: overrideVisaCategoryCode };
}

export function clearSlotCenterOverride(): void {
  overrideCenterCode = null;
  overrideVisaCategoryCode = null;
}
