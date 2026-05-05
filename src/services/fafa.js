import { loadBotSetting, saveBotSetting } from "./supabase.js";
import { launchChromiumForScrape, isPlaywrightBrowserFailure } from "../utils/playwrightLaunch.js";
import { scrapeAtisu } from "./atisu.js";
import { delay, rand } from "../utils/timing.js";
import { trackEvent } from "./controlTower.js";

const FAFA_URL = "https://fa-fa.kz";
const SEARCH_URL = `${FAFA_URL}/search_load/`;
const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const NO_RESULTS_NOTIFY_MS = 60 * 60 * 1000;

let _bot = null;

// Per-user state: chatId → { filters, seenKeys, isRunning, monitorTimer }
const users = new Map();

// Health check state
let consecutiveZeroResults = 0;
const ZERO_RESULTS_ALERT_THRESHOLD = 2; // Alert after 2 consecutive zero results
let consecutiveLaunchFailures = 0;
let lastLaunchAlertAt = 0;
const LAUNCH_ALERT_COOLDOWN_MS = 60 * 60 * 1000;

function emptyFilters() {
  return { from: null, to: null, truck_type: null, weight: null, volume: null };
}

async function getOrInitUser(chatId) {
  const key = String(chatId);
  if (!users.has(key)) {
    const state = { filters: { fafa: emptyFilters(), atisu: emptyFilters() }, seenKeys: new Set(), isRunning: false, monitorTimer: null, lastNoResultsAt: 0 };
    users.set(key, state);
    try {
      const val = await loadBotSetting(`filters_${key}`);
      if (val) {
        const saved = JSON.parse(val);
        // Migration: old format had from/to at top level
        if ("from" in saved || "to" in saved) {
          state.filters = { fafa: Object.assign(emptyFilters(), saved), atisu: emptyFilters() };
        } else {
          state.filters = {
            fafa:  Object.assign(emptyFilters(), saved.fafa  || {}),
            atisu: Object.assign(emptyFilters(), saved.atisu || {}),
          };
        }
        console.log(`[FAFA] filters loaded for ${key}:`, JSON.stringify(state.filters));
      }
    } catch (_) {}
  }
  return users.get(key);
}

export function initFafa(bot) {
  _bot = bot;
  restoreMonitoring();
}

// ─── Monitoring persistence ───────────────────────────────────────────────────

async function saveMonitorList(set) {
  await saveBotSetting("active_monitors", JSON.stringify([...set])).catch(() => {});
}

async function restoreMonitoring() {
  try {
    const raw = await loadBotSetting("active_monitors");
    if (!raw) return;
    const list = JSON.parse(raw);
    if (!list.length) return;
    console.log(`[FAFA] restoring monitoring for ${list.length} users:`, list);
    // Stagger first ticks to avoid concurrent Chromium launches at boot (OOM risk on Railway)
    for (let i = 0; i < list.length; i++) {
      const chatId = String(list[i]);
      const u = await getOrInitUser(chatId);
      if (u.isRunning) continue;
      u.isRunning = true;
      u.seenKeys.clear();
      u.lastNoResultsAt = Date.now();
      const delayMs = 30000 + i * 60000;
      u.monitorTimer = setTimeout(() => tick(chatId), delayMs);
      console.log(`[FAFA] monitoring restored for ${chatId} (first check in ${delayMs / 1000}s)`);
    }
  } catch (err) {
    console.error("[FAFA] restoreMonitoring error:", err.message);
  }
}

export async function isMonitoringActive(chatId) {
  const u = await getOrInitUser(chatId);
  return u.isRunning;
}

export async function getFilters(chatId) {
  const u = await getOrInitUser(chatId);
  return { ...u.filters };
}

export async function setFilter(chatId, site, field, value) {
  const u = await getOrInitUser(chatId);
  if ((site === "fafa" || site === "atisu") && field in u.filters[site]) {
    u.filters[site][field] = value?.trim() || null;
    saveBotSetting(`filters_${chatId}`, JSON.stringify(u.filters)).catch(() => {});
  }
}

