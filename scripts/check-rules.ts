/**
 * 规则层场景自检（不参与构建，仅用 esbuild 临时转译后 node 运行）
 */
import {
  collectOccupied,
  formatTicket,
  parseTicket,
  tailExpectation,
  validateSequence,
  type SequenceShift
} from "../src/invoice/rules";

let pass = 0;
let fail = 0;

function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass += 1;
  } else {
    fail += 1;
    console.error(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function shift(p: Partial<SequenceShift> & { id: string; date: string; shift: string }): SequenceShift {
  return {
    first: "",
    last: "",
    amount: "100",
    voids: [],
    ...p
  };
}

function codes(list: SequenceShift, exclude?: string): string[] {
  return validateSequence(list, exclude).map((i) => i.code);
}

// 1. 解析/补零
check("parseTicket 合法", parseTicket("123") === 123);
check("parseTicket 超 8 位非法", parseTicket("123456789") === null);
check("parseTicket 非数字非法", parseTicket("12a") === null);
check("formatTicket 补零", formatTicket(123) === "00000123");

// 2. 正常衔接：09-19 晚班尾 00001120 → 09-20 早班首 00001121
const chainOk: SequenceShift[] = [
  shift({ id: "a", date: "2026-09-19", shift: "晚班", first: "00001001", last: "00001120" }),
  shift({ id: "b", date: "2026-09-20", shift: "早班", first: "00001121", last: "00001200" })
];
check("正常衔接无问题", codes(chainOk).length === 0, JSON.stringify(codes(chainOk)));

// 3. 跳号：期望 1121，实填 1130
const gap: SequenceShift[] = [
  shift({ id: "a", date: "2026-09-19", shift: "晚班", first: "00001001", last: "00001120" }),
  shift({ id: "b", date: "2026-09-20", shift: "早班", first: "00001130", last: "00001200" })
];
const gapIssues = validateSequence(gap);
check("跳号报 GAP", gapIssues.some((i) => i.code === "GAP"));
check("跳号票号段为缺口", gapIssues[0]?.ticketSegment === "00001121-00001129", gapIssues[0]?.ticketSegment);
check("跳号原值新值", gapIssues[0]?.oldValue.includes("00001121") && gapIssues[0]?.newValue.includes("00001130"));

// 4. 重号：首号落入前段
const dup: SequenceShift[] = [
  shift({ id: "a", date: "2026-09-19", shift: "晚班", first: "00001001", last: "00001120" }),
  shift({ id: "b", date: "2026-09-20", shift: "早班", first: "00001100", last: "00001200" })
];
check("重号报 DUP_CONTINUITY", codes(dup).includes("DUP_CONTINUITY"));

// 5. 跨日回绕一次：合法
const wrapOk: SequenceShift[] = [
  shift({ id: "a", date: "2026-09-19", shift: "晚班", first: "99999900", last: "99999999" }),
  shift({ id: "b", date: "2026-09-20", shift: "早班", first: "00000000", last: "00000050" })
];
check("跨日回绕合法", codes(wrapOk).length === 0, JSON.stringify(codes(wrapOk)));
check("回绕后期望值 51", tailExpectation(wrapOk).expectedFirst === "00000051");
check("wrapUsed 为真", tailExpectation(wrapOk).wrapUsed === true);

// 6. 同日回绕：非法 WRAP_SAME_DAY
const wrapSameDay: SequenceShift[] = [
  shift({ id: "a", date: "2026-09-20", shift: "早班", first: "99999900", last: "99999999" }),
  shift({ id: "b", date: "2026-09-20", shift: "中班", first: "00000000", last: "00000050" })
];
check("同日回绕报 WRAP_SAME_DAY", codes(wrapSameDay).includes("WRAP_SAME_DAY"));

// 7. 第二次跨日回绕：WRAP_EXHAUSTED
const wrapTwice: SequenceShift[] = [
  shift({ id: "a", date: "2026-09-19", shift: "晚班", first: "99999900", last: "99999999" }),
  shift({ id: "b", date: "2026-09-20", shift: "早班", first: "00000000", last: "00000050" }),
  shift({ id: "c", date: "2026-09-20", shift: "中班", first: "00000051", last: "99999999" }),
  shift({ id: "d", date: "2026-09-21", shift: "早班", first: "00000000", last: "00000009" })
];
const twiceCodes = codes(wrapTwice);
check("第二次回绕报 WRAP_EXHAUSTED", twiceCodes.includes("WRAP_EXHAUSTED"), JSON.stringify(twiceCodes));

// 8. 作废原因空
const voidEmpty: SequenceShift[] = [
  shift({
    id: "a",
    date: "2026-09-20",
    shift: "早班",
    first: "00000001",
    last: "00000010",
    voids: [{ ticket: "00000003", reason: "  " }]
  })
];
check("作废原因空报 VOID_REASON_EMPTY", codes(voidEmpty).includes("VOID_REASON_EMPTY"));

// 9. 作废越界
const voidOut: SequenceShift[] = [
  shift({
    id: "a",
    date: "2026-09-20",
    shift: "早班",
    first: "00000001",
    last: "00000010",
    voids: [{ ticket: "00000011", reason: "x" }]
  })
];
check("作废越界报 VOID_OUT_OF_RANGE", codes(voidOut).includes("VOID_OUT_OF_RANGE"));

// 10. 作废重号
const voidDup: SequenceShift[] = [
  shift({
    id: "a",
    date: "2026-09-20",
    shift: "早班",
    first: "00000001",
    last: "00000010",
    voids: [
      { ticket: "00000003", reason: "x" },
      { ticket: "00000003", reason: "y" }
    ]
  })
];
check("作废重号报 VOID_DUPLICATE", codes(voidDup).includes("VOID_DUPLICATE"));

// 11. 无效票号 / 金额
const invalid: SequenceShift[] = [
  shift({ id: "a", date: "2026-09-20", shift: "早班", first: "12", last: "5", amount: "abc" })
];
const invalidCodes = codes(invalid);
check("首尾倒置报 TICKET_INVALID", invalidCodes.includes("TICKET_INVALID"));
check("金额非法报 AMOUNT_INVALID", invalidCodes.includes("AMOUNT_INVALID"));

// 12. 同日期同班次重复
const shiftDup: SequenceShift[] = [
  shift({ id: "a", date: "2026-09-20", shift: "早班", first: "00000001", last: "00000010" }),
  shift({ id: "b", date: "2026-09-20", shift: "早班", first: "00000011", last: "00000020" })
];
check("同班次重复报 SHIFT_DUPLICATE", codes(shiftDup).includes("SHIFT_DUPLICATE"));

// 13. 非相邻号段重叠
const overlap: SequenceShift[] = [
  shift({ id: "a", date: "2026-09-20", shift: "早班", first: "00000001", last: "00000100" }),
  shift({ id: "b", date: "2026-09-20", shift: "中班", first: "00000101", last: "00000200" }),
  shift({ id: "c", date: "2026-09-20", shift: "晚班", first: "00000050", last: "00000060" })
];
check("非相邻重叠报 RANGE_OVERLAP", codes(overlap).includes("RANGE_OVERLAP"));

// 14. 乱序输入按日期/班次排序后校验
const shuffled: SequenceShift[] = [
  shift({ id: "b", date: "2026-09-20", shift: "早班", first: "00000011", last: "00000020" }),
  shift({ id: "a", date: "2026-09-19", shift: "晚班", first: "00000001", last: "00000010" })
];
check("乱序输入仍能衔接", codes(shuffled).length === 0, JSON.stringify(codes(shuffled)));

// 15. 占用段按时序
const occupied = collectOccupied(chainOk);
check("占用段两条按时序", occupied.length === 2 && occupied[0].id === "a" && occupied[1].id === "b");
check("占用段文本", occupied[1].segment === "00001121-00001200");

// 16. 空台账期望值
check("空台账无期望首号", tailExpectation([]).expectedFirst === null);

// 17. 预览排除自身：编辑现有班次时不与自身冲突
check("excludeId 排除编辑项", codes(chainOk, "b").length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
