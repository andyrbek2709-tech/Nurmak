import { chromium } from "playwright";
import { delay } from "./timing.js";

const LAUNCH_RETRIES = 3;
const LAUNCH_RETRY_DELAY_MS = 4500;

const CHROMIUM_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--disable-software-rasterizer",
  "--disable-extensions",
];

/**
 * Railway/Docker: use channel "chromium" (new headless = full browser, not headless_shell).
 * Retries soften transient OOM / brief allocator failures during launch.
 */
export async function launchChromiumForScrape() {
  let lastErr;
  for (let attempt = 1; attempt <= LAUNCH_RETRIES; attempt++) {
    try {
      const browser = await chromium.launch({
        channel: "chromium",
        headless: true,
        chromiumSandbox: false,
        args: CHROMIUM_ARGS,
      });
      if (attempt > 1) console.log(`[PLAYWRIGHT] chromium.launch ok on attempt ${attempt}`);
      return browser;
    } catch (e) {
      lastErr = e;
      console.error(`[PLAYWRIGHT] chromium.launch attempt ${attempt}/${LAUNCH_RETRIES}: ${e.message}`);
      if (attempt < LAUNCH_RETRIES) await delay(LAUNCH_RETRY_DELAY_MS);
    }
  }
  throw lastErr;
}

/** True when the browser process failed to start or died in a launch-like way (for health alerts). */
export function isPlaywrightBrowserFailure(err) {
  const s = String(err?.message || err || "");
  return (
    s.includes("browserType.launch") ||
    s.includes("SIGTRAP") ||
    s.includes("Target page, context or browser has been closed") ||
    s.includes("Browser has been closed") ||
    s.includes("Chromium distribution") ||
    s.includes("Executable doesn't exist") ||
    s.includes("chromium_headless_shell") ||
    s.includes("Browser closed")
  );
}