export async function clearFilters(chatId) {
  const u = await getOrInitUser(chatId);
  u.filters = { fafa: emptyFilters(), atisu: emptyFilters() };
  saveBotSetting(`filters_${chatId}`, JSON.stringify(u.filters)).catch(() => {});
}

export async function startMonitoring(chatId) {
  const u = await getOrInitUser(chatId);
  if (u.isRunning) return;
  u.isRunning = true;
  u.seenKeys.clear();
  u.lastNoResultsAt = Date.now();
  // Persist active monitor list
  const raw = await loadBotSetting("active_monitors").catch(() => null);
  const list = new Set(raw ? JSON.parse(raw) : []);
  list.add(String(chatId));
  await saveMonitorList(list);
  console.log(`[FAFA] monitoring started for ${chatId}`);
  await tick(chatId);
}

export async function stopMonitoring(chatId) {
  const u = users.get(String(chatId));
  if (!u) return;
  u.isRunning = false;
  if (u.monitorTimer) { clearTimeout(u.monitorTimer); u.monitorTimer = null; }
  u.seenKeys.clear();
  // Remove from persisted list
  const raw = await loadBotSetting("active_monitors").catch(() => null);
  const list = new Set(raw ? JSON.parse(raw) : []);
  list.delete(String(chatId));
  await saveMonitorList(list);
  console.log(`[FAFA] monitoring stopped for ${chatId}`);
}

export async function runOnce(chatId) {
  const u = await getOrInitUser(chatId);
  console.log(`[FAFA] running one-time search for ${chatId}...`);
  try {
    const items = await scrape(u.filters.fafa, u.filters.atisu);
    console.log(`[FAFA] one-time: fetched ${items.length} items`);
    const matched = items.filter(item => {
      const f = item.source === "fafa" ? u.filters.fafa : u.filters.atisu;
      return matchesFilters(item, f);
    });
    console.log(`[FAFA] one-time: matched ${matched.length} items`);

    // [CT] track each found order
    for (const item of matched) {
      trackEvent("order_found", {
        chatId,
        from: item.from,
        to: item.to,
        cargo: item.cargo,
        truck_type: item.truck_type,
        price: item.price,
        source: item.source || "search",
        isMonitor: false,
      });
    }

    return matched;
  } catch (err) {
    console.error("[FAFA] runOnce error:", err.message);
    throw err;
  }
}

// ─── Filtering ────────────────────────────────────────────────────────────────

const COUNTRY_ALIASES = {
  "россия": "RU", "казахстан": "KZ", "беларусь": "BY", "беларусия": "BY",
  "узбекистан": "UZ", "кыргызстан": "KG", "киргизия": "KG",
  "таджикистан": "TJ", "туркменистан": "TM", "азербайджан": "AZ",
  "грузия": "GE", "армения": "AM", "китай": "CN",
};

function parseRange(str) {
  if (!str) return { min: null, max: null };
  const dash = str.match(/(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)/);
  if (dash) return { min: parseFloat(dash[1]), max: parseFloat(dash[2]) };
  const single = str.match(/(\d+(?:\.\d+)?)/);
  // Single number = maximum: "5" means "up to 5"
  return single ? { min: null, max: parseFloat(single[1]) } : { min: null, max: null };
}

function parseItemWeight(weightStr) {
  if (!weightStr) return { tons: null, m3: null };
  const t = weightStr.match(/(\d+(?:\.\d+)?)\s*т/);
  const m = weightStr.match(/(\d+(?:\.\d+)?)\s*м/);
  return { tons: t ? parseFloat(t[1]) : null, m3: m ? parseFloat(m[1]) : null };
}

