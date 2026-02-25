// 简单 Node 后端：抓取东方财富数据 + 估算净值

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const cheerio = require("cheerio");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// 静态资源：直接服务当前目录，访问 http://localhost:3001/ 即可打开 index.html
app.use(express.static(__dirname));

// 简单内存缓存（生产可替换为 Redis）
const cache = new Map();
function setCache(key, value, ttlMs) {
  cache.set(key, { value, expireAt: Date.now() + ttlMs });
}
function getCache(key) {
  const item = cache.get(key);
  if (!item) return null;
  if (item.expireAt < Date.now()) {
    cache.delete(key);
    return null;
  }
  return item.value;
}

// 工具：从 fundgz JSONP 中解析基金基础信息和上一日净值
async function fetchFundBaseFromFundGz(code) {
  const cacheKey = `fundgz:${code}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  const url = `https://fundgz.1234567.com.cn/js/${code}.js?rt=${Date.now()}`;
  const resp = await axios.get(url, { responseType: "text", validateStatus: () => true });
  if (resp.status === 404) throw new Error("基金不存在或接口 404");
  const m = resp.data && resp.data.match(/jsonpgz\((.*)\)/);
  if (!m) throw new Error("无法解析基金估值数据");
  const jsonStr = m[1];
  const data = JSON.parse(jsonStr);

  // fundgz 返回字段：fundcode, name, dwjz(昨净值), gsz(估值), gszzl(涨跌), gztime
  const base = {
    fundCode: data.fundcode,
    name: data.name,
    navPrev: data.dwjz != null ? Number(data.dwjz) : null,
    navEstOfficial: data.gsz != null ? Number(data.gsz) : null,
    pctChangeOfficial: data.gszzl != null ? Number(data.gszzl) : null,
    gztime: data.gztime || null,
  };

  setCache(cacheKey, base, 60 * 1000); // 1 分钟缓存
  return base;
}

// 工具：获取最近披露的净值（当日披露净值，一般 20 点后）
async function fetchLatestNavDisclosed(fundCode) {
  const cacheKey = `lsjz:${fundCode}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  try {
    const url = "https://api.fund.eastmoney.com/f10/lsjz";
    const today = new Date();
    const endDate =
      `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    const resp = await axios.get(url, {
      params: {
        fundCode,
        pageIndex: 1,
        pageSize: 5,
        startDate: "",
        endDate,
      },
      responseType: "text",
      headers: {
        Referer: "https://fundf10.eastmoney.com/",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
    });
    let data = resp.data;
    if (typeof data === "string") {
      const trim = data.trim();
      if (trim.startsWith("{")) {
        try {
          data = JSON.parse(data);
        } catch {
          data = {};
        }
      } else {
        const lp = data.indexOf("(");
        const rp = data.lastIndexOf(")");
        if (lp !== -1 && rp > lp) {
          try {
            data = JSON.parse(data.slice(lp + 1, rp));
          } catch {
            data = {};
          }
        } else {
          data = {};
        }
      }
    }
    const list = data?.Data?.LSJZList || data?.data?.LSJZList || data?.data?.lsjzList;
    if (!Array.isArray(list) || list.length === 0) return null;
    const latest = list[0];
    const nav = latest?.DWJZ != null ? Number(latest.DWJZ) : (latest?.dwjz != null ? Number(latest.dwjz) : null);
    const date = latest?.FSRQ || latest?.fsrq || null;
    const result = nav != null ? { navDisclosed: nav, navDisclosedDate: date } : null;
    if (result) setCache(cacheKey, result, 10 * 60 * 1000);
    return result;
  } catch (e) {
    return null;
  }
}

// 工具：根据股票代码推断 secid（东财：0. 深 / 1. 沪 / 116. 港）
function stockCodeToSecId(stockCode) {
  const code = String(stockCode).replace(/[^0-9]/g, "");
  if (!code) return null;
  if (code.startsWith("6") && code.length >= 6) return `1.${code}`;
  if ((code.startsWith("0") || code.startsWith("2") || code.startsWith("3")) && code.length >= 6)
    return `0.${code}`;
  if (code.length === 5 || code.length === 4) return `116.${code.padStart(5, "0")}`;
  return null;
}

// 工具：股票代码转新浪/腾讯 list 代码（sh/sz/hk + 代码）
function stockCodeToSinaList(stockCode) {
  const code = String(stockCode).replace(/[^0-9]/g, "");
  if (!code) return null;
  if (code.startsWith("6") && code.length >= 6) return `sh${code}`;
  if ((code.startsWith("0") || code.startsWith("2") || code.startsWith("3")) && code.length >= 6)
    return `sz${code}`;
  if (code.length === 5 || code.length === 4) return `hk${code.padStart(5, "0")}`;
  return null;
}

