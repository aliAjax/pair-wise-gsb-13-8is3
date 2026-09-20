"use strict";

// src/invoice/rules.ts
var SHIFTS = ["\u65E9\u73ED", "\u4E2D\u73ED", "\u665A\u73ED"];
var TICKET_DIGITS = 8;
var TICKET_MOD = 10 ** TICKET_DIGITS;
var TICKET_MAX = TICKET_MOD - 1;
var ISSUE_TEXT = {
  TICKET_INVALID: "\u7968\u53F7\u6BB5\u65E0\u6548\uFF1A\u9996\u5C3E\u987B\u4E3A 8 \u4F4D\u6570\u5B57\uFF0C\u4E14\u9996\u53F7\u4E0D\u5927\u4E8E\u5C3E\u53F7",
  AMOUNT_INVALID: "\u5F00\u7968\u91D1\u989D\u65E0\u6548\uFF1A\u987B\u4E3A\u4E0D\u5C0F\u4E8E 0 \u7684\u6570\u5B57",
  VOID_INVALID: "\u4F5C\u5E9F\u7968\u53F7\u65E0\u6548\uFF1A\u987B\u4E3A 8 \u4F4D\u6570\u5B57",
  VOID_REASON_EMPTY: "\u4F5C\u5E9F\u5FC5\u987B\u586B\u5199\u539F\u56E0",
  VOID_OUT_OF_RANGE: "\u4F5C\u5E9F\u7968\u53F7\u4E0D\u5728\u672C\u73ED\u7968\u53F7\u6BB5\u5185",
  VOID_DUPLICATE: "\u4F5C\u5E9F\u7968\u53F7\u91CD\u53F7",
  GAP: "\u8DF3\u53F7\uFF1A\u540E\u73ED\u9996\u53F7\u672A\u7D27\u63A5\u524D\u73ED\u5C3E\u53F7",
  DUP_CONTINUITY: "\u91CD\u53F7\uFF1A\u540E\u73ED\u9996\u53F7\u843D\u5165\u524D\u73ED\u7968\u53F7\u6BB5",
  WRAP_SAME_DAY: "\u56DE\u7ED5\u53EA\u80FD\u8DE8\u65E5\u53D1\u751F\uFF0C\u4E0D\u80FD\u540C\u65E5\u56DE\u7ED5",
  WRAP_EXHAUSTED: "\u8DE8\u65E5\u56DE\u7ED5\u6700\u591A\u4E00\u6B21\uFF0C\u56DE\u7ED5\u989D\u5EA6\u5DF2\u7528\u5B8C",
  RANGE_OVERLAP: "\u7968\u53F7\u6BB5\u4E0E\u5176\u4ED6\u73ED\u6B21\u5360\u7528\u6BB5\u91CD\u53E0",
  SHIFT_DUPLICATE: "\u540C\u4E00\u65E5\u671F\u7684\u540C\u4E00\u73ED\u6B21\u53EA\u80FD\u767B\u8BB0\u4E00\u6B21",
  CONFIRMED_LOCKED: "\u5DF2\u590D\u6838\u73ED\u6B21\u7684\u7968\u53F7\u4E0E\u91D1\u989D\u5DF2\u56FA\u5B9A",
  CORRECT_REASON_EMPTY: "\u53D1\u8D77\u4FEE\u6B63\u5FC5\u987B\u586B\u5199\u4FEE\u6B63\u539F\u56E0"
};
function parseTicket(raw) {
  const text = String(raw ?? "").trim();
  if (!/^\d{1,8}$/.test(text)) return null;
  return Number(text);
}
function formatTicket(value) {
  return String(value).padStart(TICKET_DIGITS, "0");
}
function shiftIndex(shift2) {
  return SHIFTS.indexOf(shift2);
}
function shiftLabel(date, shift2) {
  return `${date || "\u672A\u586B\u65E5\u671F"} ${shift2 || "\u672A\u9009\u73ED\u6B21"}`;
}
function rangeText(first, last) {
  const left = typeof first === "number" ? formatTicket(first) : String(first);
  const right = typeof last === "number" ? formatTicket(last) : String(last);
  return left === right ? left : `${left}-${right}`;
}
function parseAmount(raw) {
  if (typeof raw === "number") {
    return Number.isFinite(raw) && raw >= 0 ? raw : null;
  }
  const text = String(raw ?? "").trim();
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  return Number(text);
}
function chronoKey(s) {
  return `${s.date || "\u26D4-\u26D4-\u26D4"}#${String(shiftIndex(s.shift) + 1).padStart(2, "0")}`;
}
function issue(shift2, code, fields) {
  return {
    shiftId: shift2.id,
    code,
    shiftLabel: shiftLabel(shift2.date, shift2.shift),
    ticketSegment: fields.ticketSegment ?? "\u2014",
    oldValue: fields.oldValue ?? "\u2014",
    newValue: fields.newValue ?? "\u2014",
    message: fields.message
  };
}
function validateSequence(source, excludeId) {
  const shifts = source.filter((s) => s.id !== excludeId).map((s) => ({ ...s, voids: s.voids?.length ? s.voids : [] })).sort((a, b) => chronoKey(a).localeCompare(chronoKey(b)));
  const out = [];
  const parsed = shifts.map((s) => {
    const first = parseTicket(s.first);
    const last = parseTicket(s.last);
    const valid = first !== null && last !== null && first <= last;
    if (!valid) {
      out.push(
        issue(s, "TICKET_INVALID", {
          message: `${ISSUE_TEXT.TICKET_INVALID}\uFF08\u5B9E\u586B\u9996\u53F7 "${s.first || "\u7A7A"}"\uFF0C\u5C3E\u53F7 "${s.last || "\u7A7A"}"\uFF09`,
          ticketSegment: s.first || s.last ? rangeText(s.first || "?", s.last || "?") : "\u2014",
          oldValue: "\u9996\u53F7 \u2264 \u5C3E\u53F7 \u7684 8 \u4F4D\u6570\u5B57",
          newValue: `\u9996\u53F7 "${s.first || "\u7A7A"}" / \u5C3E\u53F7 "${s.last || "\u7A7A"}"`
        })
      );
    }
    if (parseAmount(s.amount) === null) {
      out.push(
        issue(s, "AMOUNT_INVALID", {
          message: ISSUE_TEXT.AMOUNT_INVALID,
          oldValue: "\u4E0D\u5C0F\u4E8E 0 \u7684\u6570\u5B57\u91D1\u989D",
          newValue: `\u91D1\u989D "${String(s.amount ?? "").trim() || "\u7A7A"}"`
        })
      );
    }
    const seen = /* @__PURE__ */ new Map();
    s.voids.forEach((v, rowIndex) => {
      const ticket = v.ticket.trim();
      const reason = v.reason.trim();
      if (!ticket && !reason) return;
      const num = parseTicket(ticket);
      if (num === null) {
        out.push(
          issue(s, "VOID_INVALID", {
            message: `${ISSUE_TEXT.VOID_INVALID}\uFF08\u7B2C ${rowIndex + 1} \u884C "${ticket || "\u7A7A"}"\uFF09`,
            ticketSegment: ticket || "\uFF08\u7A7A\uFF09",
            oldValue: "8 \u4F4D\u4F5C\u5E9F\u7968\u53F7",
            newValue: ticket || "\uFF08\u7A7A\uFF09"
          })
        );
        return;
      }
      const display = formatTicket(num);
      if (!valid || num < first || num > last) {
        out.push(
          issue(s, "VOID_OUT_OF_RANGE", {
            message: `${ISSUE_TEXT.VOID_OUT_OF_RANGE}\uFF08${display}\uFF09`,
            ticketSegment: display,
            oldValue: valid ? `\u672C\u73ED\u53F7\u6BB5 ${rangeText(first, last)}` : "\u672C\u73ED\u53F7\u6BB5\uFF08\u53F7\u6BB5\u65E0\u6548\uFF09",
            newValue: display
          })
        );
      }
      if (seen.has(num)) {
        out.push(
          issue(s, "VOID_DUPLICATE", {
            message: `${ISSUE_TEXT.VOID_DUPLICATE}\uFF08${display} \u4E0E\u7B2C ${seen.get(num) + 1} \u884C\u91CD\u590D\uFF09`,
            ticketSegment: display,
            oldValue: "\u73ED\u5185\u4F5C\u5E9F\u7968\u53F7\u552F\u4E00",
            newValue: `${display} \u91CD\u590D\u586B\u62A5`
          })
        );
      } else {
        seen.set(num, rowIndex);
      }
      if (!reason) {
        out.push(
          issue(s, "VOID_REASON_EMPTY", {
            message: `${ISSUE_TEXT.VOID_REASON_EMPTY}\uFF08${display}\uFF09`,
            ticketSegment: display,
            oldValue: "\u4F5C\u5E9F\u539F\u56E0\uFF1A\u5FC5\u586B",
            newValue: "\u4F5C\u5E9F\u539F\u56E0\uFF1A\uFF08\u7A7A\uFF09"
          })
        );
      }
    });
    return { s, first: first ?? NaN, last: last ?? NaN, valid };
  });
  for (let i = 1; i < shifts.length; i += 1) {
    if (chronoKey(shifts[i]) === chronoKey(shifts[i - 1])) {
      out.push(
        issue(shifts[i], "SHIFT_DUPLICATE", {
          message: `${ISSUE_TEXT.SHIFT_DUPLICATE}\uFF08${shiftLabel(shifts[i - 1].date, shifts[i - 1].shift)} \u5DF2\u767B\u8BB0\uFF09`,
          oldValue: "\u8BE5\u65E5\u671F\u73ED\u6B21\u672A\u767B\u8BB0",
          newValue: shiftLabel(shifts[i].date, shifts[i].shift)
        })
      );
    }
  }
  let wrapUsed = false;
  for (let i = 1; i < parsed.length; i += 1) {
    const prev = parsed[i - 1];
    const cur = parsed[i];
    if (!prev.valid || !cur.valid) continue;
    const expected = (prev.last + 1) % TICKET_MOD;
    const isWrap = prev.last === TICKET_MAX && cur.first === 0;
    if (cur.first === expected) {
      if (isWrap) {
        if (cur.s.date <= prev.s.date) {
          out.push(
            issue(cur.s, "WRAP_SAME_DAY", {
              message: `${ISSUE_TEXT.WRAP_SAME_DAY}\uFF08\u524D\u73ED ${prev.s.date} \u2192 \u672C\u73ED ${cur.s.date}\uFF09`,
              ticketSegment: "99999999 \u2192 00000000",
              oldValue: `\u56DE\u7ED5\u987B\u8DE8\u65E5\uFF08\u524D\u73ED ${shiftLabel(prev.s.date, prev.s.shift)} \u5C3E\u53F7 99999999\uFF09`,
              newValue: `${shiftLabel(cur.s.date, cur.s.shift)} \u540C\u65E5\u9996\u53F7 00000000`
            })
          );
        } else if (wrapUsed) {
          out.push(
            issue(cur.s, "WRAP_EXHAUSTED", {
              message: ISSUE_TEXT.WRAP_EXHAUSTED,
              ticketSegment: "99999999 \u2192 00000000",
              oldValue: "\u8DE8\u65E5\u56DE\u7ED5\u989D\u5EA6 0/1 \u5269\u4F59",
              newValue: `${shiftLabel(cur.s.date, cur.s.shift)} \u518D\u6B21\u56DE\u7ED5`
            })
          );
        } else {
          wrapUsed = true;
        }
      }
      continue;
    }
    if (cur.first > expected) {
      out.push(
        issue(cur.s, "GAP", {
          message: `${ISSUE_TEXT.GAP}\uFF08\u524D\u73ED ${shiftLabel(prev.s.date, prev.s.shift)}\uFF09`,
          ticketSegment: rangeText(expected, cur.first - 1),
          oldValue: `\u671F\u671B\u9996\u53F7 ${formatTicket(expected)}\uFF08\u7D27\u63A5\u5C3E\u53F7 ${formatTicket(prev.last)}\uFF09`,
          newValue: `\u5B9E\u586B\u9996\u53F7 ${formatTicket(cur.first)}`
        })
      );
    } else {
      out.push(
        issue(cur.s, "DUP_CONTINUITY", {
          message: `${ISSUE_TEXT.DUP_CONTINUITY}\uFF08\u524D\u73ED ${shiftLabel(prev.s.date, prev.s.shift)}\uFF09`,
          ticketSegment: rangeText(cur.first, Math.min(cur.last, prev.last)),
          oldValue: `\u671F\u671B\u9996\u53F7 ${formatTicket(expected)}\uFF08\u7D27\u63A5\u5C3E\u53F7 ${formatTicket(prev.last)}\uFF09`,
          newValue: `\u5B9E\u586B\u9996\u53F7 ${formatTicket(cur.first)}`
        })
      );
    }
  }
  const validRanges = parsed.filter((p) => p.valid);
  for (let i = 0; i < validRanges.length; i += 1) {
    for (let j = i + 1; j < validRanges.length; j += 1) {
      if (j === i + 1) continue;
      const a = validRanges[i];
      const b = validRanges[j];
      if (a.first <= b.last && b.first <= a.last) {
        out.push(
          issue(b.s, "RANGE_OVERLAP", {
            message: `${ISSUE_TEXT.RANGE_OVERLAP}\uFF08\u4E0E ${shiftLabel(a.s.date, a.s.shift)}\uFF09`,
            ticketSegment: rangeText(Math.max(a.first, b.first), Math.min(a.last, b.last)),
            oldValue: `${shiftLabel(a.s.date, a.s.shift)} \u5360\u7528 ${rangeText(a.first, a.last)}`,
            newValue: `${shiftLabel(b.s.date, b.s.shift)} \u5360\u7528 ${rangeText(b.first, b.last)}`
          })
        );
      }
    }
  }
  return out;
}
function collectOccupied(source) {
  return source.map((s) => ({ s, first: parseTicket(s.first), last: parseTicket(s.last) })).filter((x) => {
    return x.first !== null && x.last !== null && x.first <= x.last;
  }).sort((a, b) => chronoKey(a.s).localeCompare(chronoKey(b.s))).map(({ s, first, last }) => ({
    id: s.id,
    label: shiftLabel(s.date, s.shift),
    first,
    last,
    segment: rangeText(first, last)
  }));
}
function tailExpectation(source) {
  const valid = source.map((s) => ({ s, first: parseTicket(s.first), last: parseTicket(s.last) })).filter((x) => x.first !== null && x.last !== null && x.first <= x.last).sort((a, b) => chronoKey(a.s).localeCompare(chronoKey(b.s)));
  if (valid.length === 0) {
    return { expectedFirst: null, tailLabel: "", wrapUsed: false };
  }
  let wrapUsed = false;
  for (let i = 1; i < valid.length; i += 1) {
    const prev = valid[i - 1];
    const cur = valid[i];
    if (prev.last === TICKET_MAX && cur.first === 0 && cur.s.date > prev.s.date) {
      wrapUsed = true;
    }
  }
  const tail = valid[valid.length - 1];
  return {
    expectedFirst: formatTicket((tail.last + 1) % TICKET_MOD),
    tailLabel: shiftLabel(tail.s.date, tail.s.shift),
    wrapUsed
  };
}

