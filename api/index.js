// Vercel 서버리스 함수: /api/* 요청을 모두 받아 lib/core.js 로 넘김
// vercel.json 이 /api/data → /api/index?__path=data 로 바꿔서 보냄
const { handleApi } = require("../lib/core");

// 쓰기 요청의 Origin 이 지금 접속한 배포 주소와 같은지 확인
function originOkFor(req) {
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return (origin) => {
    try {
      const u = new URL(origin);
      return u.protocol === "https:" && u.host === host;
    } catch {
      return false;
    }
  };
}

module.exports = async (req, res) => {
  const url = new URL(req.url, "http://x");
  const sub = url.searchParams.get("__path");
  const pathname = sub !== null ? `/api/${sub}` : url.pathname;
  return handleApi(req, res, pathname, { originOk: originOkFor(req) });
};
