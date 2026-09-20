/**
 * 发票票号规则层（纯逻辑，不依赖 Vue / localStorage / DOM）
 *
 * 规则：
 * - 票号为 8 位数字（00000000-99999999），显示时补零；
 * - 每班登记首号、尾号（首号 ≤ 尾号）、开票金额与作废明细；
 * - 作废必须填票号和原因，票号须在本班号段内且不得重号；
 * - 班次按“日期 + 早/中/晚”排序，后班首号须紧接前班尾号；
 * - 仅 99999999 → 00000000 构成回绕，且只能跨日发生，全程最多一次；
 * - 跳号、重号、回绕违规、号段重叠等均以 ValidationIssue 逐条返回。
 */

export const SHIFTS = ["早班", "中班", "晚班"] as const;
export type ShiftName = (typeof SHIFTS)[number];

export const TICKET_DIGITS = 8;
export const TICKET_MOD = 10 ** TICKET_DIGITS;
export const TICKET_MAX = TICKET_MOD - 1;

export const PENDING = "待复核";
export const CONFIRMED = "已复核";

/** 规则命中码：前 11 项为号段/作废规则，后 3 项为存储层操作护栏。 */
export type IssueCode =
  | "TICKET_INVALID"
  | "AMOUNT_INVALID"
  | "VOID_INVALID"
  | "VOID_REASON_EMPTY"
  | "VOID_OUT_OF_RANGE"
  | "VOID_DUPLICATE"
  | "GAP"
  | "DUP_CONTINUITY"
  | "WRAP_SAME_DAY"
  | "WRAP_EXHAUSTED"
  | "RANGE_OVERLAP"
  | "SHIFT_DUPLICATE"
  | "CONFIRMED_LOCKED"
  | "CORRECT_REASON_EMPTY";

export const ISSUE_TEXT: Record<IssueCode, string> = {
  TICKET_INVALID: "票号段无效：首尾须为 8 位数字，且首号不大于尾号",
  AMOUNT_INVALID: "开票金额无效：须为不小于 0 的数字",
  VOID_INVALID: "作废票号无效：须为 8 位数字",
  VOID_REASON_EMPTY: "作废必须填写原因",
  VOID_OUT_OF_RANGE: "作废票号不在本班票号段内",
  VOID_DUPLICATE: "作废票号重号",
  GAP: "跳号：后班首号未紧接前班尾号",
  DUP_CONTINUITY: "重号：后班首号落入前班票号段",
  WRAP_SAME_DAY: "回绕只能跨日发生，不能同日回绕",
  WRAP_EXHAUSTED: "跨日回绕最多一次，回绕额度已用完",
  RANGE_OVERLAP: "票号段与其他班次占用段重叠",
  SHIFT_DUPLICATE: "同一日期的同一班次只能登记一次",
  CONFIRMED_LOCKED: "已复核班次的票号与金额已固定",
  CORRECT_REASON_EMPTY: "发起修正必须填写修正原因"
};

export interface SequenceVoid {
  ticket: string;
  reason: string;
}

export interface SequenceShift {
  id: string;
  date: string;
  shift: string;
  first: string;
  last: string;
  amount: string | number;
  voids: SequenceVoid[];
}

export interface ValidationIssue {
  /** 命中的班次 id（存储层护栏可为空串）。 */
  shiftId: string;
  code: IssueCode;
  shiftLabel: string;
  /** 命中校验说明。 */
  message: string;
  /** 票号段（单票显示为一个号）。 */
  ticketSegment: string;
  /** 原值 / 期望值。 */
  oldValue: string;
  /** 新值 / 实填值。 */
  newValue: string;
}

export interface OccupiedSegment {
  id: string;
  label: string;
  first: number;
  last: number;
  segment: string;
}

export interface TailExpectation {
  /** 不存在有效尾号时为 null。 */
  expectedFirst: string | null;
  tailLabel: string;
  /** 全程是否已经发生过一次合法跨日回绕。 */
  wrapUsed: boolean;
}

/** 1-8 位数字均可解析，存储前再统一补零；非法输入返回 null。 */
export function parseTicket(raw: string): number | null {
  const text = String(raw ?? "").trim();
  if (!/^\d{1,8}$/.test(text)) return null;
  return Number(text);
}

export function formatTicket(value: number): string {
  return String(value).padStart(TICKET_DIGITS, "0");
}

export function shiftIndex(shift: string): number {
  return (SHIFTS as readonly string[]).indexOf(shift);
}

export function shiftLabel(date: string, shift: string): string {
  return `${date || "未填日期"} ${shift || "未选班次"}`;
}

export function rangeText(first: string | number, last: string | number): string {
  const left = typeof first === "number" ? formatTicket(first) : String(first);
  const right = typeof last === "number" ? formatTicket(last) : String(last);
  return left === right ? left : `${left}-${right}`;
}

export function parseAmount(raw: string | number): number | null {
  if (typeof raw === "number") {
    return Number.isFinite(raw) && raw >= 0 ? raw : null;
  }
  const text = String(raw ?? "").trim();
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  return Number(text);
}

