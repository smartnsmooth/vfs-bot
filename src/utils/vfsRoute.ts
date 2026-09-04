/** Active VFS corridor helpers (setup form `countryCode` + `missionCode`). */

function routeCodes(countryCode?: unknown, missionCode?: unknown): { cc: string; mc: string } {
  return {
    cc: String(countryCode ?? "").trim().toLowerCase(),
    mc: String(missionCode ?? "").trim().toLowerCase(),
  };
}

export function isIndDeuRoute(countryCode?: unknown, missionCode?: unknown): boolean {
  const { cc, mc } = routeCodes(countryCode, missionCode);
  return cc === "ind" && mc === "deu";
}

export function isIndLvaRoute(countryCode?: unknown, missionCode?: unknown): boolean {
  const { cc, mc } = routeCodes(countryCode, missionCode);
  return cc === "ind" && mc === "lva";
}

export function isUzbLvaRoute(countryCode?: unknown, missionCode?: unknown): boolean {
  const { cc, mc } = routeCodes(countryCode, missionCode);
  return cc === "uzb" && mc === "lva";
}

export function isAreLvaRoute(countryCode?: unknown, missionCode?: unknown): boolean {
  const { cc, mc } = routeCodes(countryCode, missionCode);
  return cc === "are" && mc === "lva";
}

/** Login emails stay mixed-case on these corridors (not uppercased for lift-api). */
export function keepApplicantEmailCasing(countryCode?: unknown, missionCode?: unknown): boolean {
  return isIndLvaRoute(countryCode, missionCode) || isAreLvaRoute(countryCode, missionCode);
}
