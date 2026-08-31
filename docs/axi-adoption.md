# AXI trong harness — dùng bộ nào, ở đâu, và bộ nào bị từ chối

Báo cáo đo trên bytes hiện tại (`main` @ `61ef55b`, manifest `sha256:07bb06f2`, 46 governed file).
Mọi dòng "đã dùng" đều có lệnh tái lập được. Diagram: `docs/diagrams/`.

AXI = 10 quy ước output CLI cho agent, chia 4 nhóm (nguồn:
`research/axi/00-TONG-HOP.md §1`; audit gốc: `research/axi/int-03-axi-in-harness.md`).

---

## 0. TL;DR — 3 câu

1. Harness dùng **6/10** nguyên tắc; **2 nguyên tắc là xương sống** (P4 tổng hợp
   tính sẵn, P6 lỗi có cấu trúc + exit code) — chúng có mặt ở **9/11 script** và
   được test giết.
2. **2 nguyên tắc bị từ chối vì CHI PHÍ** (P1 TOON đo ra thua, P9 `help[]` nhét
   vào payload) — không phải vì ghét, mà vì đo rồi.
3. **2 nguyên tắc bị từ chối vì AN TOÀN và bị ĐẢO NGƯỢC** (P5 "empty là câu trả
   lời dứt khoát" → ở đây empty = **vi phạm, exit 3**; P7 ambient context bản AXI
   yếu hơn bản hook sẵn có). Đây là chỗ đáng kể nhất của cả báo cáo.

---

## 1. Bảng verdict 10 nguyên tắc

| # | Nguyên tắc AXI | Verdict | Bằng chứng sống |
|---|---|---|---|
| **P4** | **Tổng hợp tính sẵn** (agent không phải tự đếm) | **DÙNG — xương sống** | `governance-graph --assert` trả `meta.scan {listedTotal:122, scopedTotal:2, rendered:2, truncated:false, uninspected:0}` |
| **P6** | **Lỗi có cấu trúc + exit code** | **DÙNG — xương sống** | 6 tool trả envelope + `exit 2`; `--assert` thêm `exit 3` = có vi phạm |
| P3 | Cắt bớt nhưng có tín hiệu | DÙNG | `cwdUnresolvedDetail` cắt ở 20, kèm `cwdUnresolved: 21` — số đếm LÀ tín hiệu; `eod-digest` cap 200 dòng + dòng `Truncation:` |
| P2 | Schema mặc định tối thiểu | DÙNG (qua cửa khác) | `--assert` là projection tối thiểu (violations/cannotVerify/meta) thay vì đổ nguyên React Flow layout cho agent |
| P10 | Help nhất quán | DÙNG (một phần) | `--help` ở `governance-graph`, `ultra-review-report`, `ocr-review`, `eod-digest` |
| P8 | Nội dung trước | DÙNG (một phần) | Report/digest đặt decision lên đầu, accounting xuống footer |
| P1 | Output TOON | **TỪ CHỐI — chi phí** | đo: thua JSON trên chính corpus này (`int-03 §4`) |
| P9 | `help[]` nhúng trong payload | **TỪ CHỐI — chi phí** | noise mỗi lần gọi; help sống ở `--help` |
| **P5** | **Empty state dứt khoát → exit 0** | **TỪ CHỐI — AN TOÀN → ĐẢO NGƯỢC** | A6: `scopedTotal===0 && listedTotal>0` ⇒ **VI PHẠM, exit 3** |
| **P7** | Ambient context qua SessionStart | **TỪ CHỐI — AN TOÀN** | bản hook hiện tại mạnh hơn: authority đọc từ V3 brief mỗi lượt, không phải inject 1 lần |

---

## 2. P4 + P6 nằm ở đâu — bảng phủ theo script

| Script | P4 tổng hợp | P6 envelope + exit |
|---|---|---|
| `governance-graph.mjs` | `meta.scan` 5 trường + `meta.roleSweep {known, labeled, errors}` | `USAGE` → 2 · violations → **3** |
| `eod-digest.mjs` | footer: `sources scanned 3/4 · missing 1 · malformed 0`, counts đủ 6 loại | `USAGE`/`WORKSPACE_MISSING` → 2 |
| `check-report-gates.mjs` | `gate check: gated=0 pregate=3 failed=0` | `USAGE`/`DIR_MISSING` → 2 · gate fail → 1 |
| `ocr-review.mjs` | `discovered_count / selected_count / excluded_count` | → 2 |
| `ultra-review-report.mjs` | roster: `SCOUTS_PLANNED/SUBMITTED/MISSING`, `DISCOVERED_FILES/FILES_UNREACHED` | `USAGE` → 2 |
| `preflight.mjs` | `--version` → `{name, version, policyDigest, fileCount}` | `unknown_flag`/`missing_flag_value` → 2 |
| `policy-digest.mjs` | `fileCount` + per-file hash | `unknown_flag` → 2 · stale → 1 |
| `reconcile-observer.mjs` | `sources.*.ok`, `orphanScan.totalDiscovered` | (library — không có CLI, đúng thiết kế) |
| `watchdog.mjs` | ❌ chưa có aggregate | envelope có, → 2 |
| `model-routing.mjs` | ❌ | usage text, → **64** (lệch chuẩn) |

