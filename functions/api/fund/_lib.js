const memCache = new Map();

function setCache(key, value, ttlMs) {
  memCache.set(key, { value, expireAt: Date.now() + ttlMs });
}
function getCache(key) {
  const item = memCache.get(key);
  if (!item) return null;
  if (item.expireAt < Date.now()) {
    memCache.delete(key);
    return null;
  }
  return item.value;
}

export function jsonResponse(body, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("content-type", "application/json; charset=UTF-8");
  headers.set("Access-Control-Allow-Origin", "*");
  return new Response(JSON.stringify(body), { ...init, headers });
}

function stripTags(s) {
  return String(s || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .trim();
}

function parseJsonpLike(text) {
  const s = String(text || "").trim();
  const lp = s.indexOf("(");
  const rp = s.lastIndexOf(")");
  if (lp !== -1 && rp > lp) return JSON.parse(s.slice(lp + 1, rp));
  return JSON.parse(s);
}

export async function fetchFundBaseFromFundGz(code) {
  const cacheKey = `fundgz:${code}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  const url = `https://fundgz.1234567.com.cn/js/${code}.js?rt=${Date.now()}`;
  const resp = await fetch(url, { method: "GET" });
  if (resp.status === 404) throw new Error("基金不存在或接口 404");
  const text = await resp.text();
  const m = text && text.match(/jsonpgz\((.*)\)/);
  if (!m) throw new Error("无法解析基金估值数据");
  const data = JSON.parse(m[1]);

  const base = {
    fundCode: data.fundcode,
    name: data.name,
    navPrev: data.dwjz != null ? Number(data.dwjz) : null,
    navEstOfficial: data.gsz != null ? Number(data.gsz) : null,
    pctChangeOfficial: data.gszzl != null ? Number(data.gszzl) : null,
    gztime: data.gztime || null,
  };

  setCache(cacheKey, base, 60 * 1000);
  return base;
}

export async function fetchLatestNavDisclosed(fundCode) {
  const cacheKey = `lsjz:${fundCode}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  try {
    const today = new Date();
    const endDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(
      today.getDate(),
    ).padStart(2, "0")}`;
    const url = new URL("https://api.fund.eastmoney.com/f10/lsjz");
    url.searchParams.set("fundCode", fundCode);
    url.searchParams.set("pageIndex", "1");
    url.searchParams.set("pageSize", "5");
    url.searchParams.set("startDate", "");
    url.searchParams.set("endDate", endDate);

    const resp = await fetch(url.toString(), {
      headers: { Referer: "https://fundf10.eastmoney.com/" },
    });
    const raw = await resp.text();
    let data;
    try {
      data = parseJsonpLike(raw);
    } catch {
      data = {};
    }
    const list = data?.Data?.LSJZList || data?.data?.LSJZList || data?.data?.lsjzList;
    if (!Array.isArray(list) || list.length === 0) return null;
    const latest = list[0];
    const nav =
      latest?.DWJZ != null
        ? Number(latest.DWJZ)
        : latest?.dwjz != null
          ? Number(latest.dwjz)
          : null;
    const date = latest?.FSRQ || latest?.fsrq || null;
    const result = nav != null ? { navDisclosed: nav, navDisclosedDate: date } : null;
    if (result) setCache(cacheKey, result, 10 * 60 * 1000);
    return result;
  } catch {
    return null;
  }
}

function stockCodeToSecId(stockCode) {
  const code = String(stockCode).replace(/[^0-9]/g, "");
  if (!code) return null;
  if (code.startsWith("6") && code.length >= 6) return `1.${code}`;
  if ((code.startsWith("0") || code.startsWith("2") || code.startsWith("3")) && code.length >= 6) return `0.${code}`;
  if (code.length === 5 || code.length === 4) return `116.${code.padStart(5, "0")}`;
  return null;
}

function stockCodeToSinaList(stockCode) {
  const code = String(stockCode).replace(/[^0-9]/g, "");
  if (!code) return null;
  if (code.startsWith("6") && code.length >= 6) return `sh${code}`;
  if ((code.startsWith("0") || code.startsWith("2") || code.startsWith("3")) && code.length >= 6) return `sz${code}`;
  if (code.length === 5 || code.length === 4) return `hk${code.padStart(5, "0")}`;
  return null;
}

