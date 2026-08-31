# Better Harness Task-Loop Report

## At a Glance

- Loop Effectiveness: 58/100 (changes only after comparable later task outcomes)
- Asset Health / Repair Progress: 0/100 (0 verified, 0 partial, 6 pending)
- Demonstrated autonomy radius: not observed (not observed; not observed confidence)
- Strongest loop: Not enough evidence difference to name one.
- Largest observed leak: Use the priority moves; no single loop is uniquely weakest.
- Top expected gain: No priority benefit is available in this evidence boundary.

## What You Can Rely On Today

- No reliable user outcome has been demonstrated in this evidence boundary yet.

## What You Gain Next

- No priority Harness move is available in this evidence boundary.



### Why these moves matter

### Công việc của chính pack vô hình với mọi phân tích phiên
- Priority: Medium · Evidence: not observed in this boundary
- Reason: Sự thật: quần thể phiên cho workspace này rỗng toàn phần (0 eligible, 0 loại trừ — rỗng TRƯỚC bước lọc) kèm cảnh báo missing-optional-root; đồng thời cửa sổ đóng băng ở 00:00Z ngày cuối nên hoạt động trong ngày bench bị loại theo thiết kế. Suy luận đã xác minh bởi lead: phiên làm việc thật được lưu dưới khoá của thư mục cha nơi Lead vận hành, không phải dưới repo được bench. Chủ sở hữu: ranh giới thu thập bằng chứng của quy trình bench trong runbook. Bất định: không xác định được có phiên nào ở khoá khác ngoài cửa sổ hay không.
- Expected Output:
  1. Người bench tiếp theo biết chính xác chạy bundle ở đâu và với cửa sổ nào để vòng học nhìn thấy episode của chính pack.

### Repo quản trị agent nhưng không cho agent sửa chính nó một entrypoint máy-đọc-được
- Priority: Medium · Evidence: not observed in this boundary
- Reason: Sự thật: không có AGENTS.md/CLAUDE.md/.claude/ nào được track (xác minh ls-files bởi hai lane độc lập); provider resolve 0 rules/0 skills/0 hooks ở phạm vi dự án dù manifest quản trị 45 file; preflight của skills/paseo-team-lead trỏ tới AGENTS.md/WORKSPACE_PROTOCOL.md 'if present' và tìm không thấy gì. Suy luận: mỗi phiên sửa pack phải tự tái dựng ranh giới core/companion và bộ lệnh chuẩn từ README rời rạc. Chủ sở hữu: file chỉ dẫn gốc còn thiếu tại root. Bất định: mức độ README bù đắp được cho agent chưa đo.
- Expected Output:
  1. Agent mở repo lần đầu đọc được một trang duy nhất nói: đây là gì, lệnh nào là chuẩn, đổi gì thì phải đồng bộ gì.

### ci.yml giữ các cổng cưỡng chế nhưng nằm ngoài chu vi digest chính sách
- Priority: Medium · Evidence: not observed in this boundary
- Reason: Sự thật: manifest.json không liệt kê .github/workflows/ci.yml trong khi file này chứa npm test, policy-digest --check và check-report-gates — các cổng pre-merge duy nhất; một thay đổi làm suy yếu cổng không làm --check đỏ. Suy luận: chu vi 'governed bytes' hụt đúng file định nghĩa việc cưỡng chế các byte đó. Chủ sở hữu: GOVERNED_FILES trong scripts/policy-digest.mjs. Bất định: không có.
- Expected Output:
  1. Suy yếu cổng CI trở thành thay đổi có dấu vết digest như mọi byte được quản trị khác.

### preflight.mjs không có test hành vi — chính comment CI thừa nhận
- Priority: Medium · Evidence: not observed in this boundary
- Reason: Sự thật: không tồn tại test/preflight.test.mjs; ci.yml ghi nguyên văn rằng preflight không có importing test và chỉ được node --check bảo vệ; ngoài 2 probe nhờ trong test/policy-digest.test.mjs, bề mặt doctor/setup (~865 dòng) không có bằng chứng hành vi. Suy luận: regression logic (không phải lỗi parse) tới thẳng người dùng. Chủ sở hữu: file test đối ứng còn thiếu. Bất định: không có.
- Expected Output:
  1. Bề mặt readiness chính có bằng chứng hành vi qua process boundary thay vì chỉ syntax check.

