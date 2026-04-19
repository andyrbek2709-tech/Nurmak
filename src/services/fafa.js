import { chromium } from "playwright";

const FAFA_URL = "https://fa-fa.kz";
const CHECK_INTERVAL_MS = 3 * 60 * 1000; // 3 minutes

let _bot = null;
let _chatId = null;
let monitorTimer = null;
let seenKeys = new Set();
let isRunning = false;

// Active filters set by the manager via Telegram
const filters = { from: null, to: null, cargo: null };

export function initFafa(bot, chatId) {
  _bot = bot;
  _chatId = chatId;
}

export function isMonitoringActive() { return isRunning; }

export function getFilters() { return { ...filters }; }

export function setFilter(key, value) {
  if (key in filters) filters[key] = value?.trim() || null;
}

export function clearFilters() {
  filters.from = null;
  filters.to = null;
  filters.cargo = null;
}

export async function startMonitoring() {
  if (isRunning) return;
  isRunning = true;
  seenKeys.clear();
  console.log("[FAFA] monitoring started");
  await tick();
}

export function stopMonitoring() {
  isRunning = false;
  if (monitorTimer) { clearTimeout(monitorTimer); monitorTimer = null; }
  seenKeys.clear();
  console.log("[FAFA] monitoring stopped");
}

// ─── Internal ─────────────────────────────────────────────────────────────────

function makeKey(item) {
  return `${item.from}|${item.to}|${item.cargo}|${item.time}`
    .toLowerCase().replace(/\s+/g, "");
}

// Country name → ISO code mapping for filter matching
const COUNTRY_ALIASES = {
  "россия": "RU", "казахстан": "KZ", "беларусь": "BY", "беларуссия": "BY",
  "узбекистан": "UZ", "кыргызстан": "KG", "киргизия": "KG",
  "таджикистан": "TJ", "туркменистан": "TM", "азербайджан": "AZ",
  "грузия": "GE", "армения": "AM", "китай": "CN",
};

function matchesFilters(item) {
  const matches = (field, filterVal) => {
    if (!filterVal) return true;
    const val = field?.toLowerCase() || "";
    const flt = filterVal.toLowerCase();
    if (val.includes(flt)) return true;
    // Try country alias (e.g. "Россия" → "RU")
    const code = COUNTRY_ALIASES[flt];
    if (code && val.includes(code.toLowerCase())) return true;
    return false;
  };
  if (!matches(item.from, filters.from)) return false;
  if (!matches(item.to, filters.to)) return false;
  if (!matches(item.cargo, filters.cargo)) return false;
  return true;
}

async function tick() {
  if (!isRunning) return;
  try {
    const items = await scrape();
    console.log(`[FAFA] fetched ${items.length} items`);

    const fresh = items.filter(i => {
      const k = makeKey(i);
      return k.length > 3 && !seenKeys.has(k);
    });

    const matched = fresh.filter(matchesFilters);

    for (const item of fresh) seenKeys.add(makeKey(item));

    for (const item of matched) {
      await notify(item);
    }

    if (matched.length > 0) console.log(`[FAFA] sent ${matched.length} notifications`);
  } catch (err) {
    console.error("[FAFA] tick error:", err.message);
  }

  if (isRunning) monitorTimer = setTimeout(tick, CHECK_INTERVAL_MS);
}

async function notify(item) {
  if (!_bot || !_chatId) return;
  const filterLine = [
    filters.from ? `🔍 Откуда: ${filters.from}` : null,
    filters.to ? `🔍 Куда: ${filters.to}` : null,
    filters.cargo ? `🔍 Груз: ${filters.cargo}` : null,
  ].filter(Boolean).join(" | ");

  const text = [
    `🚛 Новая заявка (FA-FA)`,
    ``,
    `📍 ${item.from || "—"} → ${item.to || "—"}`,
    `📦 ${item.cargo || "—"}`,
    `⚖ ${item.weight || "—"}`,
    `🕒 ${item.time || "—"}`,
    filterLine || "",
  ].filter(l => l !== "").join("\n");

  await _bot.telegram.sendMessage(_chatId, text.trim()).catch(e =>
    console.error("[FAFA] sendMessage error:", e.message)
  );
}

// ─── Scraper ──────────────────────────────────────────────────────────────────

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
function rand(min, max) { return delay(Math.floor(min + Math.random() * (max - min))); }

async function scrape() {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  try {
    const context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      locale: "ru-RU",
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();

    await page.goto(FAFA_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await rand(1500, 2500);

    // Login if needed
    const hasAuth = await page.$(".user-info, .profile-link, [href*='logout'], [href*='exit'], .lk-link").catch(() => null);
    if (!hasAuth) await doLogin(page);

    // Try to find "НАЙТИ ГРУЗ" public board link (exclude personal "МОИ ГРУЗЫ" / my_loads)
    const cargoLink = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll("a"));
      const match = links.find(a => {
        const href = a.href || "";
        const text = a.textContent?.trim() || "";
        if (/my_loads|my_cargo|мои\s*груз/i.test(href + text)) return false; // skip personal
        return /найти\s*груз|поиск\s*груз/i.test(text) ||
               /\/cargoes\/|\/cargo\/|\/gruz\/|\/search\//i.test(href);
      });
      return match ? { href: match.href, text: match.textContent.trim() } : null;
    });

    if (cargoLink) {
      console.log(`[FAFA] found cargo link: "${cargoLink.text}" → ${cargoLink.href}`);
      await page.goto(cargoLink.href, { waitUntil: "domcontentloaded", timeout: 20000 });
      await rand(1500, 2500);
    } else {
      // Fallback: try known paths
      const cargoPaths = ["/cargoes/", "/cargo/", "/gruz/", "/search/"];
      for (const path of cargoPaths) {
        try {
          const resp = await page.goto(`${FAFA_URL}${path}`, { waitUntil: "domcontentloaded", timeout: 15000 });
          const status = resp?.status();
          console.log(`[FAFA] tried ${path} → status ${status}`);
          if (resp && resp.ok()) break;
        } catch (_) { /* try next */ }
        await rand(500, 800);
      }
    }

    await rand(2000, 3000);
    console.log(`[FAFA] scraping URL: ${page.url()}, title: ${await page.title()}`);

    const items = await extractItems(page);

    // Log first 5 items for debugging selectors
    items.slice(0, 5).forEach((it, i) =>
      console.log(`[FAFA] item[${i}]: from="${it.from}" to="${it.to}" cargo="${it.cargo}" weight="${it.weight}" time="${it.time}"`)
    );

    return items;
  } finally {
    await browser.close();
  }
}

