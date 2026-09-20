// 发票票号规则层：纯函数，不依赖 Vue / localStorage。
// 负责：票号格式、首尾衔接、跨日回绕（最多一次）、跳号/重号、作废校验。

export const NO_MIN = 1;
export const NO_MAX = 99_999_999;
export const NO_PAD = 8;
export const MAX_WRAP_COUNT = 1;

export const SHIFTS = ["早班", "中班", "晚班"] as const;
export type ShiftName = (typeof SHIFTS)[number];

export interface VoidInput {
  noText: string;
  reason: string;
}

export interface VoidItem {
  no: number;
  reason: string;
}

/** 界面录入 / 修正时的原始文本，规则层统一负责解析与报错。 */
export interface DraftInput {
  date: string;
  shift: string;
  startText: string;
  endText: string;
  amountText: string;
  voids: VoidInput[];
}

/** 已解析的班次票号占用段。 */
export interface Segment {
  entryId: string;
  date: string;
  shift: string;
  startNo: number;
  endNo: number;
  amount: number;
  voids: VoidItem[];
  confirmed: boolean;
}

export type IssueCode =
  | "INCOMPLETE"
  | "NO_FORMAT"
  | "NO_RANGE"
  | "NO_ORDER"
  | "AMOUNT_INVALID"
  | "VOID_OUT_OF_RANGE"
  | "VOID_REASON_EMPTY"
  | "VOID_DUPLICATE"
  | "WRAP_SAME_DAY"
  | "WRAP_LIMIT"
  | "GAP"
  | "DUPLICATE";

export interface Issue {
  code: IssueCode;
  level: "block" | "review";
  message: string;
  expected?: string;
}

export const ISSUE_META: Record<IssueCode, { level: "block" | "review"; label: string }> = {
  INCOMPLETE: { level: "block", label: "班次信息不全" },
  NO_FORMAT: { level: "block", label: "票号格式错误" },
  NO_RANGE: { level: "block", label: "票号越界" },
  NO_ORDER: { level: "block", label: "首尾倒置" },
  AMOUNT_INVALID: { level: "block", label: "金额无效" },
  VOID_OUT_OF_RANGE: { level: "block", label: "作废越界" },
  VOID_REASON_EMPTY: { level: "review", label: "作废原因为空" },
  VOID_DUPLICATE: { level: "review", label: "作废重号" },
  WRAP_SAME_DAY: { level: "block", label: "同日回绕" },
  WRAP_LIMIT: { level: "block", label: "回绕超限" },
  GAP: { level: "review", label: "跳号" },
  DUPLICATE: { level: "review", label: "重号" }
};

export const BLOCK_CODES: ReadonlySet<IssueCode> = new Set(
  (Object.keys(ISSUE_META) as IssueCode[]).filter((code) => ISSUE_META[code].level === "block")
);

export function pad(no: number): string {
  return String(no).padStart(NO_PAD, "0");
}

export function formatRange(start: number, end: number): string {
  return `${pad(start)} – ${pad(end)}`;
}

/** 解析票号：允许 1~8 位数字（前导零），其余一律视为格式错误。 */
export function parseNo(text: string): number | null {
  const value = text.trim();
  if (!/^\d{1,8}$/.test(value)) return null;
  const no = Number(value);
  if (no < NO_MIN || no > NO_MAX) return null;
  return no;
}