function matchesFilters(item, filters) {
  const matches = (field, filterVal) => {
    if (!filterVal) return true;
    const val = (field || "").toLowerCase();
    const flt = filterVal.toLowerCase();

    if (val.includes(flt)) return true;

    const commaIdx = flt.indexOf(",");
    const cityPart    = commaIdx >= 0 ? flt.substring(0, commaIdx).trim() : flt;
    const countryPart = commaIdx >= 0 ? flt.substring(commaIdx + 1).trim()  : flt;

    if (cityPart && val.includes(cityPart)) return true;

    const code = COUNTRY_ALIASES[countryPart];
    if (code && val.includes(code.toLowerCase())) return true;
    if (countryPart !== cityPart && val.includes(countryPart)) return true;

    return false;
  };
  if (!matches(item.from, filters.from)) return false;
  if (!matches(item.to, filters.to)) return false;
  if (filters.truck_type) {
    const types = filters.truck_type.split(",").map(t => t.trim()).filter(Boolean);
    if (types.length > 0 && !types.some(t => matches(item.truck_type, t))) return false;
  }
  if (filters.weight || filters.volume) {
    const { tons, m3 } = parseItemWeight(item.weight);
    if (filters.weight && tons !== null) {
      const { min, max } = parseRange(filters.weight);
      if (min !== null && tons < min) return false;
      if (max !== null && tons > max) return false;
    }
    if (filters.volume && m3 !== null) {
      const { min, max } = parseRange(filters.volume);
      if (min !== null && m3 < min) return false;
      if (max !== null && m3 > max) return false;
    }
  }
  return true;
}

// ─── Tick / notify ────────────────────────────────────────────────────────────

function makeKey(item) {
  return `${item.source || ""}|${item.from}|${item.to}|${item.cargo}|${item.time}`
    .toLowerCase().replace(/\s+/g, "");
}

async function tick(chatId) {
  const u = users.get(String(chatId));
  if (!u || !u.isRunning) return;
  try {
    const items = await scrape(u.filters.fafa, u.filters.atisu);
    console.log(`[FAFA] fetched ${items.length} items for ${chatId}`);

    const freshWithKeys = items
      .map(i => [i, makeKey(i)])
      .filter(([, k]) => k.length > 3 && !u.seenKeys.has(k));
    const matched = freshWithKeys
      .filter(([item]) => {
        const f = item.source === "fafa" ? u.filters.fafa : u.filters.atisu;
        return matchesFilters(item, f);
      })
      .map(([item]) => item);

    for (const [, k] of freshWithKeys) {
      if (u.seenKeys.size >= 5000) u.seenKeys.clear();
      u.seenKeys.add(k);
    }

    if (matched.length > 0) {
      for (const item of matched) {
        await notify(item, chatId, true);

        // [CT] track each new cargo found during monitoring
        trackEvent("order_found", {
          chatId,
          from: item.from,
          to: item.to,
          cargo: item.cargo,
          truck_type: item.truck_type,
          price: item.price,
          source: item.source || "monitor",
          isMonitor: true,
        });
      }
      u.lastNoResultsAt = Date.now();
      console.log(`[FAFA] sent ${matched.length} notifications to ${chatId}`);
    } else if (Date.now() - u.lastNoResultsAt >= NO_RESULTS_NOTIFY_MS) {
      u.lastNoResultsAt = Date.now();
      const fafaN = items.filter(i => i.source === "fafa").length;
      const atisuN = items.filter(i => i.source === "atisu").length;
      const msg =
        "🔍 За последний час новых объявлений по вашим фильтрам не появилось.\n\n" +
        "Мониторинг активен: проверка каждые 5 минут — как только появится новое, пришлю сразу.\n\n" +
        `(тех. сводка: с сайтов пришло ${items.length} строк выдачи, новых для вас — 0; FA-FA.KZ ${fafaN}, ATI.SU ${atisuN})`;
      await _bot.telegram.sendMessage(chatId, msg).catch(e =>
        console.error("[FAFA] sendMessage error:", e.message)
      );
    }

    console.log(
      `[FAFA] tick ${chatId} scraped=${items.length} fresh=${freshWithKeys.length} matched=${matched.length}`
    );
  } catch (err) {
    console.error("[FAFA] tick error:", err.message);
  }
  if (u.isRunning) u.monitorTimer = setTimeout(() => tick(chatId), CHECK_INTERVAL_MS);
}