// scripts/check-rules.ts
var pass = 0;
var fail = 0;
function check(name, cond, detail = "") {
  if (cond) {
    pass += 1;
  } else {
    fail += 1;
    console.error(`\u2717 ${name}${detail ? ` \u2014 ${detail}` : ""}`);
  }
}
function shift(p) {
  return {
    first: "",
    last: "",
    amount: "100",
    voids: [],
    ...p
  };
}
function codes(list, exclude) {
  return validateSequence(list, exclude).map((i) => i.code);
}
check("parseTicket \u5408\u6CD5", parseTicket("123") === 123);
check("parseTicket \u8D85 8 \u4F4D\u975E\u6CD5", parseTicket("123456789") === null);
check("parseTicket \u975E\u6570\u5B57\u975E\u6CD5", parseTicket("12a") === null);
check("formatTicket \u8865\u96F6", formatTicket(123) === "00000123");
var chainOk = [
  shift({ id: "a", date: "2026-09-19", shift: "\u665A\u73ED", first: "00001001", last: "00001120" }),
  shift({ id: "b", date: "2026-09-20", shift: "\u65E9\u73ED", first: "00001121", last: "00001200" })
];
check("\u6B63\u5E38\u8854\u63A5\u65E0\u95EE\u9898", codes(chainOk).length === 0, JSON.stringify(codes(chainOk)));
var gap = [
  shift({ id: "a", date: "2026-09-19", shift: "\u665A\u73ED", first: "00001001", last: "00001120" }),
  shift({ id: "b", date: "2026-09-20", shift: "\u65E9\u73ED", first: "00001130", last: "00001200" })
];
var gapIssues = validateSequence(gap);
check("\u8DF3\u53F7\u62A5 GAP", gapIssues.some((i) => i.code === "GAP"));
check("\u8DF3\u53F7\u7968\u53F7\u6BB5\u4E3A\u7F3A\u53E3", gapIssues[0]?.ticketSegment === "00001121-00001129", gapIssues[0]?.ticketSegment);
check("\u8DF3\u53F7\u539F\u503C\u65B0\u503C", gapIssues[0]?.oldValue.includes("00001121") && gapIssues[0]?.newValue.includes("00001130"));
var dup = [
  shift({ id: "a", date: "2026-09-19", shift: "\u665A\u73ED", first: "00001001", last: "00001120" }),
  shift({ id: "b", date: "2026-09-20", shift: "\u65E9\u73ED", first: "00001100", last: "00001200" })
];
check("\u91CD\u53F7\u62A5 DUP_CONTINUITY", codes(dup).includes("DUP_CONTINUITY"));
var wrapOk = [
  shift({ id: "a", date: "2026-09-19", shift: "\u665A\u73ED", first: "99999900", last: "99999999" }),
  shift({ id: "b", date: "2026-09-20", shift: "\u65E9\u73ED", first: "00000000", last: "00000050" })
];
check("\u8DE8\u65E5\u56DE\u7ED5\u5408\u6CD5", codes(wrapOk).length === 0, JSON.stringify(codes(wrapOk)));
check("\u56DE\u7ED5\u540E\u671F\u671B\u503C 51", tailExpectation(wrapOk).expectedFirst === "00000051");
check("wrapUsed \u4E3A\u771F", tailExpectation(wrapOk).wrapUsed === true);
var wrapSameDay = [
  shift({ id: "a", date: "2026-09-20", shift: "\u65E9\u73ED", first: "99999900", last: "99999999" }),
  shift({ id: "b", date: "2026-09-20", shift: "\u4E2D\u73ED", first: "00000000", last: "00000050" })
];
check("\u540C\u65E5\u56DE\u7ED5\u62A5 WRAP_SAME_DAY", codes(wrapSameDay).includes("WRAP_SAME_DAY"));
var wrapTwice = [
  shift({ id: "a", date: "2026-09-19", shift: "\u665A\u73ED", first: "99999900", last: "99999999" }),
  shift({ id: "b", date: "2026-09-20", shift: "\u65E9\u73ED", first: "00000000", last: "00000050" }),
  shift({ id: "c", date: "2026-09-20", shift: "\u4E2D\u73ED", first: "00000051", last: "99999999" }),
  shift({ id: "d", date: "2026-09-21", shift: "\u65E9\u73ED", first: "00000000", last: "00000009" })
];
var twiceCodes = codes(wrapTwice);
check("\u7B2C\u4E8C\u6B21\u56DE\u7ED5\u62A5 WRAP_EXHAUSTED", twiceCodes.includes("WRAP_EXHAUSTED"), JSON.stringify(twiceCodes));
var voidEmpty = [
  shift({
    id: "a",
    date: "2026-09-20",
    shift: "\u65E9\u73ED",
    first: "00000001",
    last: "00000010",
    voids: [{ ticket: "00000003", reason: "  " }]
  })
];
check("\u4F5C\u5E9F\u539F\u56E0\u7A7A\u62A5 VOID_REASON_EMPTY", codes(voidEmpty).includes("VOID_REASON_EMPTY"));
var voidOut = [
  shift({
    id: "a",
    date: "2026-09-20",
    shift: "\u65E9\u73ED",
    first: "00000001",
    last: "00000010",
    voids: [{ ticket: "00000011", reason: "x" }]
  })
];
check("\u4F5C\u5E9F\u8D8A\u754C\u62A5 VOID_OUT_OF_RANGE", codes(voidOut).includes("VOID_OUT_OF_RANGE"));
var voidDup = [
  shift({
    id: "a",
    date: "2026-09-20",
    shift: "\u65E9\u73ED",
    first: "00000001",
    last: "00000010",
    voids: [
      { ticket: "00000003", reason: "x" },
      { ticket: "00000003", reason: "y" }
    ]
  })
];
check("\u4F5C\u5E9F\u91CD\u53F7\u62A5 VOID_DUPLICATE", codes(voidDup).includes("VOID_DUPLICATE"));
var invalid = [
  shift({ id: "a", date: "2026-09-20", shift: "\u65E9\u73ED", first: "12", last: "5", amount: "abc" })
];
var invalidCodes = codes(invalid);
check("\u9996\u5C3E\u5012\u7F6E\u62A5 TICKET_INVALID", invalidCodes.includes("TICKET_INVALID"));
check("\u91D1\u989D\u975E\u6CD5\u62A5 AMOUNT_INVALID", invalidCodes.includes("AMOUNT_INVALID"));
var shiftDup = [
  shift({ id: "a", date: "2026-09-20", shift: "\u65E9\u73ED", first: "00000001", last: "00000010" }),
  shift({ id: "b", date: "2026-09-20", shift: "\u65E9\u73ED", first: "00000011", last: "00000020" })
];
check("\u540C\u73ED\u6B21\u91CD\u590D\u62A5 SHIFT_DUPLICATE", codes(shiftDup).includes("SHIFT_DUPLICATE"));
var overlap = [
  shift({ id: "a", date: "2026-09-20", shift: "\u65E9\u73ED", first: "00000001", last: "00000100" }),
  shift({ id: "b", date: "2026-09-20", shift: "\u4E2D\u73ED", first: "00000101", last: "00000200" }),
  shift({ id: "c", date: "2026-09-20", shift: "\u665A\u73ED", first: "00000050", last: "00000060" })
];
check("\u975E\u76F8\u90BB\u91CD\u53E0\u62A5 RANGE_OVERLAP", codes(overlap).includes("RANGE_OVERLAP"));
var shuffled = [
  shift({ id: "b", date: "2026-09-20", shift: "\u65E9\u73ED", first: "00000011", last: "00000020" }),
  shift({ id: "a", date: "2026-09-19", shift: "\u665A\u73ED", first: "00000001", last: "00000010" })
];
check("\u4E71\u5E8F\u8F93\u5165\u4ECD\u80FD\u8854\u63A5", codes(shuffled).length === 0, JSON.stringify(codes(shuffled)));
var occupied = collectOccupied(chainOk);
check("\u5360\u7528\u6BB5\u4E24\u6761\u6309\u65F6\u5E8F", occupied.length === 2 && occupied[0].id === "a" && occupied[1].id === "b");
check("\u5360\u7528\u6BB5\u6587\u672C", occupied[1].segment === "00001121-00001200");
check("\u7A7A\u53F0\u8D26\u65E0\u671F\u671B\u9996\u53F7", tailExpectation([]).expectedFirst === null);
check("excludeId \u6392\u9664\u7F16\u8F91\u9879", codes(chainOk, "b").length === 0);
console.log(`
${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
