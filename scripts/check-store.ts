/**
 * 存储层场景自检（不参与构建）
 * 用内存版 localStorage 模拟持久化，校验确认/修正/删除护栏与版本历史。
 */
import "./localstorage-polyfill";
import { ledgerStore } from "../src/invoice/store";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) pass += 1;
  else {
    fail += 1;
    console.error(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// 清空种子，构造可控场景（store 模块在 polyfill 安装后才加载，首装即为空）
check("首次无存储为空台账", ledgerStore.entries.length === 0, `len=${ledgerStore.entries.length}`);

// 1. 正常登记两个衔接班次
const r1 = ledgerStore.createEntry({
  date: "2026-09-20",
  shift: "早班",
  first: "00000101",
  last: "00000200",
  amount: "1000",
  voids: [{ ticket: "", reason: "" }]
});
check("登记 a 成功", r1.ok);
const idA = r1.entryId as string;

const r2 = ledgerStore.createEntry({
  date: "2026-09-20",
  shift: "中班",
  first: "00000201",
  last: "00000300",
  amount: "2000",
  voids: [{ ticket: "00000250", reason: "打歪" }]
});
check("登记 b 成功", r2.ok);
const idB = r2.entryId as string;

// 2. 同日期同班次再登记 → 被挡
const dup = ledgerStore.createEntry({
  date: "2026-09-20",
  shift: "早班",
  first: "00000001",
  last: "00000002",
  amount: "1",
  voids: []
});
check("重复班次被挡", !dup.ok && dup.blocked?.issues[0].code === "SHIFT_DUPLICATE");
check("被挡含原值新值", dup.blocked?.oldValue.includes("未登记") && dup.blocked?.newValue.includes("早班"));

// 3. 命中跳号的班次保持待复核，确认被挡
const gap = ledgerStore.createEntry({
  date: "2026-09-20",
  shift: "晚班",
  first: "00000400",
  last: "00000500",
  amount: "3000",
  voids: []
});
check("跳号仍存为待复核", !gap.ok); // 返回 blocked 但数据已存
const idC = gap.entryId as string;
const entryC = ledgerStore.entries.find((e) => e.id === idC);
check("跳号班次状态待复核", entryC?.status === "待复核");
const cf = ledgerStore.confirmEntry(idC);
check("跳号确认被挡", !cf.ok && cf.blocked?.issues.some((i) => i.code === "GAP"));
check(
  "被挡展示票号段",
  cf.blocked?.ticketSegment.includes("00000301") && cf.blocked?.ticketSegment.includes("00000399"),
  cf.blocked?.ticketSegment
);

// 4. 作废原因空也挡确认（先把 C 修衔接、再隔离 D 的作废问题）
ledgerStore.updateDraft(idC, {
  date: "2026-09-20",
  shift: "晚班",
  first: "00000301",
  last: "00000400",
  amount: "3000",
  voids: []
});

const badVoid = ledgerStore.createEntry({
  date: "2026-09-21",
  shift: "早班",
  first: "00000401",
  last: "00000500",
  amount: "500",
  voids: [{ ticket: "00000450", reason: "" }]
});
const idD = badVoid.entryId as string;
const cfD = ledgerStore.confirmEntry(idD);
check(
  "作废原因空挡确认",
  !cfD.ok && cfD.blocked?.issues.some((i) => i.code === "VOID_REASON_EMPTY"),
  cfD.blocked?.reason
);

// 5. 补齐原因后四班均可确认
ledgerStore.updateDraft(idD, {
  date: "2026-09-21",
  shift: "早班",
  first: "00000401",
  last: "00000500",
  amount: "500",
  voids: [{ ticket: "00000450", reason: "打印机卡纸作废" }]
});
for (const id of [idA, idB, idC, idD]) {
  const r = ledgerStore.confirmEntry(id);
  check(`确认 ${id} 成功`, r.ok, r.blocked?.reason);
}

// 6. 确认后修改被挡且金额不动
const lock = ledgerStore.updateDraft(idA, {
  date: "2026-09-20",
  shift: "早班",
  first: "00000101",
  last: "00000200",
  amount: "9999",
  voids: []
});
check("已复核修改被挡", !lock.ok && lock.blocked?.issues[0].code === "CONFIRMED_LOCKED");
const aStill = ledgerStore.entries.find((e) => e.id === idA);
check("已复核金额未变", aStill?.amount === "1000");

// 7. 已复核删除被挡
const delLocked = ledgerStore.removeEntry(idA);
check("已复核删除被挡", !delLocked.ok && delLocked.blocked?.issues[0].code === "CONFIRMED_LOCKED");

// 8. 无原因修正被挡
const noReason = ledgerStore.correctEntry(idA, "  ", {
  date: "2026-09-20",
  shift: "早班",
  first: "00000101",
  last: "00000200",
  amount: "1000",
  voids: []
});
check("空修正原因被挡", !noReason.ok && noReason.blocked?.issues[0].code === "CORRECT_REASON_EMPTY");

// 9. 有原因修正：新版本、旧内容保留、回到待复核
const corr = ledgerStore.correctEntry(idA, "金额录错，实际收款 1200", {
  date: "2026-09-20",
  shift: "早班",
  first: "00000101",
  last: "00000200",
  amount: "1200",
  voids: []
});
check("修正成功", corr.ok, corr.blocked?.reason);
const aFixed = ledgerStore.entries.find((e) => e.id === idA);
check("修正后当前版本 v2", aFixed?.currentVersion === 2);
check("修正后回到待复核", aFixed?.status === "待复核");
check("历史保留 2 版", aFixed?.versionHistory.length === 2);
check("旧版金额保留 1000", aFixed?.versionHistory[0].amount === "1000");
check("新版金额 1200", aFixed?.versionHistory[1].amount === "1200");
check("新版带修正原因", aFixed?.versionHistory[1].reason === "金额录错，实际收款 1200");
check("旧版无修正原因字段", aFixed?.versionHistory[0].reason === undefined);

// 10. 占用仍只有每个班次一段（不因历史版本翻倍）
check("占用段数 = 班次数", ledgerStore.occupied.length === 4, `occ=${ledgerStore.occupied.length}`);

// 11. localStorage 已持久化
const raw = localStorage.getItem("dfwlfront-7-invoice-ledger-v1");
check("localStorage 已写入", !!raw);
ledgerStore.dismissBlocked();
check("dismiss 清空 blocked", ledgerStore.blocked === null);

// 12. 待复核可删除（a 已因修正回到待复核；已复核的 c 删除仍会被挡）
const confirmedDel = ledgerStore.removeEntry(idC);
check("已复核删除仍被挡", !confirmedDel.ok && confirmedDel.blocked?.issues[0].code === "CONFIRMED_LOCKED");
const pendingDel = ledgerStore.removeEntry(idA);
check("待复核删除成功", pendingDel.ok);
check("删除后占用段减少", ledgerStore.occupied.length === 3);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
