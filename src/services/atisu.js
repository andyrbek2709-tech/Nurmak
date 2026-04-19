import { chromium } from "playwright";

const LOGIN_URL  = "https://id.ati.su";
const SEARCH_URL = "https://loads.ati.su/";

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
function rand(min, max) { return delay(Math.floor(min + Math.random() * (max - min))); }

export async function scrapeAtisu(filters) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  try {
    const context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      locale: "ru-RU",
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();

    await page.goto(SEARCH_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await rand(1500, 2000);

    // Check if already logged in
    const needsLogin = await page.evaluate(() =>
      !!document.querySelector("a[href*='login'], a[href*='signin'], [data-test='login-btn']")
      || !document.cookie.includes("atiauth")
    );
    if (needsLogin) await doLogin(page);

    await page.goto(SEARCH_URL, { waitUntil: "networkidle", timeout: 30000 });
    await rand(1000, 1500);

    await fillSearchForm(page, filters);

    await rand(2000, 3000);
    console.log(`[ATISU] scraping URL: ${page.url()}, title: ${await page.title()}`);

    const items = await extractItems(page);
    items.slice(0, 3).forEach((it, i) =>
      console.log(`[ATISU] item[${i}]: from="${it.from}" to="${it.to}" cargo="${it.cargo}" price="${it.price}"`)
    );
    return items;
  } finally {
    await browser.close();
  }
}

