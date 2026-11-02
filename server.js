// 상품 조회 · 검사 · 추가 · 삭제용 로컬 서버 (실습 전용, 외부 패키지 없음)
// 실행: node server.js  →  http://127.0.0.1:4173
// API · 검증 · 저장소는 lib/core.js (Vercel 함수 api/index.js 와 공용)
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { ROOT, MODE, send, handleApi } = require("./lib/core");

const HOST = "127.0.0.1"; // 로컬에서만 접속 가능
const PORT = Number(process.env.PORT) || 4173;
// 이 이름으로 들어온 요청만 처리(DNS 리바인딩 방지)
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const originOk = (origin) => ALLOWED_HOSTS.has(origin.replace(/^http:\/\//, ""));

const server = http.createServer(async (req, res) => {
  if (!ALLOWED_HOSTS.has(req.headers.host)) return send(res, 403, "text/plain; charset=utf-8", "forbidden host");
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
    return send(res, 200, "text/html; charset=utf-8", fs.readFileSync(path.join(ROOT, "index.html")));
  }
  if (pathname.startsWith("/api/")) return handleApi(req, res, pathname, { originOk });
  // 그 외 경로 · 파일은 제공하지 않음(.env 노출 방지)
  send(res, 404, "text/plain; charset=utf-8", "not found");
});

server.listen(PORT, HOST, () => {
  console.log(`상품 조회 서버: http://${HOST}:${PORT}  데이터: ${MODE}`);
});