// 工具：新浪行情获取涨跌幅（兜底）
async function fetchStockQuotePctChangeSina(stockCode) {
  const listCode = stockCodeToSinaList(stockCode);
  if (!listCode) return null;

  const url = `https://hq.sinajs.cn/list=${listCode}`;
  const resp = await axios.get(url, {
    responseType: "text",
    headers: {
      Referer: "https://finance.sina.com.cn/",
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
  });

  const m = resp.data.match(/hq_str_[^=]+="([^"]*)"/);
  if (!m || !m[1]) return null;
  const parts = m[1].split(",");
  const isHK = listCode.startsWith("hk");
  let prev, last, name;
  if (isHK) {
    // 港股：0英文名 1中文名 2今开 3昨收 4最高 5最低 6现价 7涨跌 8涨跌%
    prev = parseFloat(parts[3]);
    last = parseFloat(parts[6]);
    name = (parts[1] || parts[0] || "").trim();
  } else {
    // A股：0名称 1今开 2昨收 3现价
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
  return {
    stockCode,
    name,
    lastPrice: last,
    prevPrice: prev,
    pctChange,
  };
}

// 工具：腾讯行情获取涨跌幅（兜底）
async function fetchStockQuotePctChangeTencent(stockCode) {
  const listCode = stockCodeToSinaList(stockCode);
  if (!listCode) return null;
  try {
    const url = `https://qt.gtimg.cn/q=${listCode}`;
    const resp = await axios.get(url, {
      responseType: "text",
      timeout: 5000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
    });
    const m = resp.data.match(/="([^"]+)"/);
    if (!m || !m[1]) return null;
    const parts = m[1].split("~");
    const last = parseFloat(parts[3]);
    const prev = parseFloat(parts[4]);
    if (!Number.isFinite(prev) || !Number.isFinite(last) || prev === 0) return null;
    // 优先使用接口返回的涨跌%（索引 32），与行情一致
    const raw32 = parts[32] !== undefined && parts[32] !== "" ? String(parts[32]).replace(/%/g, "").trim() : "";
    const pctDirect = raw32 !== "" ? parseFloat(raw32) : NaN;
    const pctChange = Number.isFinite(pctDirect)
      ? pctDirect
      : ((last - prev) / prev) * 100;
    return {
      stockCode,
      name: parts[1] || "",
      lastPrice: last,
      prevPrice: prev,
      pctChange,
    };
  } catch (e) {
    return null;
  }
}

