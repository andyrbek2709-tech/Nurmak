import { chromium } from "playwright";
import { rand } from "../utils/timing.js";

const LOGIN_URL  = "https://id.ati.su";
const SEARCH_URL = "https://loads.ati.su/";

function firstCity(val) {
  if (!val) return null;
  return val.split(",")[0].trim();
}

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

    const needsLogin = await page.evaluate(() =>
      !!document.querySelector("a[href*='login'], a[href*='signin'], [data-test='login-btn']")
      || !document.cookie.includes("atiauth")
    );
    if (needsLogin) await doLogin(page);

    await page.goto(SEARCH_URL, { waitUntil: "networkidle", timeout: 30000 });
    await rand(1000, 1500);

    // Set up waitForResponse BEFORE clicking search — this avoids the race condition
    // where response.json() resolves after we've already checked apiResponses
    const loadsPromise = page.waitForResponse(
      resp => resp.url().includes("/loads/search") && resp.status() === 200,
      { timeout: 25000 }
    ).catch(() => null);

    await fillSearchForm(page, filters);

    const loadsResp = await loadsPromise;
    let loadsJson = null;
    if (loadsResp) {
      loadsJson = await loadsResp.json().catch(() => null);
      console.log(`[ATISU] loads/search captured: totalItems=${loadsJson?.totalItems}, loads=${loadsJson?.loads?.length}`);
    } else {
      console.log(`[ATISU] loads/search not captured (timeout or no request)`);
    }

    console.log(`[ATISU] scraping URL: ${page.url()}`);

    // Extract directly from the captured loads array
    if (loadsJson?.loads?.length > 0) {
      // Log keys + extended JSON to identify real field names for city extraction
      try {
        const r = loadsJson.loads[0];
        console.log(`[ATISU] loads[0] keys: ${Object.keys(r).join(",")}`);
        console.log(`[ATISU] loads[0] json: ${JSON.stringify(r).substring(0, 2000)}`);
      } catch (_) {}
      const items = loadsJson.loads.map(parseApiItem).filter(Boolean);
      console.log(`[ATISU] extracted ${items.length} items from API (${loadsJson.loads.length} raw)`);
      items.slice(0, 3).forEach((it, i) =>
        console.log(`[ATISU] item[${i}]: from="${it.from}" to="${it.to}" cargo="${it.cargo}" price="${it.price}"`)
      );
      if (items.length > 0) return items;
    }

    // Fallback: DOM card extraction
    console.log(`[ATISU] API extraction got 0, trying DOM...`);
    const domItems = await extractItemsDom(page);
    domItems.slice(0, 3).forEach((it, i) =>
      console.log(`[ATISU] item[${i}]: from="${it.from}" to="${it.to}" cargo="${it.cargo}" price="${it.price}"`)
    );
    return domItems;
  } finally {
    await browser.close();
  }
}


const ATI_COUNTRY = { RUS: "Россия", KAZ: "Казахстан", BLR: "Беларусь", UKR: "Украина", UZB: "Узбекистан", KGZ: "Кыргызстан", TJK: "Таджикистан" };

// ATI.SU truck carType bit values → Russian names
const ATI_CAR_TYPE = { "1":"тент","2":"реф","4":"изотерм","8":"борт","16":"фург","32":"цистерна","64":"любой","128":"контейнер","256":"термос","512":"самосвал" };

function atiCity(obj) {
  if (!obj) return "";
  // Try every known nesting pattern for city name in loading/unloading objects
  return obj.cityName || obj.cityFullName || obj.city?.name || obj.city?.fullName
    || obj.place?.name || obj.place?.cityName || obj.geo?.cityName || obj.address?.city
    || obj.name || "";
}

