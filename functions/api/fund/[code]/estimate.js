import { estimateFundByTop10, jsonResponse } from "../../_lib.js";

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
    const est = await estimateFundByTop10(code);
    return jsonResponse(est, { headers: { "Cache-Control": "public, max-age=0, s-maxage=60" } });
  } catch (e) {
    const msg = e && e.message ? e.message : "内部错误";
    const is404 = /404|不存在/i.test(String(msg));
    return jsonResponse({ error: msg }, { status: is404 ? 404 : 500 });
  }
}