/** 时序键：YYYY-MM-DD 可直接按字符串比较，再按早(0)/中(1)/晚(2)。 */
function chronoKey(s: SequenceShift): string {
  return `${s.date || "⛔-⛔-⛔"}#${String(shiftIndex(s.shift) + 1).padStart(2, "0")}`;
}

function issue(
  shift: SequenceShift,
  code: IssueCode,
  fields: Partial<Omit<ValidationIssue, "shiftId" | "code" | "shiftLabel" | "message">> & {
    message: string;
  }
): ValidationIssue {
  return {
    shiftId: shift.id,
    code,
    shiftLabel: shiftLabel(shift.date, shift.shift),
    ticketSegment: fields.ticketSegment ?? "—",
    oldValue: fields.oldValue ?? "—",
    newValue: fields.newValue ?? "—",
    message: fields.message
  };
}

interface ParsedShift {
  s: SequenceShift;
  first: number;
  last: number;
  valid: boolean;
}

/**
 * 对全部班次做一次整链校验，返回所有命中项。
 * excludeId 用于表单预览时排除“正在被编辑的那条”。
 */
export function validateSequence(source: SequenceShift[], excludeId?: string): ValidationIssue[] {
  const shifts = source
    .filter((s) => s.id !== excludeId)
    .map((s) => ({ ...s, voids: s.voids?.length ? s.voids : [] }))
    .sort((a, b) => chronoKey(a).localeCompare(chronoKey(b)));

  const out: ValidationIssue[] = [];

  // —— 班次内校验：号段、金额、作废明细 ——
  const parsed: ParsedShift[] = shifts.map((s) => {
    const first = parseTicket(s.first);
    const last = parseTicket(s.last);
    const valid = first !== null && last !== null && first <= last;
    if (!valid) {
      out.push(
        issue(s, "TICKET_INVALID", {
          message: `${ISSUE_TEXT.TICKET_INVALID}（实填首号 "${s.first || "空"}"，尾号 "${s.last || "空"}"）`,
          ticketSegment: s.first || s.last ? rangeText(s.first || "?", s.last || "?") : "—",
          oldValue: "首号 ≤ 尾号 的 8 位数字",
          newValue: `首号 "${s.first || "空"}" / 尾号 "${s.last || "空"}"`
        })
      );
    }

    if (parseAmount(s.amount) === null) {
      out.push(
        issue(s, "AMOUNT_INVALID", {
          message: ISSUE_TEXT.AMOUNT_INVALID,
          oldValue: "不小于 0 的数字金额",
          newValue: `金额 "${String(s.amount ?? "").trim() || "空"}"`
        })
      );
    }

    const seen = new Map<number, number>();
    s.voids.forEach((v, rowIndex) => {
      const ticket = v.ticket.trim();
      const reason = v.reason.trim();
      if (!ticket && !reason) return; // 整行空白，忽略

      const num = parseTicket(ticket);
      if (num === null) {
        out.push(
          issue(s, "VOID_INVALID", {
            message: `${ISSUE_TEXT.VOID_INVALID}（第 ${rowIndex + 1} 行 "${ticket || "空"}"）`,
            ticketSegment: ticket || "（空）",
            oldValue: "8 位作废票号",
            newValue: ticket || "（空）"
          })
        );
        return;
      }

      const display = formatTicket(num);
      if (!valid || num < (first as number) || num > (last as number)) {
        out.push(
          issue(s, "VOID_OUT_OF_RANGE", {
            message: `${ISSUE_TEXT.VOID_OUT_OF_RANGE}（${display}）`,
            ticketSegment: display,
            oldValue: valid ? `本班号段 ${rangeText(first as number, last as number)}` : "本班号段（号段无效）",
            newValue: display
          })
        );
      }

      if (seen.has(num)) {
        out.push(
          issue(s, "VOID_DUPLICATE", {
            message: `${ISSUE_TEXT.VOID_DUPLICATE}（${display} 与第 ${(seen.get(num) as number) + 1} 行重复）`,
            ticketSegment: display,
            oldValue: "班内作废票号唯一",
            newValue: `${display} 重复填报`
          })
        );
      } else {
        seen.set(num, rowIndex);
      }

      if (!reason) {
        out.push(
          issue(s, "VOID_REASON_EMPTY", {
            message: `${ISSUE_TEXT.VOID_REASON_EMPTY}（${display}）`,
            ticketSegment: display,
            oldValue: "作废原因：必填",
            newValue: "作废原因：（空）"
          })
        );
      }
    });

    return { s, first: first ?? NaN, last: last ?? NaN, valid };
  });

  // —— 同日期同班次重复登记 ——
  for (let i = 1; i < shifts.length; i += 1) {
    if (chronoKey(shifts[i]) === chronoKey(shifts[i - 1])) {
      out.push(
        issue(shifts[i], "SHIFT_DUPLICATE", {
          message: `${ISSUE_TEXT.SHIFT_DUPLICATE}（${shiftLabel(shifts[i - 1].date, shifts[i - 1].shift)} 已登记）`,
          oldValue: "该日期班次未登记",
          newValue: shiftLabel(shifts[i].date, shifts[i].shift)
        })
      );
    }
  }

  // —— 班次间衔接：紧接、跳号、重号、回绕 ——
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
              message: `${ISSUE_TEXT.WRAP_SAME_DAY}（前班 ${prev.s.date} → 本班 ${cur.s.date}）`,
              ticketSegment: "99999999 → 00000000",
              oldValue: `回绕须跨日（前班 ${shiftLabel(prev.s.date, prev.s.shift)} 尾号 99999999）`,
              newValue: `${shiftLabel(cur.s.date, cur.s.shift)} 同日首号 00000000`
            })
          );
        } else if (wrapUsed) {
          out.push(
            issue(cur.s, "WRAP_EXHAUSTED", {
              message: ISSUE_TEXT.WRAP_EXHAUSTED,
              ticketSegment: "99999999 → 00000000",
              oldValue: "跨日回绕额度 0/1 剩余",
              newValue: `${shiftLabel(cur.s.date, cur.s.shift)} 再次回绕`
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
          message: `${ISSUE_TEXT.GAP}（前班 ${shiftLabel(prev.s.date, prev.s.shift)}）`,
          ticketSegment: rangeText(expected, cur.first - 1),
          oldValue: `期望首号 ${formatTicket(expected)}（紧接尾号 ${formatTicket(prev.last)}）`,
          newValue: `实填首号 ${formatTicket(cur.first)}`
        })
      );
    } else {
      out.push(
        issue(cur.s, "DUP_CONTINUITY", {
          message: `${ISSUE_TEXT.DUP_CONTINUITY}（前班 ${shiftLabel(prev.s.date, prev.s.shift)}）`,
          ticketSegment: rangeText(cur.first, Math.min(cur.last, prev.last)),
          oldValue: `期望首号 ${formatTicket(expected)}（紧接尾号 ${formatTicket(prev.last)}）`,
          newValue: `实填首号 ${formatTicket(cur.first)}`
        })
      );
    }
  }

  // —— 非相邻号段重叠（相邻班的重叠已由 DUP_CONTINUITY 报告） ——
  const validRanges = parsed.filter((p) => p.valid);
  for (let i = 0; i < validRanges.length; i += 1) {
    for (let j = i + 1; j < validRanges.length; j += 1) {
      if (j === i + 1) continue;
      const a = validRanges[i];
      const b = validRanges[j];
      if (a.first <= b.last && b.first <= a.last) {
        out.push(
          issue(b.s, "RANGE_OVERLAP", {
            message: `${ISSUE_TEXT.RANGE_OVERLAP}（与 ${shiftLabel(a.s.date, a.s.shift)}）`,
            ticketSegment: rangeText(Math.max(a.first, b.first), Math.min(a.last, b.last)),
            oldValue: `${shiftLabel(a.s.date, a.s.shift)} 占用 ${rangeText(a.first, a.last)}`,
            newValue: `${shiftLabel(b.s.date, b.s.shift)} 占用 ${rangeText(b.first, b.last)}`
          })
        );
      }
    }
  }

  return out;
}

