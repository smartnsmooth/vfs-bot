/** Active VFS corridor helpers (setup form `countryCode` + `missionCode`). */

export function isIndDeuRoute(countryCode?: unknown, missionCode?: unknown): boolean {
  return String(countryCode ?? "").trim().toLowerCase() === "ind"
    && String(missionCode ?? "").trim().toLowerCase() === "deu";
}