async function doLogin(page) {
  const login = process.env.FAFA_LOGIN;
  const password = process.env.FAFA_PASSWORD;
  if (!login || !password) throw new Error("FAFA_LOGIN / FAFA_PASSWORD env vars missing");

  console.log(`[FAFA] login start, URL: ${page.url()}`);

  // Debug: log all inputs on page
  const inputInfo = await page.evaluate(() =>
    Array.from(document.querySelectorAll("input"))
      .map(i => `type=${i.type} name=${i.name} id=${i.id}`)
      .join(" | ")
  );
  console.log(`[FAFA] inputs: ${inputInfo || "none"}`);

  // Click login link if present (navigate to login page)
  const loginLink = await page.$("a[href*='login'], a[href*='signin'], a[href*='enter'], .login-btn, .btn-login").catch(() => null);
  if (loginLink) {
    await page.evaluate(el => el.click(), loginLink); // JS click to avoid viewport issues
    await rand(1000, 1500);
    console.log(`[FAFA] after login link click, URL: ${page.url()}`);
  }

  // Fill fields via JS evaluate — avoids all Playwright viewport/actionability checks
  // fa-fa.kz uses: name=login (login), name=pass1 (password), name=sbm (submit)
  await page.evaluate(({ l, p }) => {
    const fire = (el, val) => {
      el.focus();
      el.value = val;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    };
    const loginInput = document.querySelector("input[name='login']");
    const passInput = document.querySelector("input[name='pass1'], input[type='password'], input[name='password']");
    if (loginInput) fire(loginInput, l);
    if (passInput) fire(passInput, p);
  }, { l: login, p: password });

  console.log("[FAFA] credentials filled");
  await rand(800, 1200);

  // Submit the LOGIN form specifically (by finding form that contains name=sbm)
  const submitted = await page.evaluate(() => {
    // Target the login submit button specifically
    const sbm = document.querySelector("input[name='sbm']");
    if (sbm) { sbm.click(); return "input[name=sbm].click()"; }
    // Fallback: find form containing pass1 and submit it
    const passInput = document.querySelector("input[name='pass1'], input[type='password']");
    if (passInput?.form) { passInput.form.submit(); return "passInput.form.submit()"; }
    return null;
  });
  console.log(`[FAFA] submit method: ${submitted}`);

  await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
  await rand(2000, 3000);

  const afterUrl = page.url();
  console.log(`[FAFA] login done, URL: ${afterUrl}`);
  if (afterUrl.includes("/login")) {
    throw new Error(`Login failed — redirected back to login page. Check credentials.`);
  }
}

async function extractItems(page) {
  return page.evaluate(() => {
    const results = [];

    // fa-fa.kz /search_load/ structure:
    // Table rows where second column contains a link: "Актау, KZ — Махачкала, RU - 1763 км"
    // Weight/cargo in next column: "22т / 86м³\nНапитки"
    // Date in first column

    const rows = Array.from(document.querySelectorAll("tr")).filter(r => {
      // Must have a link that looks like a route (contains " — ")
      const link = r.querySelector("a");
      return link && link.textContent.includes(" — ");
    });

    for (const row of rows.slice(0, 60)) {
      const cells = Array.from(row.querySelectorAll("td"));
      if (cells.length < 2) continue;

      // Find cell with route link
      const routeCell = cells.find(td => td.querySelector("a")?.textContent.includes(" — "));
      if (!routeCell) continue;

      const routeText = routeCell.querySelector("a")?.textContent?.trim() || "";
      // Parse "Актау, KZ — Махачкала, RU - 1763 км"
      const dashIdx = routeText.indexOf(" — ");
      const from = dashIdx >= 0 ? routeText.substring(0, dashIdx).trim() : "";
      const toRaw = dashIdx >= 0 ? routeText.substring(dashIdx + 3).trim() : "";
      // Remove distance "- 1763 км" from end
      const to = toRaw.replace(/\s*-\s*\d+\s*км.*$/i, "").trim();

      // Date: first cell
      const time = cells[0]?.textContent?.trim().split("\n")[0] || "";

      // Weight + cargo: cell after route cell (or find by pattern "т / м³")
      let weight = "", cargo = "";
      for (const td of cells) {
        const txt = td.textContent || "";
        if (/\d+т\s*\/\s*\d+м³|\d+\s*т/.test(txt)) {
          const lines = txt.trim().split("\n").map(s => s.trim()).filter(Boolean);
          weight = lines[0] || "";
          cargo = lines[1] || "";
          break;
        }
      }

      if (from && to) {
        results.push({ from, to, cargo, weight, time });
      }
    }

    return results;
  });
}