/** 占用台账：只有号段本身有效的班次才占用票号。 */
export function collectOccupied(source: SequenceShift[]): OccupiedSegment[] {
  return source
    .map((s) => ({ s, first: parseTicket(s.first), last: parseTicket(s.last) }))
    .filter((x): x is { s: SequenceShift; first: number; last: number } => {
      return x.first !== null && x.last !== null && x.first <= x.last;
    })
    .sort((a, b) => chronoKey(a.s).localeCompare(chronoKey(b.s)))
    .map(({ s, first, last }) => ({
      id: s.id,
      label: shiftLabel(s.date, s.shift),
      first,
      last,
      segment: rangeText(first, last)
    }));
}

/** 推算下一班首号与回绕额度，供表单提示。 */
export function tailExpectation(source: SequenceShift[]): TailExpectation {
  const valid = source
    .map((s) => ({ s, first: parseTicket(s.first), last: parseTicket(s.last) }))
    .filter((x) => x.first !== null && x.last !== null && (x.first as number) <= (x.last as number))
    .sort((a, b) => chronoKey(a.s).localeCompare(chronoKey(b.s)));

  if (valid.length === 0) {
    return { expectedFirst: null, tailLabel: "", wrapUsed: false };
  }

  let wrapUsed = false;
  for (let i = 1; i < valid.length; i += 1) {
    const prev = valid[i - 1];
    const cur = valid[i];
    if (
      (prev.last as number) === TICKET_MAX &&
      (cur.first as number) === 0 &&
      cur.s.date > prev.s.date
    ) {
      wrapUsed = true;
    }
  }

  const tail = valid[valid.length - 1];
  return {
    expectedFirst: formatTicket(((tail.last as number) + 1) % TICKET_MOD),
    tailLabel: shiftLabel(tail.s.date, tail.s.shift),
    wrapUsed
  };
}