async function fetchStockQuotePctChangeSina(stockCode) {
  const listCode = stockCodeToSinaList(stockCode);
  if (!listCode) return null;
  const url = `https://hq.sinajs.cn/list=${listCode}`;
  const resp = await fetch(url, { headers: { Referer: "https://finance.sina.com.cn/" } });
  const text = await resp.text();
  const m = text.match(/hq_str_[^=]+="([^"]*)"/);
  if (!m || !m[1]) return null;
  const parts = m[1].split(",");
  const isHK = listCode.startsWith("hk");
  let prev, last, name;
  if (isHK) {
    prev = parseFloat(parts[3]);
    last = parseFloat(parts[6]);
    name = (parts[1] || parts[0] || "").trim();
  } else {
    prev = parseFloat(parts[2]);
    last = parseFloat(parts[3]);
    name = parts[0] || "";
  }
  if (!Number.isFinite(prev) || !Number.isFinite(last) || prev === 0) return null;
  let pctChange;
  if (isHK && parts[8] !== undefined && parts[8] !== "") {
    const raw = String(parts[8]).replace(/%/g, "").trim();
    const pct = parseFloat(raw);
    pctChange = Number.isFinite(pct) ? pct : ((last - prev) / prev) * 100;
  } else {
    pctChange = ((last - prev) / prev) * 100;
  }
  return { stockCode, name, lastPrice: last, prevPrice: prev, pctChange };
}

async function fetchStockQuotePctChangeTencent(stockCode) {
  const listCode = stockCodeToSinaList(stockCode);
  if (!listCode) return null;
  const url = `https://qt.gtimg.cn/q=${listCode}`;
  const resp = await fetch(url);
  const text = await resp.text();
  const m = text.match(/="([^"]+)"/);
  if (!m || !m[1]) return null;
  const parts = m[1].split("~");
  const last = parseFloat(parts[3]);
  const prev = parseFloat(parts[4]);
  if (!Number.isFinite(prev) || !Number.isFinite(last) || prev === 0) return null;
  const raw32 = parts[32] !== undefined && parts[32] !== "" ? String(parts[32]).replace(/%/g, "").trim() : "";
  const pctDirect = raw32 !== "" ? parseFloat(raw32) : NaN;
  const pctChange = Number.isFinite(pctDirect) ? pctDirect : ((last - prev) / prev) * 100;
  return { stockCode, name: parts[1] || "", lastPrice: last, prevPrice: prev, pctChange };
}

