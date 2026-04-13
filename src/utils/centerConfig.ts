/**
 * Utility to get center configurations for multi-center polling.
 * Each instance can have up to 2 centers configured.
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