async function notify(item, chatId, isNew = false) {
  if (!_bot) return;
  const text = buildMessage(item, { isNew });
  await _bot.telegram.sendMessage(chatId, text).catch(e =>
    console.error("[FAFA] sendMessage error:", e.message)
  );
}

export function buildMessage(item, opts = {}) {
  const site = item.source === "atisu" ? "ATI.SU" : "FA-FA.KZ";
  const header = opts.isNew ? `🆕 Новое направление (${site})` : ` —🚛 Заявка ${site}`;
  const distPart = item.distance ? ` (${item.distance})` : "";
  return [
    header,
    ``,
    `📍 ${item.from || "—"} → ${item.to || "—"}${distPart}`,
    `📦 ${item.cargo || "—"}`,
    `🚛 ${item.truck_type || "—"}`,
    `⚖ ${item.weight || "—"}`,
    item.price ? `💰 ${item.price}` : null,
    `🕒 ${item.time || "—"}`,
  ].filter(l => l !== null).join("\n");
}

// ─── Scraper ──────────────────────────────────────────────────────────────────

// Global mutex: only one scrape at a time across all users (Chromium is RAM-heavy)
let scrapeChain = Promise.resolve();
async function scrape(fafaFilters, atisuFilters) {
  const prev = scrapeChain;
  let release;
  scrapeChain = new Promise(r => { release = r; });
  try {
    await prev.catch(() => {});
    return await scrapeInternal(fafaFilters, atisuFilters);
  } finally {
    release();
  }
}

async function applyLaunchFailureTracking(launchFailureDetected) {
  if (launchFailureDetected) {
    consecutiveLaunchFailures++;
    const now = Date.now();
    if (consecutiveLaunchFailures >= 2 && now - lastLaunchAlertAt > LAUNCH_ALERT_COOLDOWN_MS && _bot) {
      lastLaunchAlertAt = now;
      const managerId = String(process.env.MANAGER_CHAT_ID || "");
      if (managerId) {
        await _bot.telegram.sendMessage(
          managerId,
          "⚠️ Alert: Playwright browser launch failed repeatedly. Check Railway logs for SIGTRAP / browserType.launch errors."
        ).catch(() => {});
      }
    }
  } else {
    consecutiveLaunchFailures = 0;
  }
}