function parseApiItem(it) {
  // Confirmed top-level keys: route, truck, load, loading, unloading, rate
  const loadingCity   = atiCity(it.loading);
  const unloadingCity = atiCity(it.unloading);

  // route.country = "KAZ-RUS" → fallback country names for filter matching
  const routeParts  = (it.route?.country || "").split("-");
  const fromCountry = routeParts.length >= 2 ? (ATI_COUNTRY[routeParts[0]] || "") : "";
  const toCountry   = routeParts.length >= 2 ? (ATI_COUNTRY[routeParts[routeParts.length - 1]] || "") : "";

  // Always append country so matchesFilters("Россия") can match "Москва, Россия"
  const from = loadingCity
    ? (fromCountry ? `${loadingCity}, ${fromCountry}` : loadingCity)
    : fromCountry;
  const to = unloadingCity
    ? (toCountry ? `${unloadingCity}, ${toCountry}` : unloadingCity)
    : toCountry;

  // Cargo — confirmed field name: `load` (not `cargo`)
  const loadObj = it.load || {};
  const cargo  = loadObj.name || loadObj.cargoName || loadObj.typeName || loadObj.type || "";
  const weightVal = loadObj.weight ?? loadObj.tonnage ?? loadObj.weightMax ?? "";
  const volVal    = loadObj.volume ?? loadObj.volumeMax ?? "";
  const weight = weightVal !== "" && volVal !== "" ? `${weightVal}т / ${volVal}м³`
    : weightVal !== "" ? `${weightVal}т`
    : volVal !== "" ? `${volVal}м³` : "";

  // Truck — `truck.carTypes` is array of numeric IDs: ["1","8","16","64"]
  const truck_type = Array.isArray(it.truck?.carTypes)
    ? it.truck.carTypes.map(t => ATI_CAR_TYPE[String(t)] || t).join(", ")
    : (it.truck?.carTypeName || it.truck?.carType || "");

  // Rate — confirmed field name: `rate` (was "[object Object]" → it's an object)
  const rateObj   = it.rate || {};
  const rateSum   = rateObj.sum ?? rateObj.rateSum ?? rateObj.value ?? rateObj.amount;
  const rateCurr  = rateObj.currency === "RUB" ? "₽" : rateObj.currency === "EUR" ? "€" : (rateObj.currency || "");
  const rateType  = rateObj.type || rateObj.rateType || "";
  const price = rateSum != null && rateSum > 0
    ? `${rateSum} ${rateCurr}`.trim()
    : rateType === "request" || rateType === "negotiated" ? "запрос ставки"
    : rateType === "hidden"  ? "скрыто"
    : "";

  const distance = it.route?.distance ?? "";

  // Loading date — from `loading` object, fallback to addDate date part
  const time = it.loading?.date || it.loading?.dateFrom || it.loading?.firstDate
    || it.loading?.dateStart || (it.addDate ? it.addDate.substring(0, 10) : "");

  // Log loading/unloading structure if cities still empty (for future debugging)
  if (!loadingCity && !unloadingCity) {
    try { console.log(`[ATISU] loading obj: ${JSON.stringify(it.loading).substring(0, 300)}`); } catch (_) {}
    try { console.log(`[ATISU] unloading obj: ${JSON.stringify(it.unloading).substring(0, 300)}`); } catch (_) {}
  }

  if (!from && !to) return null;
  return {
    from: String(from), to: String(to),
    cargo: String(cargo), weight: String(weight),
    price: String(price), truck_type: String(truck_type),
    distance: String(distance), time: String(time),
    source: "atisu",
  };
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

  // Use only the first city for ATI.SU (no multi-city support)
  const fromVal = firstCity(filters.from);
  const toVal   = firstCity(filters.to);
  console.log(`[ATISU] fillSearchForm: from="${fromVal}" to="${toVal}" (raw: from="${filters.from}" to="${filters.to}")`);

  const fillReactInput = async (label, selectorList, value) => {
    if (!value) return;

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

    try {
      await page.waitForSelector("[role='option']", { timeout: 5000 });
    } catch (_) {
      console.log(`[ATISU] ${label}: no dropdown appeared`);
      return;
    }

    const options = await page.evaluate(() =>
      Array.from(document.querySelectorAll("[role='option']"))
        .filter(el => el.offsetParent !== null)
        .map(el => el.textContent?.trim() || "")
        .filter(Boolean)
    );
    console.log(`[ATISU] ${label}: options:`, JSON.stringify(options));

    const vl = value.toLowerCase();
    const best = options.find(t => t.toLowerCase() === vl)
      || options.find(t => t.toLowerCase().startsWith(vl + ","))
      || options.find(t => t.toLowerCase().startsWith(vl + " "))
      || options[0];

    if (!best) { console.log(`[ATISU] ${label}: no option to click`); return; }

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

  if (fromVal) await fillReactInput("from", fromSelectors, fromVal);
  if (toVal)   await fillReactInput("to",   toSelectors,   toVal);

  await rand(2000, 2500);

  const submitted = await page.evaluate(() => {
    const SKIP = /выбрать\s*список|очистить|добавить|войти|регистр|фильтр/i;
    const allBtns = Array.from(document.querySelectorAll("button"));
    const byText = allBtns.find(b => {
      const t = (b.innerText || "").trim();
      return /^найти\s*груз/i.test(t) || /^обновить/i.test(t) || /^найти$/i.test(t);
    });
    if (byText) { byText.click(); return `text: "${(byText.innerText || "").trim()}"`; }

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
    await page.evaluate(() => {
      const toInput = document.querySelector("input[placeholder*='Например, Санкт-Петербург']");
      if (toInput) {
        toInput.focus();
        toInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
        toInput.dispatchEvent(new KeyboardEvent("keyup",   { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
      }
    });
    console.log(`[ATISU] search submitted via keyboard Enter`);
  }

  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
  await rand(3000, 4000);
  console.log(`[ATISU] search done, URL: ${page.url()}`);

  const bodySnip = await page.evaluate(() => document.body.innerText.slice(0, 1500));
  console.log(`[ATISU] body snippet:`, bodySnip);
}

async function extractItemsDom(page) {
  await page.waitForFunction(
    () => document.body.innerText.includes("Найдено"),
    { timeout: 5000 }
  ).catch(() => {});

  const result = await page.evaluate(() => {
    const DATE_KW    = /готов|погрузка|апр|мар|фев|янв|май|июн|июл|авг|сен|окт|ноя|дек/i;
    const CARD_START = /^(изм|доб)\s+\d/i;
    const CITY_RE    = /^[А-ЯЁ][а-яё]/;
    const KM_RE      = /\d[\d\s]*\s*км/;
    const PRICE_KW   = /скрыто|запрос|руб|тнг|₽|нал|безнал/i;
    const TRUCK_KW   = /^(тент|реф|изот|борт|конт|цист|любая|открыт|термос)/i;
    const WEIGHT_RE  = /\d[\d,]*\s*\/\s*[\d\-]/;
    const NAV_SKIP   = /^(войти|зарегистрироваться|все сервисы|ваши|добавить|заказы|курьер|поиск грузов|тёмная тема|найти груз|фильтры|история поиска|по машинам|цепочки|отслеживаемые|ати|площадки|загр\/выгр|отд\.машина|обновить|показать контакты|доступно|популярные|инструкция|по поиску|расчет|защита|оплата|грузовладельцам|перевозчикам|выводить|упорядочить|времени|вид$|маршрут$|ставка$|транспорт$|направл\.$)/i;

    const all = Array.from(document.querySelectorAll("*"));

    // Find "Найдено N груза" leaf element
    const foundEl = all.find(el =>
      el.children.length === 0 && /найдено\s+\d/i.test((el.textContent || "").trim())
    );
    if (!foundEl) return { items: [], debug: "no Найдено element" };

    // Collect ALL leaf elements in DOM order, find position of foundEl
    const allLeafs = all.filter(el =>
      el.children.length === 0 && (el.innerText || "").trim()
    );
    const foundIdx = allLeafs.indexOf(foundEl);
    if (foundIdx < 0) return { items: [], debug: "Найдено not in leaf list" };

    // Get all leaf texts AFTER "Найдено" — these are the sequential result cards
    const afterLeafs = allLeafs.slice(foundIdx + 1)
      .map(el => (el.innerText || "").trim())
      .filter(t => t && !NAV_SKIP.test(t));

    // Also collect weight data from BEFORE "Найдено" (weight column renders early)
    const beforeLeafs = allLeafs.slice(0, foundIdx)
      .map(el => (el.innerText || "").trim())
      .filter(Boolean);
    const preWeights = beforeLeafs.filter(t => WEIGHT_RE.test(t));

    // Split afterLeafs into cards at each "изм/доб DATE" boundary
    const cards = [];
    let cur = [];
    for (const t of afterLeafs) {
      if (CARD_START.test(t) && cur.length > 0) {
        cards.push(cur);
        cur = [t];
      } else {
        cur.push(t);
      }
    }
    if (cur.length > 0) cards.push(cur);

    const items = [];
    for (const card of cards) {
      const truck_type = card.find(l => TRUCK_KW.test(l)) || "";
      const price      = card.find(l => PRICE_KW.test(l)) || "";
      const km         = (card.find(l => KM_RE.test(l)) || "").match(/(\d[\d\s]*\s*км)/)?.[1]?.trim() || "";

      const dateIdx = card.findIndex(l => DATE_KW.test(l) && !CARD_START.test(l));
      let from = "", time = "", to = "";

      if (dateIdx >= 0) {
        const dateLine = card[dateIdx];
        const merged = dateLine.match(/^([А-ЯЁ][а-яёА-ЯЁ\s\-]+?)(готов\b|погрузка\b|\d{1,2}[\s\-])/i);
        if (merged && merged[1].trim().length >= 2) {
          from = merged[1].trim();
          time = dateLine.substring(merged[1].length).trim();
        } else {
          // from city = last Cyrillic word before date
          const before = card.slice(0, dateIdx).filter(l => CITY_RE.test(l) && !TRUCK_KW.test(l));
          from = before[before.length - 1] || "";
          time = dateLine;
        }
        // to city = first Cyrillic word after date not equal to from
        for (let j = dateIdx + 1; j < card.length; j++) {
          const l = card[j];
          if (CITY_RE.test(l) && !PRICE_KW.test(l) && !TRUCK_KW.test(l) && l !== from) {
            to = l; break;
          }
        }
      }

      const idx = items.length;
      const wLeaf = preWeights[idx] || "";
      const weight = wLeaf.match(/^([\d,. /]+)/)?.[1]?.trim() || "";
      const cargo  = wLeaf.replace(/^[\d,. /\-\s]+/, "").trim();

      if (from && to && from !== to && CITY_RE.test(from)) {
        items.push({ from, to, distance: km, cargo, weight, truck_type, price, time, source: "atisu" });
      }
    }

    return {
      items,
      debug: {
        cards: cards.length,
        card0: cards[0]?.slice(0, 15),
        preWeights: preWeights.slice(0, 5),
        afterSample: afterLeafs.slice(0, 30),
        foundText: (foundEl?.textContent || "").trim().substring(0, 60),
      },
    };
  });

  console.log(`[ATISU] DOM card-parse: ${result.items?.length} items, cards=${result.debug?.cards}`);
  console.log(`[ATISU] foundEl: "${result.debug?.foundText}"`);
  console.log(`[ATISU] afterLeafs[0..30]:`, JSON.stringify(result.debug?.afterSample));
  if (result.debug?.cards > 0) {
    console.log(`[ATISU] card[0]:`, JSON.stringify(result.debug?.card0));
  }
  if (result.items?.length === 0) {
    console.log(`[ATISU] preWeights:`, JSON.stringify(result.debug?.preWeights));
  }
  return result.items || [];
}
