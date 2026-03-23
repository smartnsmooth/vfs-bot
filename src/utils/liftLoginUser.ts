import { config } from "../config/config";

/** `loginUser` for lift-api bodies: {@link config.slotPayload.loginUser} (form → env), then `config.vfsUsername`. */
export function getEffectiveLiftLoginUser(): string {
  const fromSlot = (config.slotPayload.loginUser || "").trim();
  if (fromSlot) return fromSlot;
  return (config.vfsUsername || process.env.VFS_USERNAME || "").trim();
}