async function scrapeInternal(fafaFilters, atisuFilters) {
  const items = [];
  const timestamp = new Date().toISOString();
  let launchFailureDetected = false;

  let browser = null;
  try {
    browser = await launchChromiumForScrape();
  } catch (err) {
    console.error(`[${timestamp}] [SCRAPE] chromium launch failed:`, err.message);
    if (isPlaywrightBrowserFailure(err)) launchFailureDetected = true;
    await applyLaunchFailureTracking(launchFailureDetected);
    if (items.length === 0) {
      consecutiveZeroResults++;
      console.warn(`[${timestamp}] [HEALTH] Zero items returned. Consecutive: ${consecutiveZeroResults}`);
    } else {
      consecutiveZeroResults = 0;
    }
    console.log(`[${timestamp}] [SCRAPE_SUMMARY] Total: 0 items (launch failed)`);
    return [];
  }

  // One browser per cycle: halves RAM spikes vs FA-FA + ATI launching separately.
  try {
    try {
      const fafaItems = await scrapeFafa(fafaFilters, browser);
      items.push(...fafaItems.map(i => ({ ...i, source: "fafa" })));
      console.log(`[${timestamp}] [SCRAPE_SUMMARY] FA-FA.KZ: ${fafaItems.length} items | filters:`, JSON.stringify(fafaFilters));
    } catch (err) {
      console.error(`[${timestamp}] [SCRAPE] fafa error:`, err.message);
      if (isPlaywrightBrowserFailure(err)) launchFailureDetected = true;
    }

    try {
      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("scrapeAtisu timeout 120s")), 120000)
      );
      const atisuItems = await Promise.race([scrapeAtisu(atisuFilters, browser), timeout]);
      items.push(...atisuItems.map(i => ({ ...i, source: "atisu" })));
      console.log(`[${timestamp}] [SCRAPE_SUMMARY] ATI.SU: ${atisuItems.length} items | filters:`, JSON.stringify(atisuFilters));
    } catch (err) {
      console.error(`[${timestamp}] [SCRAPE] atisu error:`, err.message);
      if (isPlaywrightBrowserFailure(err)) launchFailureDetected = true;
    }
  } finally {
    await browser.close().catch(() => {});
  }

  await applyLaunchFailureTracking(launchFailureDetected);

  // Track zero results for health check
  if (items.length === 0) {
    consecutiveZeroResults++;
    console.warn(`[${timestamp}] [HEALTH] Zero items returned. Consecutive: ${consecutiveZeroResults}`);
  } else {
    consecutiveZeroResults = 0;
  }

  console.log(`[${timestamp}] [SCRAPE_SUMMARY] Total: ${items.length} items (${items.filter(i => i.source === "fafa").length} FA-FA + ${items.filter(i => i.source === "atisu").length} ATI.SU)`);
  return items;
}

async function scrapeFafa(filters, sharedBrowser = null) {
  // Hard 90s cap — protects the global mutex so ATI.SU always gets its turn
  const hardTimeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("scrapeFafa hard timeout 90s")), 90000)
  );
  return Promise.race([_scrapeFafa(filters, sharedBrowser), hardTimeout]);
}

async function _scrapeFafa(filters, sharedBrowser = null) {
  const ownsBrowser = !sharedBrowser;
  const browser = sharedBrowser || (await launchChromiumForScrape());

  try {
    const context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      locale: "ru-RU",
      viewport: { width: 1280, height: 900 },
    });
    // Block images/fonts/media — saves ~40-60% RAM per page load; not needed for DOM scraping.
    await context.route("**/*", (route) => {
      const t = route.request().resourceType();
      if (t === "image" || t === "media" || t === "font") {
        route.abort().catch(() => {});
      } else {
        route.continue().catch(() => {});
      }
    });
    const page = await context.newPage();

    // Go to search page directly — it will show login form if not authenticated
    await page.goto(SEARCH_URL, { waitUntil: "domcontentloaded", timeout: 20000 });
    await rand(1500, 2000);

    // If login form is present we are not authenticated (each scrape uses a fresh browser context).
    const hasLoginForm = await page.$("input[name='login'], input[name='pass1']").catch(() => null);
    const hasFafaCreds = !!(process.env.FAFA_LOGIN && process.env.FAFA_PASSWORD);

    if (hasLoginForm && hasFafaCreds) {
      try {
        await doLogin(page);
        console.log("[FAFA] login successful");
        // Login often redirects away from /search_load/ — form fields #search1 / #search10 live only there.
        if (!page.url().includes("/search_load")) {
          await page.goto(SEARCH_URL, { waitUntil: "domcontentloaded", timeout: 20000 });
          await rand(1500, 2000);
          console.log(`[FAFA] returned to search after login: ${page.url()}`);
        }
      } catch (e) {
        console.error(`[FAFA] login failed with credentials set — skipping FA-FA scrape: ${e.message}`);
        return [];
      }
    } else if (hasLoginForm) {
      console.log("[FAFA] login form present but no credentials — searching anonymously");
    } else {
      console.log("[FAFA] no login form on search page — proceeding without auth step");
    }

    await fillSearchForm(page, filters);

    await rand(2000, 3000);
    console.log(`[FAFA] scraping URL: ${page.url()}, title: ${await page.title()}`);

    let items = await extractItems(page);
    console.log(`[FAFA] extractItems: ${items.length} items`);
    items.slice(0, 5).forEach((it, i) =>
      console.log(`[FAFA] item[${i}]: from="${it.from}" to="${it.to}" truck="${it.truck_type}"`)
    );

    // Retry once with shortened city tokens when users type "city + region" in one field
    // (example: "Актау Мангистау, Казахстан"), which can produce blank=1 on FA-FA.
    if (items.length === 0) {
      const shortFrom = shortenCityToken(filters.from);
      const shortTo = shortenCityToken(filters.to);
      const shouldRetry =
        (shortFrom && shortFrom !== filters.from?.split(",")[0]?.trim()) ||
        (shortTo && shortTo !== filters.to?.split(",")[0]?.trim());

      if (shouldRetry) {
        const retryFilters = {
          ...filters,
          from: shortFrom ? `${shortFrom}, ` : filters.from,
          to: shortTo ? `${shortTo}, ` : filters.to,
        };
        console.log(`[FAFA] retry with shortened terms: from="${shortFrom || "-"}" to="${shortTo || "-"}"`);
        await page.goto(SEARCH_URL, { waitUntil: "domcontentloaded", timeout: 20000 });
        await rand(1000, 1500);
        await fillSearchForm(page, retryFilters);
        await rand(1500, 2500);
        items = await extractItems(page);
        console.log(`[FAFA] retry extractItems: ${items.length} items`);
      }
    }

    return items;
  } finally {
    if (ownsBrowser) await browser.close().catch(() => {});
  }
}

