// AI 문제풀이 (실험용): 로그인한 사용자가 올린 문제 사진/PDF를 Claude로 풀어서 텍스트로 돌려준다.
// - 로그인 확인은 이 함수 안에서 직접 한다(verify_jwt=false).
// - 하루 사용 횟수는 public.ai_usage_bump()로 제한한다(사용자별 + 전체).
// - API 키는 Supabase 함수 비밀값 ANTHROPIC_API_KEY 에서만 읽는다(코드/브라우저에 없음).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const MODELS: Record<string, string> = { fast: "claude-haiku-5-5", accurate: "claude-sonnet-5-5" };
const USER_LIMIT = 5;      // 한 명이 하루에 풀 수 있는 횟수
const GLOBAL_LIMIT = 20;   // 전체 사용자 합계(요금 폭주 방지)
const MAX_FILES = 5;
const MAX_TOTAL_B64 = 6_000_000;  // base64 글자 수 합계 (약 4.5MB)
const ALLOWED = ["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"];

const SYSTEM = [
  "당신은 학생의 문제 풀이를 도와주는 선생님입니다.",
  "첨부된 문제(사진 또는 PDF)를 읽고, 문제 번호별로 풀이 과정을 한국어로 차근차근 쓰고, 각 문제 끝에 '정답:'을 분명히 적습니다.",
  "노트 필기처럼 짧은 문장과 줄바꿈으로 씁니다. 인사말이나 긴 서론은 쓰지 않습니다.",
  "수식은 일반 글자로 씁니다(예: x^2, 분수는 a/b, 루트는 √). LaTeX 기호($, \\frac 등)는 쓰지 않습니다.",
  "글자나 그림이 흐려서 확신이 없는 부분은 추측한 내용 뒤에 '(확인 필요)'를 붙입니다.",
  "문제가 아닌 내용이면 문제를 찾지 못했다고 짧게 말합니다.",
].join("\n");

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  // 1) 로그인 확인
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "unauthorized" }, 401);
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: ud, error: ue } = await admin.auth.getUser(token);
  if (ue || !ud?.user) return json({ error: "unauthorized" }, 401);
  const uid = ud.user.id;

  // 2) 요청 검사
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  const files = Array.isArray(body?.files) ? body.files : [];
  if (!files.length || files.length > MAX_FILES) return json({ error: "bad_files", message: `파일은 1~${MAX_FILES}개까지 올릴 수 있어요.` }, 400);
  let total = 0;
  for (const f of files) {
    if (!f || typeof f.data !== "string" || !ALLOWED.includes(f.type)) return json({ error: "bad_files", message: "사진(JPG/PNG/WEBP) 또는 PDF만 올릴 수 있어요." }, 400);
    total += f.data.length;
  }
  if (total > MAX_TOTAL_B64) return json({ error: "too_large", message: "파일이 너무 커요. 사진은 줄여서, PDF는 페이지를 나눠서 올려 주세요." }, 413);
  const model = MODELS[body?.mode === "accurate" ? "accurate" : "fast"];
  const note = typeof body?.note === "string" ? body.note.slice(0, 500) : "";

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json({ error: "not_configured", message: "서버에 AI 키가 아직 설정되지 않았어요." }, 503);

  // 3) 하루 사용 횟수 확인(통과하면 1회 차감)
  const { data: bump, error: be } = await admin.rpc("ai_usage_bump", { p_user: uid, p_user_limit: USER_LIMIT, p_global_limit: GLOBAL_LIMIT });
  if (be) return json({ error: "server_error", message: "사용 횟수를 확인하지 못했어요." }, 500);
  if (bump === "user_limit") return json({ error: "user_limit", message: `오늘 사용 횟수(${USER_LIMIT}번)를 다 썼어요. 내일 다시 이용해 주세요.` }, 429);
  if (bump === "global_limit") return json({ error: "global_limit", message: "오늘은 전체 사용량이 가득 찼어요. 내일 다시 이용해 주세요." }, 429);
  const remaining = Number(String(bump).split(":")[1] ?? 0);
  const refund = () => admin.rpc("ai_usage_refund", { p_user: uid });

  // 4) Claude 호출
  const content: unknown[] = files.map((f: { type: string; data: string }) =>
    f.type === "application/pdf"
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: f.data } }
      : { type: "image", source: { type: "base64", media_type: f.type, data: f.data } });
  content.push({ type: "text", text: note ? `풀이 요청 사항: ${note}` : "첨부한 문제를 모두 풀어 주세요." });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 110_000);
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 3500, system: SYSTEM, messages: [{ role: "user", content }] }),
      signal: ctrl.signal,
    });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) {
      await refund();
      console.error("anthropic error", r.status, JSON.stringify(out).slice(0, 500));
      const msg = r.status === 401 ? "AI 키가 올바르지 않아요."
        : r.status === 402 || r.status === 403 ? "AI 사용 한도나 결제 상태를 확인해 주세요."
        : r.status === 429 ? "AI가 지금 바빠요. 잠시 뒤에 다시 시도해 주세요."
        : "AI가 풀이를 만들지 못했어요.";
      return json({ error: "ai_error", status: r.status, message: msg, detail: out?.error?.message ?? null }, 502);
    }
    const text = (out.content || []).filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join("\n").trim();
    if (!text) { await refund(); return json({ error: "empty", message: "풀이가 비어 있어요. 다시 시도해 주세요." }, 502); }
    return json({ text, remaining, model, usage: out.usage ?? null });
  } catch (e) {
    await refund();
    const aborted = e instanceof DOMException && e.name === "AbortError";
    return json({ error: "ai_error", message: aborted ? "시간이 너무 오래 걸려서 멈췄어요. 파일을 줄여서 다시 시도해 주세요." : "AI 서버에 연결하지 못했어요." }, 502);
  } finally {
    clearTimeout(timer);
  }
});
