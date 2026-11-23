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
const MAX_FILES = 8;       // 이미지(쪽) 개수. PDF는 브라우저에서 쪽마다 이미지로 바꿔서 보낸다
const MAX_TOTAL_B64 = 6_000_000;  // base64 글자 수 합계 (약 4.5MB)
const ALLOWED = ["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"];

const SYSTEM = [
  "당신은 학생의 문제 풀이를 도와주는 선생님입니다.",
  "첨부된 이미지는 문제지의 각 쪽입니다(첨부한 순서대로 1, 2, 3…번 이미지). 문제를 읽고 풀어서, 풀이를 문제지 위에 손으로 필기하듯 써 넣을 위치와 글을 write_solutions 도구로 제출하세요.",
  "- 문제마다 항목(items)을 하나씩 만듭니다. 한 문제가 여러 쪽에 걸쳐 있으면 쪽마다 따로 만듭니다.",
  "- x, y, w, h는 그 이미지 전체를 가로 1000 × 세로 1000으로 본 좌표입니다(왼쪽 위가 0,0). 풀이를 쓸 '빈 공간'의 사각형입니다.",
  "- 빈 공간은 문제 글자·그림·표·보기를 가리지 않는 곳(문제 바로 아래, 옆 여백, 빈 줄)에서 고릅니다. 상자끼리 겹치지 않게 합니다.",
  "- 빈 공간이 모자라면 이미지 아래에 빈 종이가 이어져 있다고 보고 y+h가 1000을 넘는 상자를 씁니다(최대 1800까지).",
  "- text는 노트 필기처럼 짧게 씁니다. 핵심 식과 계산만 줄바꿈(\\n)으로 나누어 쓰고 마지막 줄에 '정답: …'을 적습니다. 상자에 들어갈 만큼만 쓰고, 상자가 작으면 글을 줄입니다. 한 줄에 20글자 안팎이 읽기 좋습니다.",
  "- 수식은 일반 글자로 씁니다(예: x^2, 분수는 a/b, 루트는 √). LaTeX 기호($, \\frac 등)는 쓰지 않습니다.",
  "- 글자나 그림이 흐려서 확신이 없는 부분은 추측한 내용 뒤에 '(확인 필요)'를 붙입니다.",
  "- summary에는 같은 풀이를 문제 번호 순서대로 조금 더 자세히 씁니다(인사말과 서론 없이).",
  "- 문제가 아닌 내용이면 items를 비우고 summary에 문제를 찾지 못했다고 짧게 씁니다.",
].join("\n");

const TOOL = {
  name: "write_solutions",
  description: "문제지 이미지 위에 필기할 풀이를 제출한다.",
  input_schema: {
    type: "object",
    properties: {
      summary: { type: "string", description: "문제 번호순 전체 풀이 텍스트" },
      pages: {
        type: "array",
        items: {
          type: "object",
          properties: {
            image: { type: "integer", description: "첨부한 이미지 번호(1부터)" },
            items: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  label: { type: "string", description: "문제 번호" },
                  x: { type: "number" }, y: { type: "number" }, w: { type: "number" }, h: { type: "number" },
                  text: { type: "string", description: "상자 안에 필기할 풀이(줄바꿈 가능)" },
                },
                required: ["x", "y", "w", "h", "text"],
              },
            },
          },
          required: ["image", "items"],
        },
      },
    },
    required: ["summary", "pages"],
  },
};

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
  content.push({ type: "text", text: (note ? `풀이 요청 사항: ${note}\n` : "첨부한 문제를 모두 풀어 주세요.\n") + `이미지는 모두 ${files.length}장입니다.` });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 110_000);
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      // thinking을 끈다: 응답이 16~17초 걸리고 비어 있던 원인이 "생각하는 데 토큰을 다 써서 글이 안 나온 것"일 것으로 추정(미확인).
      // 그래도 비면 아래 "empty answer" 로그/응답의 stop_reason, blocks 값으로 실제 원인을 확인한다.
      // 필기 위치와 글은 도구 호출(write_solutions)로 받는다 → 항상 정해진 JSON 모양으로 온다.
      body: JSON.stringify({ model, max_tokens: 8000, thinking: { type: "disabled" }, system: SYSTEM, tools: [TOOL], tool_choice: { type: "tool", name: "write_solutions" }, messages: [{ role: "user", content }] }),
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
    const blocks = (out.content || []) as Array<{ type: string; text?: string; input?: any }>;
    if (out.stop_reason === "max_tokens") {
      await refund();
      console.error("max_tokens", JSON.stringify({ model, usage: out.usage ?? null }));
      return json({ error: "too_long", message: "풀이가 너무 길어서 끝까지 쓰지 못했어요. 문제 수를 줄이거나(예: 1~3번만) 쪽을 나눠서 올려 주세요." }, 502);
    }
    const tool = blocks.find((c) => c.type === "tool_use");
    const inp = tool?.input ?? {};
    const num = (v: unknown, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number(v) || 0));
    // 위치/글 정리: 이미지 번호가 범위 안인지, 좌표가 말이 되는지 확인한다
    const pages = (Array.isArray(inp.pages) ? inp.pages : []).map((pg: any) => ({
      image: Math.round(Number(pg?.image) || 0),
      items: (Array.isArray(pg?.items) ? pg.items : []).slice(0, 40).map((it: any) => ({
        label: String(it?.label ?? "").slice(0, 20),
        x: num(it?.x, 0, 990), y: num(it?.y, 0, 1790), w: num(it?.w, 30, 1000), h: num(it?.h, 20, 1000),
        text: String(it?.text ?? "").slice(0, 1500),
      })).filter((it: { text: string }) => it.text.trim()),
    })).filter((pg: { image: number; items: unknown[] }) => pg.image >= 1 && pg.image <= files.length && pg.items.length);
    let text = typeof inp.summary === "string" ? inp.summary.trim() : "";
    if (!text) text = blocks.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n").trim();
    if (!text && !pages.length) {
      await refund();
      // 왜 비었는지 알 수 있게 종료 이유와 블록 종류를 로그와 응답에 남긴다
      const types = blocks.map((c) => c.type).join(",");
      console.error("empty answer", JSON.stringify({ model, stop_reason: out.stop_reason, types, usage: out.usage ?? null }));
      return json({ error: "empty", message: "풀이가 비어 있어요. 다시 시도해 주세요.", detail: `stop_reason=${out.stop_reason ?? "?"}, blocks=${types || "none"}` }, 502);
    }
    if (!text) text = pages.map((pg: { items: { label: string; text: string }[] }) => pg.items.map((it) => (it.label ? it.label + "번\n" : "") + it.text).join("\n\n")).join("\n\n");
    return json({ text, pages, remaining, model, usage: out.usage ?? null });
  } catch (e) {
    await refund();
    const aborted = e instanceof DOMException && e.name === "AbortError";
    return json({ error: "ai_error", message: aborted ? "시간이 너무 오래 걸려서 멈췄어요. 파일을 줄여서 다시 시도해 주세요." : "AI 서버에 연결하지 못했어요." }, 502);
  } finally {
    clearTimeout(timer);
  }
});