function shortenCityToken(value) {
  if (!value) return null;
  const cityPart = value.split(",")[0].trim();
  if (!cityPart || !cityPart.includes(" ")) return cityPart || null;
  const first = cityPart.split(/\s+/)[0]?.trim();
  return first || cityPart;
}

async function fillSearchForm(page, filters) {
  const hasFilters = filters.from || filters.to || filters.truck_type;
  if (!hasFilters) return;

  console.log(`[FAFA] fillSearchForm: from="${filters.from}" to="${filters.to}"`);

  const typeAndPickSuggestion = async (inputId, value) => {
    // Use Playwright's native fill method (simulates actual typing, triggers events properly)
    const input = page.locator(`#${inputId}`);

    try {
      await input.waitFor({ timeout: 3000 });
      await input.fill("");  // Clear first
      await input.fill(value);  // Fill with proper event simulation
      console.log(`[FAFA] filled #${inputId}: "${value}"`);
    } catch (e) {
      console.log(`[FAFA] #${inputId}: ERROR - ${e.message}`);
      return null;
    }

    // Wait briefly for any autocomplete to appear (optional)
    await rand(300, 700);

    // Try to click autocomplete if it appears, but don't fail if it doesn't
    try {
      const av1 = await page.$("div.av1").catch(() => null);
      if (av1) {
        await page.locator("div.av1").first().click({ timeout: 2000 }).catch(() => {});
        console.log(`[FAFA] #${inputId}: clicked autocomplete suggestion`);
        await rand(300, 500);
      } else {
        console.log(`[FAFA] #${inputId}: no autocomplete, proceeding with text value`);
      }
    } catch (_) {
      console.log(`[FAFA] #${inputId}: autocomplete click failed, continuing anyway`);
    }

    return value;
  };

  // FA-FA.KZ accepts plain text in both fields (city or country) — no need to skip countries.
  // Server filters by the typed text directly, e.g. city_end="Россия" → routes Актау→RU only.
  const cityFrom = filters.from ? filters.from.split(",")[0].trim() : null;
  const cityTo   = filters.to   ? filters.to.split(",")[0].trim()   : null;
  if (cityFrom) await typeAndPickSuggestion("search1",  cityFrom);
  if (cityTo)   await typeAndPickSuggestion("search10", cityTo);

  if (filters.truck_type) {
    await page.evaluate((t) => {
      const sel = document.querySelector("select[name='car_type'], select");
      if (!sel) return;
      const opt = Array.from(sel.options).find(o => o.text.toLowerCase().includes(t.toLowerCase()));
      if (opt) sel.value = opt.value;
    }, filters.truck_type).catch(() => {});
  }

  await page.evaluate(() => {
    const btn = document.querySelector("input[name='load_search']");
    if (btn) btn.click();
  });
  console.log("[FAFA] search submitted");

  await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
  try { await page.waitForSelector("tr td a", { timeout: 10000 }); } catch (_) {}
  await rand(800, 1200);
  console.log(`[FAFA] search done, URL: ${page.url()}`);
}