export function parseAmount(text: string): number | null {
  const value = text.trim();
  if (value === "" || !/^-?\d+(\.\d+)?$/.test(value)) return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

function shiftIndex(shift: string): number {
  return (SHIFTS as readonly string[]).indexOf(shift);
}

/** 班次时间排序键：先日期后早/中/晚。 */
export function occasionKey(date: string, shift: string): string {
  return `${date}#${String(shiftIndex(shift) + 1).padStart(2, "0")}`;
}

export function compareOccasion(a: { date: string; shift: string }, b: { date: string; shift: string }): number {
  return occasionKey(a.date, a.shift).localeCompare(occasionKey(b.date, b.shift));
}

export function isWrap(prev: Segment | { endNo: number }, next: { date: string; startNo: number }): boolean {
  if (!("date" in prev) || prev.endNo !== NO_MAX) return false;
  return next.startNo === NO_MIN;
}

function overlaps(a: { startNo: number; endNo: number }, b: { startNo: number; endNo: number }): boolean {
  return a.startNo <= b.endNo && b.startNo <= a.endNo;
}

function pushIssue(list: Issue[], seen: Set<string>, issue: Issue) {
  const key = `${issue.code}:${issue.message}`;
  if (!seen.has(key)) {
    seen.add(key);
    list.push(issue);
  }
}

/** 从全部班次中抽取当前生效版本占用的票号段，按时间排序。 */
export function buildSegments(
  entries: Array<{
    id: string;
    date: string;
    shift: string;
    confirmed: boolean;
    current: { startNo: number; endNo: number; amount: number; voids: VoidItem[] };
  }>,
  excludeId?: string
): Segment[] {
  return entries
    .filter((entry) => entry.id !== excludeId)
    .map((entry) => ({
      entryId: entry.id,
      date: entry.date,
      shift: entry.shift,
      startNo: entry.current.startNo,
      endNo: entry.current.endNo,
      amount: entry.current.amount,
      voids: entry.current.voids,
      confirmed: entry.confirmed
    }))
    .sort(compareOccasion);
}

/** 已发生的跨日回绕次数（99999999 → 次日 00000001）。 */
export function countWraps(segments: Segment[]): number {
  let wraps = 0;
  for (let i = 1; i < segments.length; i += 1) {
    const prev = segments[i - 1];
    const cur = segments[i];
    if (prev.endNo === NO_MAX && cur.startNo === NO_MIN && cur.date > prev.date) wraps += 1;
  }
  return wraps;
}

/**
 * 票号周期序号：每经过一次跨日回绕进入下一周期。
 * 不同周期复用相同票号不算重号。
 */
/** 已存段所在周期序号（不含任何尚未登记的班次）。 */
function cycleIndex(target: { date: string; shift: string }, segments: Segment[]): number {
  let cycle = 0;
  for (let i = 1; i < segments.length; i += 1) {
    const boundary = segments[i];
    const prev = segments[i - 1];
    const isWrapBoundary =
      prev.endNo === NO_MAX && boundary.startNo === NO_MIN && boundary.date > prev.date;
    // 与目标同一时刻的段（编辑自身）不计为“之前的回绕”。
    if (isWrapBoundary && compareOccasion(boundary, target) < 0) cycle += 1;
  }
  return cycle;
}

/**
 * 待登记班次的周期序号：在已存段中找到时间上的前班，
 * 若前班尾号到顶且目标跨日，则目标就是一次回绕后的起点。
 */
function draftCycleIndex(
  target: { date: string; shift: string },
  segments: Segment[]
): number {
  const earlier = segments.filter((seg) => compareOccasion(seg, target) < 0);
  if (earlier.length === 0) return 0;
  const prev = earlier[earlier.length - 1];
  const base = cycleIndex(prev, segments);
  return prev.endNo === NO_MAX && target.date > prev.date ? base + 1 : base;
}

export interface ParsedDraft {
  date: string;
  shift: string;
  startNo: number | null;
  endNo: number | null;
  amount: number | null;
  voids: { no: number | null; reason: string; raw: VoidInput }[];
}

export function parseDraft(input: DraftInput): ParsedDraft {
  return {
    date: input.date,
    shift: input.shift,
    startNo: parseNo(input.startText),
    endNo: parseNo(input.endText),
    amount: parseAmount(input.amountText),
    voids: input.voids
      .filter((row) => row.noText.trim() !== "" || row.reason.trim() !== "")
      .map((row) => ({ no: parseNo(row.noText), reason: row.reason.trim(), raw: row }))
  };
}

/**
 * 核心校验：返回全部命中的校验项。
 * level=block 必须挡下操作；level=review 允许保存但班次保持“待复核”。
 */
export function evaluate(input: DraftInput, segments: Segment[]): Issue[] {
  const issues: Issue[] = [];
  const seen = new Set<string>();
  const draft = parseDraft(input);
  const { startNo, endNo, amount } = draft;
  const validRange = startNo !== null && endNo !== null;

  if (!draft.date || shiftIndex(draft.shift) < 0) {
    pushIssue(issues, seen, { code: "INCOMPLETE", level: "block", message: "请先完整选择日期与班次" });
  }

  if (input.startText.trim() === "" || startNo === null) {
    pushIssue(issues, seen, { code: "NO_FORMAT", level: "block", message: "首号须为 1～99999999 的整数" });
  }
  if (input.endText.trim() === "" || endNo === null) {
    pushIssue(issues, seen, { code: "NO_FORMAT", level: "block", message: "尾号须为 1～99999999 的整数" });
  }
  draft.voids.forEach((row) => {
    if (row.no === null) {
      pushIssue(issues, seen, {
        code: "NO_FORMAT",
        level: "block",
        message: `作废票号“${row.raw.noText.trim() || "空"}”格式错误，须为 1～99999999 的整数`
      });
    }
  });

  if (validRange && startNo > endNo) {
    pushIssue(issues, seen, {
      code: "NO_ORDER",
      level: "block",
      message: `首号 ${pad(startNo)} 晚于尾号 ${pad(endNo)}`,
      expected: "首号不得晚于尾号"
    });
  }

  if (amount === null) {
    pushIssue(issues, seen, { code: "AMOUNT_INVALID", level: "block", message: "开票金额须为不小于 0 的数字" });
  }

  // 作废明细：越界（硬挡）、重号（待复核）、原因空（待复核）。
  if (validRange) {
    const voidSeen = new Map<number, number>();
    draft.voids.forEach((row) => {
      if (row.no === null) return;
      if (row.no < startNo || row.no > endNo) {
        pushIssue(issues, seen, {
          code: "VOID_OUT_OF_RANGE",
          level: "block",
          message: `作废票号 ${pad(row.no)} 不在本班票号段 ${formatRange(startNo, endNo)} 内`
        });
      }
      voidSeen.set(row.no, (voidSeen.get(row.no) ?? 0) + 1);
      if (row.reason === "") {
        pushIssue(issues, seen, {
          code: "VOID_REASON_EMPTY",
          level: "review",
          message: `作废票号 ${pad(row.no)} 未填写原因，作废必须注明原因`
        });
      }
    });
    voidSeen.forEach((count, no) => {
      if (count > 1) {
        pushIssue(issues, seen, {
          code: "VOID_DUPLICATE",
          level: "review",
          message: `作废票号 ${pad(no)} 在本班重复登记 ${count} 次`
        });
      }
    });
  }

  const validOccasion = draft.date !== "" && shiftIndex(draft.shift) >= 0;

  // 与已占用票号段重号（待复核）。仅同一票号周期内重叠才算重号：
  // 跨日回绕后进入下一周期，低位票号可重新使用。
  if (validRange && validOccasion) {
    const target = { date: draft.date, shift: draft.shift };
    const targetCycle = draftCycleIndex(target, segments);
    segments.forEach((seg) => {
      if (seg.startNo > NO_MAX || seg.endNo < NO_MIN) return;
      if (cycleIndex(seg, segments) !== targetCycle) return;
      if (overlaps({ startNo, endNo }, seg)) {
        pushIssue(issues, seen, {
          code: "DUPLICATE",
          level: "review",
          message: `票号段 ${formatRange(startNo, endNo)} 与 ${seg.date} ${seg.shift} 已占用段 ${formatRange(
            seg.startNo,
            seg.endNo
          )} 重号`
        });
      }
    });
  }

  // 班次衔接：后班首号必须紧接前班尾号，跨日最多回绕一次。
  if (validRange && validOccasion) {
    const earlier = segments
      .filter((seg) => compareOccasion(seg, { date: draft.date, shift: draft.shift }) < 0)
      .sort(compareOccasion);
    const prev = earlier.length > 0 ? earlier[earlier.length - 1] : undefined;

    if (prev) {
      const sameDay = prev.date === draft.date;
      if (prev.endNo === NO_MAX) {
        if (sameDay) {
          pushIssue(issues, seen, {
            code: "WRAP_SAME_DAY",
            level: "block",
            message: `前班（${prev.date} ${prev.shift}）尾号已到 ${pad(NO_MAX)}，须跨日方可回绕，当前仍为 ${draft.date}`,
            expected: `次日首号填 ${pad(NO_MIN)}`
          });
        } else if (countWraps(segments) >= MAX_WRAP_COUNT) {
          pushIssue(issues, seen, {
            code: "WRAP_LIMIT",
            level: "block",
            message: `本周期已于票号 ${pad(NO_MAX)} 处回绕 ${MAX_WRAP_COUNT} 次，不能再次回绕`,
            expected: "请联系站长核对票号本"
          });
        } else if (startNo !== NO_MIN) {
          pushIssue(issues, seen, {
            code: "GAP",
            level: "review",
            message: `跨日回绕后首号应为 ${pad(NO_MIN)}，实际填 ${pad(startNo)}`,
            expected: pad(NO_MIN)
          });
        }
      } else if (startNo !== prev.endNo + 1) {
        pushIssue(issues, seen, {
          code: "GAP",
          level: "review",
          message: `首号 ${pad(startNo)} 未紧接前班（${prev.date} ${prev.shift}）尾号 ${pad(prev.endNo)}`,
          expected: pad(prev.endNo + 1)
        });
      }
    }
  }

  // 硬挡项排在前面展示。
  return issues.sort((a, b) => Number(BLOCK_CODES.has(b.code)) - Number(BLOCK_CODES.has(a.code)));
}

export function hasBlock(issues: Issue[]): boolean {
  return issues.some((issue) => BLOCK_CODES.has(issue.code));
}

/** 已占用票号段的衔接标注，用于台账“占用一览”，刷新后按持久化数据重算。 */
export interface OccupancyRow {
  segment: Segment;
  level: "ok" | "review" | "block";
  label: string;
  detail: string;
  expected?: string;
}

export function occupancyView(segments: Segment[]): OccupancyRow[] {
  const sorted = [...segments].sort(compareOccasion);
  return sorted.map((segment, index) => {
    const prev = sorted[index - 1];
    const ownCycle = cycleIndex(segment, sorted);

    const overlapping = sorted.filter(
      (other) =>
        other.entryId !== segment.entryId &&
        cycleIndex(other, sorted) === ownCycle &&
        overlaps(segment, other)
    );
    if (overlapping.length > 0) {
      return {
        segment,
        level: "review",
        label: "重号",
        detail: `与 ${overlapping.map((item) => `${item.date} ${item.shift} ${formatRange(item.startNo, item.endNo)}`).join("；")} 重叠`
      };
    }

    if (!prev) {
      return {
        segment,
        level: segment.startNo === NO_MIN ? "ok" : "review",
        label: segment.startNo === NO_MIN ? "期初" : "跳号",
        detail:
          segment.startNo === NO_MIN
            ? `自 ${pad(NO_MIN)} 起号`
            : `期初首号为 ${pad(segment.startNo)}，非 ${pad(NO_MIN)}`,
        expected: segment.startNo === NO_MIN ? undefined : pad(NO_MIN)
      };
    }

    const sameDay = prev.date === segment.date;
    if (prev.endNo === NO_MAX) {
      if (sameDay) {
        return {
          segment,
          level: "block",
          label: "同日回绕",
          detail: `前班尾号已到 ${pad(NO_MAX)}，回绕须跨日，当前仍为 ${segment.date}`,
          expected: `次日首号 ${pad(NO_MIN)}`
        };
      }
      if (segment.startNo === NO_MIN) {
        return {
          segment,
          level: "ok",
          label: "跨日回绕",
          detail: `${prev.date} ${prev.shift} 尾号 ${pad(prev.endNo)} → ${segment.date} ${segment.shift} 首号 ${pad(segment.startNo)}`
        };
      }
      return {
        segment,
        level: "review",
        label: "跳号",
        detail: `跨日回绕后首号应为 ${pad(NO_MIN)}，实际为 ${pad(segment.startNo)}`,
        expected: pad(NO_MIN)
      };
    }

    const expectedStart = prev.endNo + 1;
    if (segment.startNo === expectedStart) {
      return {
        segment,
        level: "ok",
        label: "紧接",
        detail: `首号 ${pad(segment.startNo)} 紧接 ${prev.date} ${prev.shift} 尾号 ${pad(prev.endNo)}`
      };
    }
    return {
      segment,
      level: "review",
      label: "跳号",
      detail: `与 ${prev.date} ${prev.shift} 尾号 ${pad(prev.endNo)} 之间不衔接`,
      expected: pad(expectedStart)
    };
  });
}

/** 给定已占用段，推算下一班次的应填首号（含回绕提示）。 */
export function suggestedNext(segments: Segment[]): {
  startNo: number;
  wraps: boolean;
  wrapUsed: boolean;
  prev: Segment | null;
} {
  const prev = segments.length > 0 ? segments[segments.length - 1] : null;
  const wrapUsed = countWraps(segments) >= MAX_WRAP_COUNT;
  if (!prev) return { startNo: NO_MIN, wraps: false, wrapUsed, prev };
  if (prev.endNo >= NO_MAX) {
    return { startNo: NO_MIN, wraps: true, wrapUsed, prev };
  }
  return { startNo: prev.endNo + 1, wraps: false, wrapUsed, prev };
}
