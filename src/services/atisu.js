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

  // Submit: find the "НАЙТИ ГРУЗЫ" button by innerText
  const submitted = await page.evaluate(() => {
    const SKIP = /выбрать\s*список|очистить|добавить|войти|регистр|фильтр/i;

    // Priority: find by known button texts ("НАЙТИ ГРУЗЫ", "ОБНОВИТЬ" etc.)
    const allBtns = Array.from(document.querySelectorAll("button"));
    const byText = allBtns.find(b => {
      const t = (b.innerText || "").trim();
      return /^найти\s*груз/i.test(t) || /^обновить/i.test(t) || /^найти$/i.test(t);
    });
    if (byText) { byText.click(); return `text: "${(byText.innerText || "").trim()}"`; }

    // Fallback: walk up from search input, skipping known non-submit buttons
    const fromInput = document.querySelector("input[placeholder*='Например, Москва']");
    if (fromInput) {
      let el = fromInput.parentElement;
      for (let depth = 0; depth < 10; depth++) {
        if (!el) break;
        const btns = Array.from(el.querySelectorAll("button")).filter(b => {
          const t = (b.innerText || "").trim();
          return t.length > 0 && t.length < 40 && !SKIP.test(t);
        });
        if (btns.length > 0) {
          const btn = btns[btns.length - 1];
          btn.click();
          return `form-container: "${(btn.innerText || "").trim()}"`;
        }
        el = el.parentElement;
      }
    }
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
  await page.waitForFunction(
    () => document.body.innerText.includes("Найдено"),
    { timeout: 8000 }
  ).catch(() => {});

  const { items, debug } = await page.evaluate(() => {
    const DIRECTION = /^[A-Z]{2,3}-[A-Z]{2,3}$/;
    const TRUCK_KW  = /тент|реф|изот|борт|конт|цист|любая|открыт|термос/i;
    const WEIGHT_RE = /\d[\d,]*\s*\/\s*\d/;
    const DATE_KW   = /готов|погрузка|апр|мар|фев|янв|май|июн|июл|авг|сен|окт|ноя|дек/i;
    const PRICE_KW  = /скрыто|запрос|руб|тнг|₽|нал|безнал/i;
    const CITY_RE   = /^[А-ЯЁ][а-яё]/;

    // Walk UP from el, return first ancestor whose innerText has "км" and length in [minLen, maxLen]
    const findRowContainer = (el, minLen = 80, maxLen = 2000) => {
      let cur = el.parentElement;
      for (let d = 0; d < 15; d++) {
        if (!cur) break;
        const len = (cur.innerText || "").length;
        if (len >= minLen && len <= maxLen && (cur.innerText || "").includes("км")) return cur;
        cur = cur.parentElement;
      }
      return null;
    };

    // Find all leaf text nodes that match direction code pattern
    const dirEls = Array.from(document.querySelectorAll("*")).filter(el =>
      el.children.length === 0 && DIRECTION.test((el.textContent || "").trim())
    );

    const results = [];
    const seenContainers = new Set();

    for (const dirEl of dirEls) {
      const row = findRowContainer(dirEl);
      if (!row) continue;

      const rowKey = (row.innerText || "").substring(0, 50);
      if (seenContainers.has(rowKey)) continue;
      seenContainers.add(rowKey);

      // Get leaf texts from the row in DOM order
      const leafs = Array.from(row.querySelectorAll("*"))
        .filter(el => el.children.length === 0 && (el.innerText || "").trim())
        .map(el => (el.innerText || "").trim())
        .filter(Boolean);

      const distance  = (leafs.find(l => /\d[\d\s]*\s*км/.test(l)) || "").match(/(\d[\d\s]*\s*км)/)?.[1]?.trim() || "";
      const truck_type = leafs.find(l => TRUCK_KW.test(l)) || "";
      const wLeaf     = leafs.find(l => WEIGHT_RE.test(l)) || "";
      const weight    = wLeaf.match(/^([\d,. /]+)/)?.[1]?.trim() || "";
      const cargo     = wLeaf.replace(/^[\d,. /\s]+/, "").trim() || "";

      const dateIdx = leafs.findIndex(l => DATE_KW.test(l));
      let from = "", time = "";
      if (dateIdx >= 0) {
        const dateLine = leafs[dateIdx];
        // Handle merged "Актауготов 19 апр." — city glued to date keyword
        const merged = dateLine.match(/^([А-ЯЁ][а-яёА-ЯЁ\s\-]+?)(готов\b|погрузка\b|\d{1,2}[\s\-])/i);
        if (merged && merged[1].trim().length >= 2) {
          from = merged[1].trim();
          time = dateLine.substring(merged[1].length).trim();
        } else {
          from = dateIdx > 0 ? leafs[dateIdx - 1] : "";
          time = dateLine;
        }
      }
      const to    = dateIdx >= 0 && dateIdx + 1 < leafs.length ? leafs[dateIdx + 1] : "";
      const price = leafs.find(l => PRICE_KW.test(l)) || "";

      if (from && to && from !== to && CITY_RE.test(from) && CITY_RE.test(to)
          && from.length < 60 && to.length < 60) {
        results.push({ from, to, distance, cargo, weight, truck_type, price, time });
      }
    }

    const seen = new Set();
    const deduped = results.filter(it => {
      const k = `${it.from}|${it.to}|${it.time}|${it.truck_type}`.toLowerCase().replace(/\s/g, "");
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    // Debug: show first row container content
    const debugRow = dirEls[0] ? (() => {
      const r = findRowContainer(dirEls[0]);
      return r ? (r.innerText || "").slice(0, 300) : "no container";
    })() : "no dirEls";

    return { items: deduped, debug: { dirEls: dirEls.length, results: results.length, rowSample: debugRow } };
  });

  console.log(`[ATISU] dirEls=${debug.dirEls} parsed=${debug.results} deduped=${items.length}`);
  console.log(`[ATISU] row[0]:`, debug.rowSample);
  items.slice(0, 3).forEach((it, i) =>
    console.log(`[ATISU] item[${i}]: from="${it.from}" to="${it.to}" cargo="${it.cargo}" price="${it.price}"`)
  );
  return items;
}