### Cổng report chỉ ràng buộc báo cáo tự khai Gate: v1 — báo cáo mới viết tay có thể lặng lẽ đứng ngoài
- Priority: Low · Evidence: not observed in this boundary
- Reason: Sự thật: cả 3 báo cáo hiện có đều pre-gate (gated=0 pregate=3 failed=0), pass 'by declaration' đúng thiết kế cho di sản; template scaffold đã phát marker cho báo cáo mới. Suy luận: không cơ chế nào ép báo cáo SINH SAU ngày cắt phải mang marker — một báo cáo viết tay bỏ marker sẽ né cổng vĩnh viễn. Chủ sở hữu: scripts/check-report-gates.mjs. Bất định: chưa có episode nào như vậy xảy ra.
- Expected Output:
  1. Pre-gate là trạng thái di sản đóng, không phải lối thoát cho báo cáo tương lai.

### Hai cặp file tham chiếu được quản trị nhân đôi byte-identical giữa hai skill và có thể phân kỳ im lặng
- Priority: Low · Evidence: not observed in this boundary
- Reason: Sự thật: manifest ghi cùng sha256 cho proof-debt-catalog.md và structural-antipatterns.md dưới cả paseo-premise-audit lẫn paseo-ultra-review; policy-digest --check so từng file nên chỉnh một phía + refresh hợp lệ là phân kỳ không dấu vết. Suy luận: hai skill review chủ lực có thể trôi khỏi nhau về doctrine. Chủ sở hữu: cặp file references + một parity assert còn thiếu. Bất định: chưa rõ nhân đôi là chủ đích portable hay tình cờ.
- Expected Output:
  1. Phân kỳ doctrine giữa hai skill review bị chặn bằng test thay vì dựa vào trí nhớ.

## Five Lifecycle Dimensions

| Dimension | What the evidence proves | Evidence boundary | Summary | Boundary / blocker |
| --- | --- | --- | --- | --- |
| Task Understanding | Not observed yet | not observed in this boundary | Brief V3, protocol và runbook mô tả ranh giới rõ cho repo ĐƯỢC quản trị; nhưng agent sửa CHÍNH pack không có AGENTS.md/CLAUDE.md nào để đọc, và preflight của skill chủ lực tìm không thấy bề mặt rules. | not observed |
| Controlled Execution | Not observed yet | not observed in this boundary | Hook PreToolUse tồn tại và được cài ở phạm vi người dùng, nhưng ở phạm vi dự án provider resolve 0 hook/0 skill; các cổng thực thi dồn về CI trong khi chính ci.yml nằm ngoài chu vi digest. | not observed |
| Change Validation | Not observed yet | not observed in this boundary | Suite 39 test với killing-test theo từng fix và tuyến chạy tường minh (npm test); còn hai lỗ được chỉ đích danh: preflight.mjs không có test hành vi, và cổng report chỉ ràng buộc báo cáo tự khai Gate: v1. | not observed |
| Reliable Delivery | Not observed yet | not observed in this boundary | Installer được test bằng thực thi sandbox và deploy có versioning git; nhưng không có bằng chứng repo-side nào về chấp nhận trước-merge (lịch sử tuyến tính, branch protection chưa xác minh). | not observed |
| Learning Capture | Not observed yet | not observed in this boundary | Sổ tay, watchlist và digest EOD tồn tại và được nối dây; nhưng 0 Task Episode quan sát được trong cửa sổ — công việc thật của pack diễn ra dưới khoá phiên khác nên vòng học chưa từng nhìn thấy một episode nào của chính nó. | not observed |

## The 15 Small Checks

| Dimension | Small check | What the evidence proves | Evidence boundary |
| --- | --- | --- | --- |


## Evidence and Boundaries

- Episode coverage: 0 episodes, 0 edited, 0 closed, 0 repaired-and-passed
- Model: agent-work-loop-v4
- Session selection: not observed; 0 sessions analyzed of 0 eligible sessions; not observed confidence
- Delivery grades observed: not observed
- Source gaps: not observed
- Learning comparison: Not observed; 0 declared intervention(s)
