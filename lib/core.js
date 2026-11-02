// 상품 조회 · 추가 · 삭제 API 공용 모듈 (실습 전용, 외부 패키지 없음)
// 로컬 서버(server.js)와 Vercel 함수(api/index.js)가 같이 쓴다
// 데이터: SUPABASE_URL + 키가 있으면 Supabase, 없으면 data.json
//  - 읽기: SUPABASE_ANON_KEY (없으면 SERVICE_ROLE 키)
//  - 쓰기: SUPABASE_SERVICE_ROLE_KEY 가 있을 때만(RLS가 anon 쓰기를 막음). 키는 브라우저로 보내지 않음
//  - Vercel: 공개 주소라 ALLOW_WRITE=1 까지 있어야 쓰기 허용, data.json 은 읽기 전용
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const DATA_FILE = path.join(ROOT, "data.json");
const TABLES = ["products", "storage_rules", "allergens", "product_allergens", "cautions", "shipping_policies"];

// .env 읽기 (없으면 무시, Vercel은 환경변수 설정을 씀)
try {
  process.loadEnvFile(path.join(ROOT, ".env"));
} catch {}
const ON_VERCEL = process.env.VERCEL === "1";
const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const READ_KEY = process.env.SUPABASE_ANON_KEY || SERVICE_KEY;
const USE_SUPABASE = Boolean(SUPABASE_URL && READ_KEY);
const WRITABLE = USE_SUPABASE
  ? Boolean(SERVICE_KEY) && (!ON_VERCEL || process.env.ALLOW_WRITE === "1")
  : !ON_VERCEL; // Vercel 파일 시스템은 저장해도 남지 않음
const READONLY_REASON = !USE_SUPABASE
  ? "읽기 전용: Vercel에서는 data.json에 저장할 수 없음"
  : !SERVICE_KEY
    ? "읽기 전용: SUPABASE_SERVICE_ROLE_KEY가 없음"
    : "읽기 전용: 배포 환경에서는 ALLOW_WRITE=1이 있어야 쓰기 가능";

// 01_schema.sql 의 CHECK 제약과 같은 값 목록
const CODES = {
  category: ["신선식품", "가공식품", "냉동식품"],
  allergen_label: ["없음(명시)", "있음"],
  timing: ["개봉 전", "개봉 후", "수령 후"],
  temperature: ["상온", "냉장", "냉동"],
  relation: ["함유", "교차오염"],
  type: ["조리·사용금지", "섭취주의", "보관팁", "사용팁"],
  source_section: ["설명", "보관법", "알레르기 · 원산지", "배송"],
};

// ---- 입력 검증: 테이블별로 허용 필드만 남기고 형식 확인
class BadRequest extends Error {}

function pick(body, spec) {
  const row = {};
  for (const [k, rule] of Object.entries(spec)) {
    let v = body?.[k];
    if (typeof v === "string") v = v.trim();
    if (v === "" || v === undefined) v = null;
    if (rule.bool) v = v === true || v === "true";
    if (rule.int && v !== null) {
      v = Number(v);
      if (!Number.isInteger(v) || v <= 0) throw new BadRequest(`${rule.label}: 1 이상의 정수`);
    }
    if (rule.req && v === null) throw new BadRequest(`${rule.label}: 필수 항목`);
    if (rule.codes && v !== null && !CODES[rule.codes].includes(v)) throw new BadRequest(`${rule.label}: 허용되지 않는 값 '${v}'`);
    if (typeof v === "string" && v.length > 1000) throw new BadRequest(`${rule.label}: 너무 김`);
    row[k] = v;
  }
  return row;
}