async function doLogin(page) {
  const login = process.env.FAFA_LOGIN;
  const password = process.env.FAFA_PASSWORD;
  if (!login || !password) throw new Error("FAFA_LOGIN / FAFA_PASSWORD env vars missing");

  console.log(`[FAFA] login start, URL: ${page.url()}, login: ${login}`);

  // Use Playwright's native fill methods (more reliable than manual event dispatch)
  const loginInput = page.locator("input[name='login']");
  const passInput = page.locator("input[name='pass1']");

  try {
    await loginInput.waitFor({ timeout: 5000 });
    await loginInput.fill(login);
    console.log("[FAFA] login field filled");
  } catch (e) {
    throw new Error(`Login input not found: ${e.message}`);
  }

  try {
    await passInput.waitFor({ timeout: 5000 });
    await passInput.fill(password);
    console.log("[FAFA] password field filled");
  } catch (e) {
    throw new Error(`Password input not found: ${e.message}`);
  }

  await rand(500, 800);

  // Submit form by clicking the submit button
  const submitBtn = page.locator("input[name='sbm']");
  try {
    await submitBtn.waitFor({ timeout: 3000 });
    await submitBtn.click();
    console.log("[FAFA] submit button clicked");
  } catch (e) {
    throw new Error(`Submit button not found: ${e.message}`);
  }

  // Wait for page to load after login
  await Promise.race([
    page.waitForNavigation({ timeout: 10000 }).catch(() => {}),
    page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {}),
  ]);
  await rand(1000, 2000);

  const afterUrl = page.url();
  console.log(`[FAFA] login done, URL: ${afterUrl}`);

  // Check if we got an error message on the page
  const errorMsg = await page.locator("body").innerText().catch(() => "");
  if (errorMsg.includes("неправильный") || errorMsg.includes("ошибк") || afterUrl.includes("/login")) {
    throw new Error("Login failed — credentials rejected or still on login page");
  }
}

