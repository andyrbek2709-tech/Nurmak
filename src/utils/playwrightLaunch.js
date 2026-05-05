import { chromium } from "playwright";
import { delay } from "./timing.js";

const LAUNCH_RETRIES = 3;
const LAUNCH_RETRY_DELAY_MS = 4500;

const CHROMIUM_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  // Critical for Docker: prevents Chromium from forking a zygote process.
  // Without this flag Chrome tries to fork() a renderer zygote on startup;
  // in memory-constrained containers (Railway ≤1GB) that fork can fail
  // mid-way and the OS sends SIGTRAP to the whole process group.
  "--no-zygote",
  "--disable-gpu",
  "--disable-software-rasterizer",
  "--disable-extensions",
  // Reduce background activity and memory footprint inside the container.
  "--disable-background-networking",
  "--disable-default-apps",
  "--disable-sync",
  "--mute-audio",
  "--disable-hang-monitor",
  "--disable-prompt-on-repost",
  "--metrics-recording-only",
  "--safebrowsing-disable-auto-update",
];

/**
 * Docker image mcr.microsoft.com/playwright matches playwright npm version — use bundled
 * Chromium only (no `channel:`) to avoid picking a wrong system binary. Retries soften
 * transient OOM / allocator glitches on small Railway instances.
 */
export async function launchChromiumForScrape() {
  let lastErr;
  for (let attempt = 1; attempt <= LAUNCH_RETRIES; attempt++) {
    try {
      const browser = await chromium.launch({
        headless: true,
        chromiumSandbox: false,
        args: CHROMIUM_ARGS,
      });
      if (attempt > 1) {
        console.log(`[PLAYWRIGHT] chromium.launch ok on attempt ${attempt}`);
      }
      return browser;
    } catch (e) {
      lastErr = e;
      console.error(`[PLAYWRIGHT] chromium.launch attempt ${attempt}/${LAUNCH_RETRIES}: ${e.message}`);
      if (attempt < LAUNCH_RETRIES) await delay(LAUNCH_RETRY_DELAY_MS);
    }
  }
  throw lastErr;
}

/** True when the browser process failed to start (not mid-page navigation teardown). */
export function isPlaywrightBrowserFailure(err) {
  const s = String(err?.message || err || "");
  return (
    s.includes("browserType.launch") ||
    s.includes("Failed to launch") ||
    s.includes("SIGTRAP") ||
    s.includes("Chromium distribution") ||
    s.includes("Executable doesn't exist") ||
    s.includes("spawn ENOENT") ||
    s.includes("Browser executable") ||
    s.includes("chromium_headless_shell") ||
    s.includes("looks like Playwright Test or Playwright was just installed") ||
    s.includes("npx playwright install")
  );
}