// 工具：获取单只股票实时行情（pctChange 百分比），东财失败则走新浪、腾讯
async function fetchStockQuotePctChange(stockCode) {
  const secid = stockCodeToSecId(stockCode);
  const cacheKey = `quote:${secid || stockCode}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  let result = null;
  const isHK = secid && secid.startsWith("116.");

  if (isHK) {
    try {
      result = await fetchStockQuotePctChangeTencent(stockCode);
    } catch (e) {}
    if (!result) {
      try {
        result = await fetchStockQuotePctChangeSina(stockCode);
      } catch (e) {}
    }
  }

  if (!result && secid) {
    try {
      const url = "https://push2.eastmoney.com/api/qt/stock/get";
      const resp = await axios.get(url, {
        params: { secid, fields: "f43,f60,f58,f170" },
        timeout: 5000,
        headers: {
          Referer: "https://quote.eastmoney.com/",
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        },
      });
      const d = resp.data && resp.data.data;
      if (d) {
        const lastRaw = d.f43;
        const prevRaw = d.f60;
        const pctDirect = d.f170;
        const isHK = secid.startsWith("116.");
        const rawMax = Math.max(Number(lastRaw) || 0, Number(prevRaw) || 0);
        const scale = isHK ? (rawMax > 1000 ? 100 : 1) : 100;
        const lastPrice = lastRaw != null ? Number(lastRaw) / scale : null;
        const prevPrice = prevRaw != null ? Number(prevRaw) / scale : null;
        const computedPct =
          lastPrice != null && prevPrice != null && prevPrice !== 0
            ? ((lastPrice - prevPrice) / prevPrice) * 100
            : null;
        const pctNum = pctDirect != null && Number.isFinite(Number(pctDirect)) ? Number(pctDirect) : null;
        if (pctNum != null) {
          result = {
            stockCode,
            name: d.f58 || "",
            lastPrice,
            prevPrice,
            pctChange: pctNum,
          };
        } else if (computedPct != null && Number.isFinite(computedPct)) {
          result = {
            stockCode,
            name: d.f58 || "",
            lastPrice,
            prevPrice,
            pctChange: computedPct,
          };
        }
      }
    } catch (e) {
      // 忽略，下面用新浪兜底
    }
  }

  if (!result) {
    try {
      result = await fetchStockQuotePctChangeSina(stockCode);
    } catch (e) {
      // 忽略
    }
  }
  if (!result) {
    try {
      result = await fetchStockQuotePctChangeTencent(stockCode);
    } catch (e) {
      // 忽略
    }
  }

  if (result) setCache(cacheKey, result, 2 * 1000);
  return result;
}

// 工具：抓取基金前十大重仓
async function fetchTop10Holdings(fundCode) {
  const cacheKey = `holdings:${fundCode}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  const holdings = [];

  try {
    // 使用 F10DataApi JSON 接口获取前十大重仓 HTML 片段，然后再解析表格
    const url = "https://fundf10.eastmoney.com/FundArchivesDatas.aspx";
    const resp = await axios.get(url, {
      params: {
        type: "jjcc",
        code: fundCode,
        topline: 10,
      },
      responseType: "text",
      headers: {
        Referer: `https://fundf10.eastmoney.com/ccmx_${fundCode}.html`,
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
    });

    const text = resp.data || "";
    // 返回格式：var apidata={content:"<table>...</table>",...}; 内容中可能有 \"
    const m = text.match(/content:"((?:[^"\\]|\\.)*)"/);
    if (!m || !m[1]) {
      setCache(cacheKey, holdings, 30 * 60 * 1000);
      return holdings;
    }

    let html = m[1].replace(/\\"/g, '"').replace(/\\n/g, "\n").replace(/\\r/g, "");

    const $ = cheerio.load(html);
    // 只解析第一个表格（最近季度），可能有 thead+tbody 或全是 tr
    const firstTable = $("table").first();
    const rows = firstTable.find("tbody tr").length ? firstTable.find("tbody tr") : firstTable.find("tr");

    rows.each((_, tr) => {
      const tds = $(tr).find("td");
      if (tds.length < 3) return;
      if (holdings.length >= 10) return;

      const firstCell = $(tds[0]).text().trim();
      if (!/^\d+$/.test(firstCell)) return;

      const codeTd = tds[1];
      let codeText = $(codeTd).text().trim();
      const digits = codeText.replace(/\D/g, "");
      codeText = digits.length >= 6 ? digits.slice(-6) : digits || codeText;
      const stockName = $(tds[2]).text().trim();
      if (!codeText || codeText.length < 5) return;

      let exchange = null;
      const href = $(codeTd).find("a").first().attr("href") || "";
      const secidMatch = href.match(/\/unify\/r\/(\d+)\.\d+/);
      if (secidMatch) {
        const market = secidMatch[1];
        if (market === "0") exchange = "SZ";
        else if (market === "1") exchange = "SH";
        else if (market === "116") exchange = "HK";
      }

      let weight = null;
      for (let i = 3; i < tds.length; i++) {
        const w = $(tds[i]).text().trim();
        if (!w.includes("%")) continue;
        const match = w.match(/(\d+\.?\d*)\s*%?/);
        if (match) {
          const val = parseFloat(match[1]);
          if (val > 0 && val < 100) {
            weight = val / 100;
            break;
          }
        }
      }

      const finalCode =
        codeText.length === 5 || codeText.length >= 6 ? codeText : codeText.padStart(6, "0");
      holdings.push({
        stockCode: finalCode,
        stockName: stockName || "—",
        weight: Number.isFinite(weight) ? weight : null,
        exchange: exchange,
      });
    });
  } catch (e) {
    console.error("fetchTop10Holdings error", fundCode, e.message);
  }

  setCache(cacheKey, holdings, 6 * 60 * 60 * 1000); // 6 小时缓存
  return holdings;
}

// 估算基金：基于前十大 + 实时报价
async function estimateFundByTop10(fundCode) {
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
  const fundPctChangeEst =
    hasAnyQuote ? Rf * 100 : base.pctChangeOfficial != null ? base.pctChangeOfficial : 0;
  const navEstByLegs =
    hasAnyQuote && navPrev != null
      ? navPrev * (1 + Rf)
      : base.navEstOfficial != null
        ? base.navEstOfficial
        : null;

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

// API: 前十大重仓
app.get("/api/fund/:code/holdings", async (req, res) => {
  const code = req.params.code;
  try {
    const holdings = await fetchTop10Holdings(code);
    const base = await fetchFundBaseFromFundGz(code);
    res.json({
      fundCode: base.fundCode || code,
      name: base.name,
      holdings,
    });
  } catch (e) {
    console.error("holdings error", code, e.message);
    res.status(500).json({ error: e.message || "内部错误" });
  }
});

// API: 基于前十大分解的实时估值
app.get("/api/fund/:code/estimate", async (req, res) => {
  const code = req.params.code;
  try {
    const est = await estimateFundByTop10(code);
    res.json(est);
  } catch (e) {
    const msg = e && e.message ? e.message : "内部错误";
    console.error("estimate error", code, msg);
    const is404 = /404|不存在/i.test(String(msg));
    res.status(is404 ? 404 : 500).json({ error: msg });
  }
});

app.listen(PORT, () => {
  console.log(`Fund server running at http://localhost:${PORT}`);
});