async function extractItems(page) {
  return page.evaluate(() => {
    const SEPS = ["→", "–", "—"];
    const JUNK = /выход|кабинет|справка|telegram|copyright|реклам|отмечен|главная|мои\s*груз|мои\s*маш|найти\s*груз|найти\s*маш/i;

    function splitRoute(txt) {
      for (const sep of SEPS) {
        const idx = txt.indexOf(sep);
        if (idx >= 0) {
          const from = txt.substring(0, idx).trim();
          const rest = txt.substring(idx + sep.length).trim();
          const distMatch = rest.match(/-\s*([\d\s]+\s*км)/i);
          const distance = distMatch ? distMatch[1].replace(/\s+/g, " ").trim() : "";
          const to = rest.replace(/\s*-\s*[\d\s]+\s*км.*$/i, "").trim();
          return { from, to, distance };
        }
      }
      return null;
    }

    const results = [];

    const routeLinks = Array.from(document.querySelectorAll("a")).filter(a => {
      const txt = a.textContent;
      return SEPS.some(s => txt.includes(s));
    });

    for (const link of routeLinks) {
      const route = splitRoute(link.textContent.trim());
      if (!route || !route.from || !route.to) continue;
      if (JUNK.test(route.from) || JUNK.test(route.to)) continue;
      if (route.from.length > 80 || route.to.length > 80) continue;

      let row = link.parentElement;
      while (row && row.tagName !== "TR") row = row.parentElement;
      if (!row) continue;

      const cells = Array.from(row.querySelectorAll("td"));
      const dateCell = cells.find(td => /\d{2}\.\d{2}/.test(td.innerText || ""));
      const time = dateCell?.innerText?.trim().split("\n")[0] || "";

      let trCell = link.parentElement;
      while (trCell && trCell.tagName !== "TD") trCell = trCell.parentElement;
      const cellLines = (trCell?.innerText || "").trim().split("\n").map(s => s.trim()).filter(Boolean);
      const truck_type = cellLines.find(l => /тент|рефр|изот|борт|Шонт|цист|гюль|отк/i.test(l)) || cellLines[1] || "";

      const dateCellLines = (dateCell?.innerText || "").trim().split("\n").map(s => s.trim()).filter(Boolean);
      const price = dateCellLines.find(l => /руб|тенге|карт|нал/i.test(l)) || "";

      let weight = "", cargo = "";
      for (const td of cells) {
        const txt = td.innerText || "";
        if (/\d+\s*т[^а-я]/i.test(txt) || /\d+\s*м[³3]/.test(txt)) {
          const lines = txt.trim().split("\n").map(s => s.trim()).filter(s => s && s.length < 60);
          weight = lines[0] || "";
          cargo = lines.find(l => l !== weight && !/^\d/.test(l) && !JUNK.test(l)) || "";
          break;
        }
      }

      results.push({ from: route.from, to: route.to, distance: route.distance || "", cargo, weight, truck_type, time, price });
    }

    const seen = new Set();
    return results.filter(it => {
      const k = `${it.from}|${it.to}|${it.time}|${it.truck_type}`.toLowerCase().replace(/\s /g, "");
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  });
}

// ─── Health Check ──────────────────────────────────────────────────────────────

export async function startHealthCheck(bot, managerId) {
  // Run health check every 60 minutes
  const interval = setInterval(async () => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [HEALTH_CHECK] Starting health check...`);

    try {
      // Test with known stable filters: Актау (Kazakhstan) → Москва (Russia)
      const testFilters = { from: "Актау", to: "Москва", truck_type: null, weight: null, volume: null };
      const items = await scrape(testFilters, testFilters);

      if (items.length === 0) {
        consecutiveZeroResults++;
        console.warn(`[${timestamp}] [HEALTH_CHECK] FAILED: Zero items. Consecutive: ${consecutiveZeroResults}`);

        // Alert manager if threshold reached
        if (consecutiveZeroResults === ZERO_RESULTS_ALERT_THRESHOLD) {
          const msg = `⚠️ <b>Scraper Health Alert</b>\n\nHealth check failed 2 times in a row. Both FA-FA.KZ and ATI.SU returning 0 results on test query.\n\n<code>Filters: ${JSON.stringify(testFilters)}</code>\n\n⏰ Check logs at Railway dashboard.`;
          try {
            await bot.telegram.sendMessage(managerId, msg, { parse_mode: "HTML" });
          } catch (e) {
            console.error(`[${timestamp}] [HEALTH_CHECK] Failed to send alert:`, e.message);
          }
        }
      } else {
        consecutiveZeroResults = 0;
        console.log(`[${timestamp}] [HEALTH_CHECK] OK: ${items.length} items found`);
      }
    } catch (err) {
      console.error(`[${timestamp}] [HEALTH_CHECK] Error during health check:`, err.message);
    }
  }, 60 * 60 * 1000); // 60 minutes

  // Graceful shutdown
  process.on("exit", () => clearInterval(interval));
}