const SOURCE = {
  source_doc: { label: "출처문서", req: true },
  source_section: { label: "섹션", req: true, codes: "source_section" },
  source_text: { label: "원문", req: true },
};
const SPEC = {
  products: {
    product_id: { label: "상품코드", req: true }, name: { label: "상품명", req: true },
    category: { label: "분류", req: true, codes: "category" }, price: { label: "판매가", req: true, int: true },
    net_weight: { label: "용량" }, pack_info: { label: "구성" }, origin: { label: "원산지" },
    ingredients: { label: "원재료" }, description: { label: "상품설명" }, sale_period: { label: "판매기간" },
    allergen_label: { label: "알레르기 문서표기", req: true, codes: "allergen_label" },
    source_doc: { label: "출처문서", req: true },
  },
  storage_rules: {
    product_id: { label: "상품코드", req: true }, timing: { label: "시점", req: true, codes: "timing" },
    temperature: { label: "보관온도", req: true, codes: "temperature" }, allowed: { label: "허용", bool: true },
    days: { label: "보관일수", int: true }, period_text: { label: "원문 표기" }, note: { label: "사유·비고" },
    emphasized: { label: "강조", bool: true }, ...SOURCE,
  },
  product_allergens: {
    product_id: { label: "상품코드", req: true }, allergen_id: { label: "알레르기", req: true },
    relation: { label: "관계", req: true, codes: "relation" }, emphasized: { label: "강조", bool: true }, ...SOURCE,
  },
  cautions: {
    product_id: { label: "상품코드", req: true }, type: { label: "유형", req: true, codes: "type" },
    content: { label: "내용", req: true }, emphasized: { label: "강조", bool: true }, ...SOURCE,
  },
};

function validate(table, body) {
  const row = pick(body, SPEC[table]);
  if (table === "products" && !/^P-\d{4}$/.test(row.product_id)) throw new BadRequest("상품코드: P-0000 형식");
  if (table === "storage_rules") {
    // 금지면 보관일수 없음, 가능이면 보관일수 필수 (스키마 제약 + 검사 탭 규칙)
    if (!row.allowed && row.days !== null) throw new BadRequest("보관일수: 금지 행에는 비워야 함");
    if (row.allowed && row.days === null) throw new BadRequest("보관일수: 가능 행에는 필수");
  }
  return row;
}

// ---- 저장소: data.json
function readFile() {
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
}

function writeFile(data) {
  // 직전 상태를 .bak 으로 남기고, 임시 파일에 쓴 뒤 교체
  fs.copyFileSync(DATA_FILE, DATA_FILE + ".bak");
  const tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  fs.renameSync(tmp, DATA_FILE);
}

const fileStore = {
  async all() {
    return readFile();
  },
  async insert(table, row) {
    const d = readFile();
    const has = (t, f) => d[t].some(f);
    // DB의 기본키 · 외래키 제약을 파일에서도 똑같이 확인
    if (table === "products") {
      if (has("products", (p) => p.product_id === row.product_id)) throw new BadRequest(`이미 있는 상품코드 ${row.product_id}`);
    } else if (!has("products", (p) => p.product_id === row.product_id)) {
      throw new BadRequest(`없는 상품코드 ${row.product_id}`);
    }
    if (table === "product_allergens") {
      if (!has("allergens", (a) => a.allergen_id === row.allergen_id)) throw new BadRequest(`없는 알레르기코드 ${row.allergen_id}`);
      if (has("product_allergens", (r) => r.product_id === row.product_id && r.allergen_id === row.allergen_id)) {
        throw new BadRequest("이미 등록된 알레르기");
      }
    }
    if (table === "storage_rules" || table === "cautions") {
      row = { id: d[table].reduce((m, r) => Math.max(m, r.id || 0), 0) + 1, ...row };
    }
    d[table].push(row);
    writeFile(d);
    return row;
  },
  async remove(table, match) {
    const d = readFile();
    const hit = (r) => Object.entries(match).every(([k, v]) => String(r[k]) === String(v));
    const before = d[table].length;
    d[table] = d[table].filter((r) => !hit(r));
    const removed = before - d[table].length;
    if (table === "products" && removed) {
      // on delete cascade 와 같은 동작
      for (const t of ["storage_rules", "product_allergens", "cautions"]) {
        d[t] = d[t].filter((r) => r.product_id !== match.product_id);
      }
    }
    if (removed) writeFile(d);
    return removed;
  },
};