**Nợ còn lại, khai thật:** `watchdog` chưa có denominator/aggregate;
`model-routing` exit 64 + usage text thay vì envelope (đã ghi record-only ở
pack-ship F012, không chặn dùng hằng ngày).

---

## 3. Chỗ quan trọng nhất: P5 bị đảo ngược

AXI nói: *empty state phải dứt khoát* — trả rỗng, exit 0, đừng bắt agent đoán.
Với một CLI tra cứu thì đúng. Với **một cổng fail-closed** thì đó là fail-open.

Cùng một input — scan trả 0 agent trong scope — hai policy ra hai kết luận:

```
AXI P5     : rỗng ⇒ đó là câu trả lời ⇒ exit 0 ⇒ "topology sạch"
Harness A6 : rỗng NHƯNG listedTotal=122 ⇒ scope sai, không phải sạch ⇒ exit 3
```

Câu đang nằm trong code: *"an empty scan is not a clean topology — check the
scope spelling, or use --all"*. Gõ nhầm `--cwd` mà cổng sáng vẫn xanh là đúng
kiểu lỗi harness sinh ra để chặn. Xem `docs/diagrams/axi-p5-inversion.html`.

Cùng logic đó áp cho P7: bản AXI inject ngữ cảnh **một lần** lúc SessionStart;
hook ở đây đọc authority từ V3 brief **mỗi lượt** — brief cũ không cấp quyền cho
lượt mới. Giữ bản mạnh hơn.

---

## 4. Use case — AXI trả tiền ở đâu trong ngày

### UC-1 · Cổng sáng, 5 giây, không cần đọc list (P4 + P6)
```bash
node scripts/governance-graph.mjs --assert --cwd <repo>; echo "exit=$?"
```
Agent **không** phải scan mảng agent để tự đếm. `meta.scan` nói sẵn 122 listed /
2 scoped; exit code nói sẵn có vi phạm hay không. `exit 3` = dừng, sửa topology
trước khi dispatch. Đây là P4 đúng nghĩa: *không round-trip để đếm*.

### UC-2 · Gõ nhầm flag không được phép chạy tiếp (P6)
```bash
node scripts/preflight.mjs --stict   # → exit 2, {"error":"unknown_flag", known:[...]}
```
Sự cố thật đã xảy ra: `--stict` từng chạy non-strict và in `ok:true` — một cổng
nghiệm thu bị vô hiệu im lặng. Giờ `known[]` in ra để agent tự sửa mà không cần
hỏi. Có test hành vi (`test/preflight.test.mjs`) + kill evidence.

### UC-3 · Không bao giờ đọc nhầm "cắt" thành "hết" (P3)
`--assert` trên fleet thật trả `cwdUnresolved: 21` nhưng `cwdUnresolvedDetail`
chỉ 20 phần tử. Agent đọc số đếm, biết còn 1 cái không thấy → không kết luận
"chỉ có 20". Cùng cơ chế: `eod-digest` cap 200 dòng + tự khai `Truncation:`.

### UC-4 · Digest cuối ngày là *quyết định*, không phải log (P8 + P4)
```bash
node scripts/eod-digest.mjs --workspace .
```
Section chỉ hiện khi non-empty; ngày yên tĩnh ra digest NGẮN. Footer accounting
luôn có: nguồn nào scan/miss/malformed, policy digest nào đang chạy. Ngày
`26-08-30` ra đúng **1 anomaly pre-gate, 0 decision** — không flood 25 dòng.

### UC-5 · CI đọc exit code, không đọc prose (P6)
```yaml
- run: node scripts/policy-digest.mjs --check          # drift → exit 1
- run: node scripts/check-report-gates.mjs docs/ultrareview  # gate fail → exit 1
```
Cổng pre-merge không cần parse output. Cả hai đều có killing test cho **chính
đường exit**, sau khi review bắt được một cổng CI trước đó đảo `exit(1)`→`exit(0)`
mà cả suite vẫn xanh.

### UC-6 · Chống fail-open khi scope sai (P5 đảo ngược)
Chạy cổng sáng từ nhầm thư mục → **exit 3**, không phải "0 vi phạm". Nếu theo
đúng AXI P5, ca này im lặng xanh.

---

## 5. Diagram

| File | Loại | Trả lời câu |
|---|---|---|
| `docs/diagrams/axi-adoption-matrix.html` | Quadrant | Nguyên tắc nào được nhận, nguyên tắc nào bị loại, **vì lý do gì** |
| `docs/diagrams/axi-cli-contract.html` | Sequence | Một lần gọi CLI trả về gì cho agent, 3 exit code sinh ra ở đâu |
| `docs/diagrams/axi-p5-inversion.html` | Flowchart (paired traces) | Cùng input, hai policy, chỗ rẽ đầu tiên |

Diagram dùng skin mặc định của skill (chưa onboard brand token cho repo này).

---

## 6. Kết luận một dòng

Harness không "AXI-compliant" — nó **lấy 2 nguyên tắc làm xương sống, 4 nguyên
tắc làm tiện ích, từ chối 2 vì đo được là lỗ, và đảo ngược 2 vì fail-closed
quan trọng hơn gọn gàng**. Chỗ AXI sai với một cổng an toàn thì ghi rõ là sai và
chạy ngược lại — có test giữ.
