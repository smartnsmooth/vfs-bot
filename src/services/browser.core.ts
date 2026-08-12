import type { Page } from "playwright";
import type { PostOtpLoginCapture } from "./browser.errors";

export interface BrowserServiceCore {
  getVfsPageOrAnyNonSetup(): Promise<Page | null>;
  getOrCreateNonSetupPage(): Promise<Page>;
  setLastPostOtpLoginResponse(capture: PostOtpLoginCapture | null): void;
}