export async function fetchStockQuotePctChange(stockCode) {
  const secid = stockCodeToSecId(stockCode);
  const cacheKey = `quote:${secid || stockCode}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  let result = null;
  const isHK = secid && secid.startsWith("116.");

  if (isHK) {
    try {
      result = await fetchStockQuotePctChangeTencent(stockCode);
    } catch {}
    if (!result) {
      try {
        result = await fetchStockQuotePctChangeSina(stockCode);
      } catch {}
    }
  }

  if (!result && secid) {
    try {
      const url = new URL("https://push2.eastmoney.com/api/qt/stock/get");
      url.searchParams.set("secid", secid);
      url.searchParams.set("fields", "f43,f60,f58,f170");
      const resp = await fetch(url.toString(), { headers: { Referer: "https://quote.eastmoney.com/" } });
      const data = await resp.json();
      const d = data && data.data;
      if (d) {
        const lastRaw = d.f43;
        const prevRaw = d.f60;
        const pctDirect = d.f170;
        const rawMax = Math.max(Number(lastRaw) || 0, Number(prevRaw) || 0);
        const scale = isHK ? (rawMax > 1000 ? 100 : 1) : 100;
        const lastPrice = lastRaw != null ? Number(lastRaw) / scale : null;
        const prevPrice = prevRaw != null ? Number(prevRaw) / scale : null;
        const computedPct =
          lastPrice != null && prevPrice != null && prevPrice !== 0 ? ((lastPrice - prevPrice) / prevPrice) * 100 : null;
        const pctNum = pctDirect != null && Number.isFinite(Number(pctDirect)) ? Number(pctDirect) : null;
        if (pctNum != null) {
          result = { stockCode, name: d.f58 || "", lastPrice, prevPrice, pctChange: pctNum };
        } else if (computedPct != null && Number.isFinite(computedPct)) {
          result = { stockCode, name: d.f58 || "", lastPrice, prevPrice, pctChange: computedPct };
        }
      }
    } catch {
      // ignore
    }
  }

  if (!result) {
    try {
      result = await fetchStockQuotePctChangeSina(stockCode);
    } catch {}
  }
  if (!result) {
    try {
      result = await fetchStockQuotePctChangeTencent(stockCode);
    } catch {}
  }

  if (result) setCache(cacheKey, result, 2 * 1000);
  return result;
}

export async function fetchTop10Holdings(fundCode) {
  const cacheKey = `holdings:${fundCode}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  const holdings = [];
  try {
    const url = new URL("https://fundf10.eastmoney.com/FundArchivesDatas.aspx");
    url.searchParams.set("type", "jjcc");
    url.searchParams.set("code", fundCode);
    url.searchParams.set("topline", "10");
    const resp = await fetch(url.toString(), {
      headers: { Referer: `https://fundf10.eastmoney.com/ccmx_${fundCode}.html` },
    });
    const text = await resp.text();
    const m = text.match(/content:"((?:[^"\\]|\\.)*)"/);
    if (!m || !m[1]) {
      setCache(cacheKey, holdings, 30 * 60 * 1000);
      return holdings;
    }

    const html = m[1].replace(/\\"/g, '"').replace(/\\n/g, "\n").replace(/\\r/g, "").replace(/\\t/g, " ");
    const tableMatch = html.match(/<table[\s\S]*?<\/table>/i);
    const tableHtml = tableMatch ? tableMatch[0] : html;
    const rowRe = /<tr[\s\S]*?<\/tr>/gi;
    const rows = tableHtml.match(rowRe) || [];

    for (const rowHtml of rows) {
      if (holdings.length >= 10) break;
      const cellRe = /<td[\s\S]*?<\/td>/gi;
      const cells = rowHtml.match(cellRe) || [];
      if (cells.length < 3) continue;

      const firstCell = stripTags(cells[0]);
      if (!/^\d+$/.test(firstCell)) continue;

      const codeCell = cells[1];
      const codeText = stripTags(codeCell);
      const digits = codeText.replace(/\D/g, "");
      const stockCode = digits.length >= 6 ? digits.slice(-6) : digits || "";
      const stockName = stripTags(cells[2]) || "—";
      if (!stockCode || stockCode.length < 5) continue;

      let exchange = null;
      const hrefM = codeCell.match(/href\s*=\s*["']([^"']+)["']/i);
      if (hrefM && hrefM[1]) {
        const secidM = hrefM[1].match(/\/unify\/r\/(\d+)\.(\d+)/);
        if (secidM) {
          const market = secidM[1];
          if (market === "0") exchange = "SZ";
          else if (market === "1") exchange = "SH";
          else if (market === "116") exchange = "HK";
        }
      }

      let weight = null;
      for (let i = 3; i < cells.length; i++) {
        const w = stripTags(cells[i]);
        if (!w.includes("%")) continue;
        const wm = w.match(/(\d+\.?\d*)\s*%?/);
        if (wm) {
          const val = parseFloat(wm[1]);
          if (val > 0 && val < 100) {
            weight = val / 100;
            break;
          }
        }
      }

      const finalCode = stockCode.length === 5 ? stockCode.padStart(6, "0") : stockCode;
      holdings.push({
        stockCode: finalCode,
        stockName,
        weight: Number.isFinite(weight) ? weight : null,
        exchange,
      });
    }
  } catch {
    // ignore
  }

  setCache(cacheKey, holdings, 6 * 60 * 60 * 1000);
  return holdings;
}

export async function estimateFundByTop10(fundCode) {
  const [base, holdings, disclosed] = await Promise.all([
    fetchFundBaseFromFundGz(fundCode),
    fetchTop10Holdings(fundCode),
    fetchLatestNavDisclosed(fundCode),
  ]);

  const legs = [];
  let Rf = 0;

  for (const h of holdings) {
    if (!h.weight || h.weight <= 0) continue;
    const quote = await fetchStockQuotePctChange(h.stockCode);
    const wi = h.weight;
    const pctChange = quote && quote.pctChange != null ? quote.pctChange : null;
    if (pctChange != null) Rf += wi * (pctChange / 100);
    legs.push({
      stockCode: h.stockCode,
      stockName: h.stockName,
      weight: wi,
      pctChange,
      contributionPct: pctChange != null ? wi * pctChange : null,
      exchange: h.exchange ?? null,
    });
  }

  const navPrev = base.navPrev;
  const hasAnyQuote = legs.some((l) => l.pctChange != null);
  const fundPctChangeEst = hasAnyQuote ? Rf * 100 : base.pctChangeOfficial != null ? base.pctChangeOfficial : 0;
  const navEstByLegs =
    hasAnyQuote && navPrev != null ? navPrev * (1 + Rf) : base.navEstOfficial != null ? base.navEstOfficial : null;

  return {
    fundCode: base.fundCode || fundCode,
    name: base.name,
    navPrev,
    navEstOfficial: base.navEstOfficial,
    pctChangeOfficial: base.pctChangeOfficial,
    gztime: base.gztime,
    navEstByLegs,
    fundPctChangeEst,
    legs,
    navDisclosed: disclosed?.navDisclosed ?? null,
    navDisclosedDate: disclosed?.navDisclosedDate ?? null,
    updatedAt: new Date().toISOString(),
  };
}

