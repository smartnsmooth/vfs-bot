/**
 * Utility to get center configurations for multi-center polling.
 * Each instance can have up to 2 centers configured.
 *
 * Polling assignment walks instance ids in order: C1, C2, C1, C2, …
 * If an instance is due for C2 but has none, it polls C1 and the next
 * instance still takes C2 (the C2 turn is not skipped).
 */

import { getApplicantDetailsOverrides } from "./applicantDetails.store.js";

export interface CenterConfig {
  vacCode: string;
  visaCategoryCode: string;
  centerNumber: 1 | 2;
}

/**
 * Get all configured centers for an instance.
 * Returns array of 1-2 centers depending on configuration.
 */
export function getConfiguredCenters(instanceId?: number): CenterConfig[] {
  const centers: CenterConfig[] = [];
  
  const details = getApplicantDetailsOverrides(instanceId);
  
  const vacCode1 = (details?.vacCode as string) || "";
  const visaCategory1 = (details?.selectedSubvisaCategory as string) || "";
  
  if (vacCode1 && visaCategory1) {
    centers.push({
      vacCode: vacCode1,
      visaCategoryCode: visaCategory1,
      centerNumber: 1,
    });
  }
  
  // Center 2 (optional)
  const vacCode2 = details?.vacCode2 as string | undefined;
  const visaCategory2 = details?.selectedSubvisaCategory2 as string | undefined;

  if (vacCode2 && visaCategory2 && vacCode2.trim() !== "" && visaCategory2.trim() !== "") {
    centers.push({
      vacCode: vacCode2,
      visaCategoryCode: visaCategory2,
      centerNumber: 2,
    });
  }
  
  return centers;
}

function instanceHasCenter2(instanceId: number): boolean {
  return getConfiguredCenters(instanceId).some((c) => c.centerNumber === 2);
}

/**
 * Walk ids 1..N: assign C1 then C2. A C2 miss polls C1; the next id still
 * takes C2 if it has one.
 */
export function pickPollingCenterForInstance(
  instanceId: number | undefined,
  centers: CenterConfig[]
): CenterConfig | null {
  if (centers.length === 0) return null;
  const id =
    typeof instanceId === "number" && Number.isFinite(instanceId) && instanceId >= 1
      ? Math.floor(instanceId)
      : 1;
  const center1 = centers.find((c) => c.centerNumber === 1) ?? centers[0]!;
  const center2 = centers.find((c) => c.centerNumber === 2);

  let wantCenter2 = false;
  let assignCenter2 = false;
  for (let i = 1; i <= id; i++) {
    const hasC2 = i === id ? !!center2 : instanceHasCenter2(i);
    if (wantCenter2 && hasC2) {
      assignCenter2 = true;
      wantCenter2 = false;
    } else {
      assignCenter2 = false;
      wantCenter2 = true;
    }
  }

  if (assignCenter2 && center2) return center2;
  return center1;
}