// ---- 저장소: Supabase REST
const TABLE_LABEL = {
  products: "상품", storage_rules: "보관조건", allergens: "알레르기", product_allergens: "상품 알레르기",
  cautions: "주의사항", shipping_policies: "배송정책",
};
// 열 이름 → 한국어 라벨 (SPEC에서 모음)
const COL_LABEL = Object.assign({},
  ...Object.values(SPEC).map((s) => Object.fromEntries(Object.entries(s).map(([k, r]) => [k, r.label]))),
  { allergen_id: "알레르기코드" });  // 오류 문장에서는 '코드'로 구분
const cols = (s) => s.split(",").map((c) => COL_LABEL[c.trim()] || c.trim()).join(" · ");

// Postgres · PostgREST 오류를 한국어 문장으로. 모르는 코드는 원문 그대로
function pgError(json, status) {
  const d = json?.details || "";
  const key = d.match(/Key \(([^)]+)\)=\(([^)]*)\)/);   // [전체, 열, 값]
  const tbl = d.match(/table "([^"]+)"/)?.[1];
  const what = key ? `${cols(key[1])} '${key[2]}'` : "값";
  switch (json?.code) {
    case "23505": return `이미 등록된 ${what}입니다`;
    case "23503":
      if (/still referenced/.test(d)) return `${what}을(를) ${TABLE_LABEL[tbl] || tbl}에서 쓰고 있어 삭제할 수 없습니다`;
      return `${what}이(가) ${TABLE_LABEL[tbl] || tbl || "참조 테이블"}에 없습니다`;
    case "23514": {
      const c = json.message?.match(/constraint "([^"]+)"/)?.[1] || "";
      if (c === "storage_days_only_when_allowed") return "보관 금지인 행에는 보관일수를 넣을 수 없습니다";
      const col = Object.keys(COL_LABEL).find((k) => c.endsWith(`_${k}_check`));
      return `${col ? COL_LABEL[col] : "입력값"}이(가) 허용 범위를 벗어났습니다`;
    }
    case "23502": {
      const col = json.message?.match(/column "([^"]+)"/)?.[1];
      return `${COL_LABEL[col] || col || "필수 항목"}: 필수 항목`;
    }
    case "22P02": return "값의 형식이 맞지 않습니다";
    case "42501": return "권한이 없습니다 (service_role 키 확인)";
  }
  if (status === 401 || /JWT/.test(json?.message || "")) return "Supabase 키가 맞지 않습니다 (.env 확인)";
  return null;
}

async function supa(method, pathAndQuery, { key = READ_KEY, body } = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    // 제약 위반 등은 사용자에게 보여줄 메시지로
    const raw = json?.message || text || `HTTP ${res.status}`;
    const ko = pgError(json, res.status);
    if (ko) console.warn(`[supabase ${json?.code || res.status}] ${raw}`);  // 원문은 서버 로그에만
    const msg = ko || raw;
    if (res.status >= 400 && res.status < 500) throw new BadRequest(msg);
    throw new Error(msg);
  }
  return json;
}

const supaStore = {
  async all() {
    const data = {};
    for (const t of TABLES) data[t] = await supa("GET", `${t}?select=*`);
    return data;
  },
  async insert(table, row) {
    const [created] = await supa("POST", table, { key: SERVICE_KEY, body: row });
    return created;
  },
  async remove(table, match) {
    const q = Object.entries(match).map(([k, v]) => `${k}=eq.${encodeURIComponent(v)}`).join("&");
    const rows = await supa("DELETE", `${table}?${q}`, { key: SERVICE_KEY });
    return rows.length;
  },
};