async function doLogin(page) {
  const login    = process.env.ATISU_LOGIN;
  const password = process.env.ATISU_PASSWORD;
  if (!login || !password) throw new Error("ATISU_LOGIN / ATISU_PASSWORD env vars missing");

  console.log(`[ATISU] logging in...`);
  await page.goto(LOGIN_URL, { waitUntil: "networkidle", timeout: 30000 });
  await rand(1000, 1500);

  await page.evaluate(({ l, p }) => {
    const fire = (el, val) => {
      el.focus(); el.value = val;
      el.dispatchEvent(new Event("input",  { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    };
    const loginEl = document.querySelector(
      "input[name='login'], input[name='email'], input[type='email'], input[placeholder*='Email'], input[placeholder*='логин'], input[placeholder*='телефон']"
    );
    const passEl = document.querySelector("input[name='password'], input[type='password']");
    if (loginEl) fire(loginEl, l);
    if (passEl)  fire(passEl,  p);
  }, { l: login, p: password });

  await rand(500, 800);

  const submitted = await page.evaluate(() => {
    const btn = document.querySelector("button[type='submit'], input[type='submit'], [data-test='submit-btn']");
    if (btn) { btn.click(); return btn.textContent?.trim() || "btn.click()"; }
    const form = document.querySelector("form");
    if (form) { form.submit(); return "form.submit()"; }
    return null;
  });
  console.log(`[ATISU] login submit: ${submitted}`);

  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  await rand(2000, 3000);

  const afterUrl = page.url();
  console.log(`[ATISU] login done, URL: ${afterUrl}`);

  // Step-2 form (email first, then password on next screen)
  if (afterUrl.includes("id.ati.su")) {
    const passVisible = await page.$("input[type='password']");
    if (passVisible) {
      await page.evaluate(({ p }) => {
        const el = document.querySelector("input[type='password']");
        if (el) {
          el.focus(); el.value = p;
          el.dispatchEvent(new Event("input",  { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }, { p: password });
      await rand(400, 600);
      await page.evaluate(() => {
        const btn = document.querySelector("button[type='submit'], input[type='submit']");
        if (btn) btn.click();
      });
      await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
      await rand(1500, 2000);
      console.log(`[ATISU] login step-2 done, URL: ${page.url()}`);
    }
  }
}

async function fillSearchForm(page, filters) {
  if (!filters.from && !filters.to) return;
  console.log(`[ATISU] fillSearchForm: from="${filters.from}" to="${filters.to}"`);

  const fillReactInput = async (label, selectorList, value) => {
    if (!value) return;

    // Find first matching visible input
    let handle = null;
    let matchedSel = null;
    for (const sel of selectorList) {
      try {
        handle = await page.waitForSelector(sel, { timeout: 3000, state: "visible" });
        matchedSel = sel;
        break;
      } catch (_) {}
    }
    if (!handle) { console.log(`[ATISU] ${label}: no input found`); return; }
    console.log(`[ATISU] ${label}: matched "${matchedSel}"`);

    // Clear via React native setter, then type char-by-char
    await page.evaluate((el) => {
      el.focus();
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      nativeSetter.call(el, "");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }, handle);
    await rand(200, 300);
    await page.evaluate((el) => el.focus(), handle);
    await page.keyboard.type(value, { delay: 80 });
    await rand(1200, 1600);

    // Wait for dropdown
    try {
      await page.waitForSelector("[role='option']", { timeout: 5000 });
    } catch (_) {
      console.log(`[ATISU] ${label}: no dropdown appeared`);
      return;
    }

    // Get all visible options
    const options = await page.evaluate(() =>
      Array.from(document.querySelectorAll("[role='option']"))
        .filter(el => el.offsetParent !== null)
        .map(el => el.textContent?.trim() || "")
        .filter(Boolean)
    );
    console.log(`[ATISU] ${label}: options:`, JSON.stringify(options));

    // Smart best-match: exact → starts-with-comma → first
    const vl = value.toLowerCase();
    const best = options.find(t => t.toLowerCase() === vl)
      || options.find(t => t.toLowerCase().startsWith(vl + ","))
      || options.find(t => t.toLowerCase().startsWith(vl + " "))
      || options[0];

    if (!best) { console.log(`[ATISU] ${label}: no option to click`); return; }

    // Click via evaluate — most reliable for React SPAs
    const clicked = await page.evaluate((text) => {
      const items = Array.from(document.querySelectorAll("[role='option']"));
      const item = items.find(el => el.offsetParent !== null && el.textContent?.trim() === text);
      if (item) { item.click(); return true; }
      return false;
    }, best);
    console.log(`[ATISU] ${label}: ${clicked ? `clicked "${best}"` : "click failed"}`);
    await rand(600, 900);
  };

  const fromSelectors = [
    "input[placeholder*='Например, Москва']",
    "[class*='From'] input", "[class*='from'] input",
    "input[placeholder*='Откуда']", "input[placeholder*='откуда']",
  ];
  const toSelectors = [
    "input[placeholder*='Например, Санкт-Петербург']",
    "[class*='To'] input", "[class*='to'] input",
    "input[placeholder*='Куда']", "input[placeholder*='куда']",
  ];

  if (filters.from) await fillReactInput("from", fromSelectors, filters.from);
  if (filters.to)   await fillReactInput("to",   toSelectors,   filters.to);

  // ATI.SU may auto-search after city selection — wait briefly first
  await rand(2000, 2500);

  // Submit: find button in the same container as the search inputs using innerText
  // (textContent picks up hidden nav items; innerText respects CSS display)
  const submitted = await page.evaluate(() => {
    const fromInput = document.querySelector("input[placeholder*='Например, Москва']");

    // Walk up from the search input to find a button within the same form section
    if (fromInput) {
      let el = fromInput.parentElement;
      for (let depth = 0; depth < 10; depth++) {
        if (!el) break;
        const btns = Array.from(el.querySelectorAll("button")).filter(b => {
          const t = (b.innerText || "").trim();
          return t.length > 0 && t.length < 30;
        });
        if (btns.length > 0) {
          const btn = btns[btns.length - 1]; // last button in form section = submit
          btn.click();
          return `form-container: "${(btn.innerText || "").trim()}"`;
        }
        el = el.parentElement;
      }
    }

    // Fallback: find button by exact innerText (not textContent which includes hidden nav)
    const btn = Array.from(document.querySelectorAll("button")).find(b => {
      const t = (b.innerText || "").trim();
      return /^обновить/i.test(t) || /^найти\s*(груз)?$/i.test(t);
    });
    if (btn) { btn.click(); return `text: "${(btn.innerText || "").trim()}"`; }
    return null;
  });

  if (submitted) {
    console.log(`[ATISU] search submitted via ${submitted}`);
  } else {
    // Last resort: press Enter on the to-input via keyboard event
    await page.evaluate(() => {
      const toInput = document.querySelector("input[placeholder*='Например, Санкт-Петербург']");
      if (toInput) {
        toInput.focus();
        toInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
        toInput.dispatchEvent(new KeyboardEvent("keyup",   { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
      }
    });
    console.log(`[ATISU] search submitted via keyboard Enter on to-input`);
  }

  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
  await rand(4000, 5000);
  console.log(`[ATISU] search done, URL: ${page.url()}`);

  // Dump more body to diagnose result structure
  const bodySnip = await page.evaluate(() => document.body.innerText.slice(0, 2000));
  console.log(`[ATISU] body snippet:`, bodySnip);
}

async function extractItems(page) {
  return page.evaluate(() => {
    const SEPS = ["→", "—", "–"];
    const results = [];

    // Try structured card selectors first
    const cardSelectors = [
      ".cargo-item", ".load-item", "[data-test='cargo-row']", "[data-test='load-row']",
      ".loads-list__item", "[class*='CargoItem']", "[class*='LoadItem']", "tr.result-row",
    ];
    let cards = [];
    for (const sel of cardSelectors) {
      cards = Array.from(document.querySelectorAll(sel));
      if (cards.length > 0) break;
    }

    const parseCard = (text) => {
      const lines = text.split("\n").map(s => s.trim()).filter(Boolean);

      let from = "", to = "", distance = "";
      for (const sep of SEPS) {
        const routeLine = lines.find(l => l.includes(sep));
        if (!routeLine) continue;
        const idx = routeLine.indexOf(sep);
        from = routeLine.substring(0, idx).trim();
        const rest = routeLine.substring(idx + sep.length).trim();
        const dm = rest.match(/([\d\s]+\s*км)/i);
        distance = dm ? dm[1].trim() : "";
        to = rest.replace(/\s*[\d\s]+\s*км.*$/i, "").trim();
        break;
      }
      if (!from || !to || from.length > 70 || to.length > 70) return null;

      const weightM = text.match(/(\d[\d,. ]*)\s*т[^а-яёa-z]/i);
      const weight = weightM ? weightM[0].trim() : "";

      const priceM = text.match(/[\d\s.,]+\s*(руб|тнг|₽|тг)[.,\s]*(нал|карт|безнал)?/i);
      const price = priceM ? priceM[0].trim() : "";

      const truckKw = ["тент", "реф", "изот", "борт", "конт", "цист", "любая", "открыт", "термос"];
      const truck_type = lines.find(l => truckKw.some(t => l.toLowerCase().includes(t))) || "";

      const dateM = text.match(/\d{1,2}[./]\d{1,2}([./]\d{2,4})?/);
      const time = dateM ? dateM[0] : "";

      const cargo = lines.find(l =>
        l !== truck_type && l.length < 50 && !/^\d/.test(l) &&
        !/(руб|тнг|км|нал|карт)/i.test(l) &&
        !l.includes(from) && !l.includes(to)
      ) || "";

      return { from, to, distance, cargo, weight, truck_type, price, time };
    };

    if (cards.length > 0) {
      for (const card of cards) {
        const parsed = parseCard(card.innerText || "");
        if (parsed) results.push(parsed);
      }
    } else {
      // Fallback: find elements containing route separators
      const els = Array.from(document.querySelectorAll("a, td, div, span")).filter(el => {
        const t = el.textContent || "";
        return SEPS.some(s => t.includes(s)) && t.length < 120 && t.length > 5;
      });
      for (const el of els) {
        let container = el;
        for (let i = 0; i < 5; i++) {
          if (!container.parentElement) break;
          const txt = container.parentElement.innerText || "";
          if (txt.length > 30 && txt.length < 600) container = container.parentElement;
          else break;
        }
        const parsed = parseCard(container.innerText || "");
        if (parsed && parsed.from && parsed.to) results.push(parsed);
      }
    }

    // Deduplicate
    const seen = new Set();
    return results.filter(it => {
      const k = `${it.from}|${it.to}|${it.time}|${it.truck_type}`.toLowerCase().replace(/\s/g, "");
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  });
}
