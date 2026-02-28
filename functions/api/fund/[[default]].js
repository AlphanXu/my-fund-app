import { estimateFundByTop10, fetchFundBaseFromFundGz, fetchTop10Holdings, jsonResponse } from "./_lib.js";

function parseRoute(requestUrl) {
  const url = new URL(requestUrl);
  const parts = url.pathname.split("/").filter(Boolean);
  const fundIdx = parts.indexOf("fund");
  const rest = fundIdx === -1 ? [] : parts.slice(fundIdx + 1);
  const code = rest[0] || "";
  const action = rest[1] || "";
  return { code, action };
}

export async function onRequestGet(context) {
  const { code, action } = parseRoute(context.request.url);
  if (!/^\d{6}$/.test(code)) return jsonResponse({ error: "基金代码无效" }, { status: 400 });

  if (action === "estimate") {
    try {
      const est = await estimateFundByTop10(code);
      return jsonResponse(est, { headers: { "Cache-Control": "public, max-age=0, s-maxage=60" } });
    } catch (e) {
      const msg = e && e.message ? e.message : "内部错误";
      const is404 = /404|不存在/i.test(String(msg));
      return jsonResponse({ error: msg }, { status: is404 ? 404 : 500 });
    }
  }

  if (action === "holdings") {
    try {
      const [holdings, base] = await Promise.all([fetchTop10Holdings(code), fetchFundBaseFromFundGz(code)]);
      return jsonResponse(
        { fundCode: base.fundCode || code, name: base.name, holdings },
        { headers: { "Cache-Control": "public, max-age=0, s-maxage=3600" } },
      );
    } catch (e) {
      const msg = e && e.message ? e.message : "内部错误";
      return jsonResponse({ error: msg }, { status: 500 });
    }
  }

  return jsonResponse({ error: "Not Found" }, { status: 404 });
}

