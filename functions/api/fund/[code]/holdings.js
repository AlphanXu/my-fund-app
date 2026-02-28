import { fetchFundBaseFromFundGz, fetchTop10Holdings, jsonResponse } from "../../_lib.js";

function getCodeFromContext(context) {
  const direct = context?.params?.code;
  if (direct) return String(direct);
  try {
    const url = new URL(context.request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const idx = parts.indexOf("fund");
    if (idx !== -1 && parts[idx + 1]) return parts[idx + 1];
  } catch {}
  return "";
}

export async function onRequestGet(context) {
  const code = getCodeFromContext(context);
  if (!/^\d{6}$/.test(code)) return jsonResponse({ error: "基金代码无效" }, { status: 400 });

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

