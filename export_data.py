# products_db.xlsx v3 시트 → data.json (DB와 같은 영문 필드명)
# 실행: python export_data.py [--force]  (이 폴더 기준 ../products_db.xlsx 를 읽음)
# 페이지에서 추가 · 삭제한 data.json이 엑셀보다 최신이면 덮어쓰지 않음(--force로 강제)
import json
import sys
from pathlib import Path
from openpyxl import load_workbook

here = Path(__file__).parent
xlsx = here.parent / "products_db.xlsx"
out = here / "data.json"
if out.exists() and out.stat().st_mtime > xlsx.stat().st_mtime and "--force" not in sys.argv:
    sys.exit("data.json이 엑셀보다 최신입니다(페이지에서 수정한 내용이 있을 수 있음). 덮어쓰려면 --force")
wb = load_workbook(xlsx)


def rows(sheet, mapping):
    # mapping: {엑셀 머리글: 영문 필드명}. Y/N 머리글은 boolean으로
    ws = wb[sheet]
    head = [c.value for c in ws[1]]
    out = []
    for r in ws.iter_rows(min_row=2, values_only=True):
        if r[0] is None:
            continue
        d = dict(zip(head, r))
        item = {}
        for k, field in mapping.items():
            v = d.get(k)
            if k in ("허용", "강조"):
                v = v == "Y"
            elif v == "":
                v = None
            item[field] = v
        out.append(item)
    return out


src = {"출처문서": "source_doc", "섹션": "source_section", "원문": "source_text"}
data = {
    "products": rows("상품_v3", {
        "상품코드": "product_id", "상품명": "name", "분류": "category", "판매가": "price",
        "용량": "net_weight", "구성": "pack_info", "원산지": "origin", "원재료": "ingredients",
        "상품설명": "description", "판매기간": "sale_period", "알레르기 문서표기": "allergen_label",
        "출처문서": "source_doc",
    }),
    "storage_rules": rows("보관조건_v3", {
        "상품코드": "product_id", "시점": "timing", "보관온도": "temperature", "허용": "allowed",
        "보관일수": "days", "원문 표기": "period_text", "사유·비고": "note", "강조": "emphasized", **src,
    }),
    "allergens": rows("알레르기", {"알레르기코드": "allergen_id", "이름": "name"}),
    "product_allergens": rows("상품_알레르기", {
        "상품코드": "product_id", "알레르기코드": "allergen_id", "관계": "relation", "강조": "emphasized", **src,
    }),
    "cautions": rows("주의사항_v3", {
        "상품코드": "product_id", "유형": "type", "내용": "content", "강조": "emphasized", **src,
    }),
    "shipping_policies": [
        {"item": r["item"], "value": str(r["value"])}
        for r in rows("배송정책", {"항목": "item", "값": "value"}) if r["value"] is not None
    ],
}

# DB의 identity 열과 맞추기 위해 1부터 행 ID 부여
for t in ("storage_rules", "cautions"):
    data[t] = [{"id": i, **r} for i, r in enumerate(data[t], start=1)]

out.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
print({k: len(v) for k, v in data.items()})