const store = USE_SUPABASE ? supaStore : fileStore;

// ---- HTTP
function send(res, status, type, body) {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(body);
}
const json = (res, status, obj) => send(res, status, "application/json; charset=utf-8", JSON.stringify(obj));

function readBody(req) {
  // Vercel은 본문을 미리 읽어 req.body 로 넘겨줌
  if (ON_VERCEL) {
    let b;
    try {
      b = req.body;
    } catch {
      throw new BadRequest("JSON 형식 오류");
    }
    if (typeof b === "string") {
      try {
        b = JSON.parse(b || "{}");
      } catch {
        throw new BadRequest("JSON 형식 오류");
      }
    }
    if (JSON.stringify(b ?? {}).length > 100_000) throw new BadRequest("요청이 너무 큼");
    return Promise.resolve(b ?? {});
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > 100_000) {
        reject(new BadRequest("요청이 너무 큼"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}"));
      } catch {
        reject(new BadRequest("JSON 형식 오류"));
      }
    });
    req.on("error", reject);
  });
}

// 쓰기 요청은 이 페이지에서 보낸 것만 허용(다른 사이트가 몰래 보내는 요청 차단)
function isTrustedWrite(req, originOk) {
  const origin = req.headers.origin;
  return (!origin || originOk(origin)) && req.headers["x-viewer"] === "1" &&
    (req.headers["content-type"] || "").startsWith("application/json");
}

// 삭제 경로 → 조건. /api/products/P-0113, /api/storage_rules/3, /api/product_allergens/P-0402/A01
function deleteMatch(table, parts) {
  if (table === "products" && parts.length === 1) return { product_id: parts[0] };
  if ((table === "storage_rules" || table === "cautions") && parts.length === 1 && /^\d+$/.test(parts[0])) return { id: Number(parts[0]) };
  if (table === "product_allergens" && parts.length === 2) return { product_id: parts[0], allergen_id: parts[1] };
  return null;
}

// /api/* 처리. pathname 은 '/api/...' 형태, originOk(origin) 은 호출하는 쪽이 정함
async function handleApi(req, res, pathname, { originOk }) {
  const [, api, table, ...parts] = pathname.split("/").map(decodeURIComponent);
  try {
    if (api !== "api") return json(res, 404, { error: "not found" });
    if (req.method === "GET" && table === "data" && parts.length === 0) {
      return json(res, 200, {
        source: USE_SUPABASE ? "supabase" : "data.json",
        writable: WRITABLE,
        codes: CODES,
        data: await store.all(),
        loadedAt: new Date().toISOString(),
      });
    }
    if (SPEC[table] && (req.method === "POST" || req.method === "DELETE")) {
      if (!isTrustedWrite(req, originOk)) return json(res, 403, { error: "허용되지 않은 요청" });
      if (!WRITABLE) return json(res, 403, { error: READONLY_REASON });
      if (req.method === "POST" && parts.length === 0) {
        const row = validate(table, await readBody(req));
        return json(res, 201, { row: await store.insert(table, row) });
      }
      if (req.method === "DELETE") {
        const match = deleteMatch(table, parts);
        if (!match) return json(res, 400, { error: "삭제 경로 형식 오류" });
        const removed = await store.remove(table, match);
        return removed ? json(res, 200, { removed }) : json(res, 404, { error: "삭제할 행이 없음" });
      }
    }
    json(res, 404, { error: "not found" });
  } catch (err) {
    if (err instanceof BadRequest) return json(res, 400, { error: err.message });
    console.error(err);
    json(res, 500, { error: String(err.message || err) });
  }
}

const MODE = USE_SUPABASE ? `supabase (${WRITABLE ? "쓰기 가능" : "읽기 전용"})` : `data.json (${WRITABLE ? "쓰기 가능" : "읽기 전용"})`;

module.exports = { ROOT, MODE, send, handleApi };
