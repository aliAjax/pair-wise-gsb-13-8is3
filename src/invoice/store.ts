/**
 * 发票票号台账存储层
 *
 * 职责：
 * - 台账数据仅以 localStorage 中一份 JSON 为唯一事实来源，切换班次视图或刷新不错位；
 * - 待复核班次可反复覆盖编辑；确认后票号/金额固定，任何修改只能走“修正”；
 * - 修正生成新版本，旧版本原样保留在 versionHistory；
 * - 删除只允许待复核；
 * - 被挡操作集中记录在 blocked，界面据此展示命中校验、票号段、原值、新值。
 *
 * 本层不感知 Vue 组件结构，规则判断全部委托 rules.ts。
 */
import { computed, reactive, ref } from "vue";
import {
  CONFIRMED,
  ISSUE_TEXT,
  PENDING,
  collectOccupied,
  formatTicket,
  parseAmount,
  parseTicket,
  shiftIndex,
  shiftLabel,
  tailExpectation,
  validateSequence,
  type IssueCode,
  type OccupiedSegment,
  type SequenceShift,
  type ValidationIssue
} from "./rules";

const STORAGE_KEY = "dfwlfront-7-invoice-ledger-v1";
const SCHEMA = 1;

export interface VoidRow {
  ticket: string;
  reason: string;
}

export interface LedgerSnapshot {
  first: string;
  last: string;
  amount: string;
  voids: VoidRow[];
}

export interface LedgerVersion extends LedgerSnapshot {
  version: number;
  createdAt: string;
  /** v>1 时必填：为什么产生此版本（修正原因）。 */
  reason?: string;
}

export interface LedgerEntry {
  id: string;
  date: string;
  shift: string;
  status: typeof PENDING | typeof CONFIRMED;
  createdAt: string;
  confirmedAt?: string;
  first: string;
  last: string;
  amount: string;
  voids: VoidRow[];
  currentVersion: number;
  versionHistory: LedgerVersion[];
}

interface PersistedState {
  schema: number;
  entries: LedgerEntry[];
}

export interface BlockedInfo {
  action: string;
  entryId: string;
  entryLabel: string;
  reason: string;
  ticketSegment: string;
  oldValue: string;
  newValue: string;
  issues: ValidationIssue[];
  at: string;
}

export interface ActionResult {
  ok: boolean;
  entryId?: string;
  blocked?: BlockedInfo;
}

export interface DraftValues {
  date: string;
  shift: string;
  first: string;
  last: string;
  amount: string;
  voids: VoidRow[];
}

// —— 工具 ——

function isoDate(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

function uid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `inv-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

/** 票号字段统一补零（可解析时），空白原样保留以便提示。 */
function normalizeTicket(raw: string): string {
  const value = parseTicket(raw);
  return value === null ? String(raw ?? "").trim() : formatTicket(value);
}

function normalizeSnapshot(raw: LedgerSnapshot): LedgerSnapshot {
  return {
    first: normalizeTicket(raw.first),
    last: normalizeTicket(raw.last),
    amount: String(raw.amount ?? "").trim(),
    voids: (raw.voids ?? []).map((v) => ({ ticket: normalizeTicket(v.ticket), reason: v.reason.trim() }))
  };
}

function toSnapshot(entry: LedgerEntry): LedgerSnapshot {
  return { first: entry.first, last: entry.last, amount: entry.amount, voids: entry.voids };
}

function buildEntry(
  draft: DraftValues,
  status: LedgerEntry["status"],
  options: { createdAt: string; confirmedAt?: string }
): LedgerEntry {
  const snap = normalizeSnapshot(draft);
  return {
    id: uid(),
    date: draft.date,
    shift: draft.shift,
    status,
    createdAt: options.createdAt,
    confirmedAt: options.confirmedAt,
    ...snap,
    currentVersion: 1,
    versionHistory: [
      {
        version: 1,
        createdAt: options.createdAt,
        ...snap
      }
    ]
  };
}

/** 台账里的最新版本才参与号段规则；历史版本只展示。 */
function toSequence(entry: LedgerEntry): SequenceShift {
  return {
    id: entry.id,
    date: entry.date,
    shift: entry.shift,
    first: entry.first,
    last: entry.last,
    amount: entry.amount,
    voids: entry.voids
  };
}

// —— 种子数据（首装时展示，已复核 + 待复核各一班，号段衔接） ——

function seed(): LedgerEntry[] {
  const created = (daysAgo: number, hours: number): string => {
    const d = new Date();
    d.setDate(d.getDate() - daysAgo);
    d.setHours(hours, 0, 0, 0);
    return d.toISOString();
  };

  const first = buildEntry(
    {
      date: isoDate(1),
      shift: "晚班",
      first: "00001001",
      last: "00001120",
      amount: "38650.00",
      voids: [{ ticket: "00001088", reason: "发票抬头错误，客户拒收" }]
    },
    CONFIRMED,
    { createdAt: created(1, 22), confirmedAt: created(1, 22) }
  );

  const second = buildEntry(
    {
      date: isoDate(0),
      shift: "早班",
      first: "00001121",
      last: "00001205",
      amount: "21430.00",
      voids: [{ ticket: "", reason: "" }]
    },
    PENDING,
    { createdAt: created(0, 8) }
  );

  return [first, second];
}

// —— 装载（唯一一次读 localStorage） ——

function load(): LedgerEntry[] {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    const entries = seed();
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ schema: SCHEMA, entries } satisfies PersistedState));
    return entries;
  }
  try {
    const parsed = JSON.parse(raw) as PersistedState;
    if (!parsed || !Array.isArray(parsed.entries)) return [];
    return parsed.entries;
  } catch {
    return [];
  }
}

const entries = ref<LedgerEntry[]>(load());
const blocked = ref<BlockedInfo | null>(null);

function persist() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ schema: SCHEMA, entries: entries.value } satisfies PersistedState));
}

/** 时序：日期升序，同日早 < 中 < 晚。 */
function chronoSorted(list: LedgerEntry[]): LedgerEntry[] {
  return [...list].sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return shiftIndex(a.shift) - shiftIndex(b.shift);
  });
}

const sortedEntries = computed(() => chronoSorted(entries.value));

/** 当前生效班次构成的号段链，所有校验/占用都从这里派生。 */
const sequence = computed<SequenceShift[]>(() => sortedEntries.value.map(toSequence));

const issues = computed(() => validateSequence(sequence.value));

const issueMap = computed<Record<string, ValidationIssue[]>>(() => {
  const map: Record<string, ValidationIssue[]> = {};
  for (const item of issues.value) {
    (map[item.shiftId] ??= []).push(item);
  }
  return map;
});

const occupied = computed<OccupiedSegment[]>(() => collectOccupied(sequence.value));

const expectation = computed(() => tailExpectation(sequence.value));

const totalAmount = computed(() =>
  sortedEntries.value.reduce((sum, entry) => sum + (parseAmount(entry.amount) ?? 0), 0)
);

// —— 被挡信息：命中校验 + 票号段 + 原值/新值 ——

function guardIssue(code: IssueCode, entry: LedgerEntry, extra?: Partial<ValidationIssue>): ValidationIssue {
  return {
    shiftId: entry.id,
    code,
    shiftLabel: shiftLabel(entry.date, entry.shift),
    message: extra?.message ?? ISSUE_TEXT[code],
    ticketSegment: extra?.ticketSegment ?? "—",
    oldValue: extra?.oldValue ?? "—",
    newValue: extra?.newValue ?? "—"
  };
}

function raiseBlocked(
  action: string,
  entry: LedgerEntry,
  reason: string,
  list: ValidationIssue[],
  fallback?: Partial<Pick<ValidationIssue, "ticketSegment" | "oldValue" | "newValue">>
): ActionResult {
  const lead = list[0];
  blocked.value = {
    action,
    entryId: entry.id,
    entryLabel: shiftLabel(entry.date, entry.shift),
    reason,
    ticketSegment: lead?.ticketSegment ?? fallback?.ticketSegment ?? "—",
    oldValue: lead?.oldValue ?? fallback?.oldValue ?? "—",
    newValue: lead?.newValue ?? fallback?.newValue ?? "—",
    issues: list,
    at: new Date().toISOString()
  };
  return { ok: false, entryId: entry.id, blocked: blocked.value };
}

function raiseSimple(
  action: string,
  label: string,
  code: IssueCode,
  fallback?: Partial<Pick<ValidationIssue, "ticketSegment" | "oldValue" | "newValue">>
): ActionResult {
  const item: ValidationIssue = {
    shiftId: "",
    code,
    shiftLabel: label,
    message: ISSUE_TEXT[code],
    ticketSegment: fallback?.ticketSegment ?? "—",
    oldValue: fallback?.oldValue ?? "—",
    newValue: fallback?.newValue ?? "—"
  };
  blocked.value = {
    action,
    entryId: "",
    entryLabel: label,
    reason: item.message,
    ticketSegment: item.ticketSegment,
    oldValue: item.oldValue,
    newValue: item.newValue,
    issues: [item],
    at: new Date().toISOString()
  };
  return { ok: false, blocked: blocked.value };
}

function findEntry(id: string): LedgerEntry | undefined {
  return entries.value.find((e) => e.id === id);
}

function ownIssues(id: string): ValidationIssue[] {
  return issueMap.value[id] ?? [];
}

// —— 对外操作 ——

/** 表单实时预览：排除当前编辑项后，把候选班次放进号段链一起校验。 */
function preview(draft: DraftValues, editingId?: string): ValidationIssue[] {
  const candidate: SequenceShift = {
    id: "__preview__",
    date: draft.date,
    shift: draft.shift,
    ...normalizeSnapshot(draft)
  };
  return validateSequence([...sequence.value, candidate], editingId).filter(
    (item) => item.shiftId === "__preview__"
  );
}

/** 新登记：日期+班次重复直接拦截；命中规则时仍存为“待复核”。 */
function createEntry(draft: DraftValues): ActionResult {
  const label = shiftLabel(draft.date, draft.shift);
  const duplicate = entries.value.find((e) => e.date === draft.date && e.shift === draft.shift);
  if (duplicate) {
    return raiseSimple(
      "登记班次",
      label,
      "SHIFT_DUPLICATE",
      { oldValue: "该日期班次未登记", newValue: label }
    );
  }

  const entry = buildEntry(draft, PENDING, { createdAt: new Date().toISOString() });
  entries.value = [...entries.value, entry];
  persist();

  const hits = ownIssues(entry.id);
  if (hits.length) {
    return raiseBlocked(
      "登记班次",
      entry,
      `已存为“${PENDING}”：命中 ${hits.length} 项校验，确认入口保持冻结`,
      hits
    );
  }
  blocked.value = null;
  return { ok: true, entryId: entry.id };
}

/** 待复核可覆盖；已复核冻结。 */
function updateDraft(id: string, draft: DraftValues): ActionResult {
  const entry = findEntry(id);
  if (!entry) return { ok: false };
  if (entry.status === CONFIRMED) {
    return raiseBlocked(
      "修改班次",
      entry,
      `已复核票号与金额固定，请使用“发起修正”另存原因版本`,
      [guardIssue("CONFIRMED_LOCKED", entry)]
    );
  }

  const duplicate = entries.value.find((e) => e.id !== id && e.date === draft.date && e.shift === draft.shift);
  if (duplicate) {
    return raiseBlocked("修改班次", entry, ISSUE_TEXT.SHIFT_DUPLICATE, [
      guardIssue("SHIFT_DUPLICATE", entry, {
        oldValue: "该日期班次未登记",
        newValue: shiftLabel(draft.date, draft.shift)
      })
    ]);
  }

  Object.assign(entry, normalizeSnapshot(draft), { date: draft.date, shift: draft.shift });
  persist();

  const hits = ownIssues(id);
  if (hits.length) {
    return raiseBlocked(
      "修改班次",
      entry,
      `命中 ${hits.length} 项校验，保持“${PENDING}”`,
      hits
    );
  }
  blocked.value = null;
  return { ok: true, entryId: id };
}

/** 确认：有待复核命中项即被挡；确认后票号金额固定。 */
function confirmEntry(id: string): ActionResult {
  const entry = findEntry(id);
  if (!entry) return { ok: false };
  if (entry.status === CONFIRMED) return { ok: true, entryId: id };

  const hits = ownIssues(id);
  if (hits.length) {
    return raiseBlocked(
      "确认复核",
      entry,
      `存在 ${hits.length} 项命中校验，无法确认；修正后票号和金额才会固定`,
      hits
    );
  }

  entry.status = CONFIRMED;
  entry.confirmedAt = new Date().toISOString();
  persist();
  blocked.value = null;
  return { ok: true, entryId: id };
}

/** 修正：旧版本原样保留，新版本回到待复核，重新走规则。 */
function correctEntry(id: string, reason: string, draft: DraftValues): ActionResult {
  const entry = findEntry(id);
  if (!entry) return { ok: false };

  const trimmed = reason.trim();
  if (!trimmed) {
    return raiseBlocked("发起修正", entry, ISSUE_TEXT.CORRECT_REASON_EMPTY, [
      guardIssue("CORRECT_REASON_EMPTY", entry, {
        ticketSegment: rangeOf(entry),
        oldValue: "修正原因：必填",
        newValue: "修正原因：（空）"
      })
    ]);
  }

  const duplicate = entries.value.find((e) => e.id !== id && e.date === draft.date && e.shift === draft.shift);
  if (duplicate) {
    return raiseBlocked("发起修正", entry, ISSUE_TEXT.SHIFT_DUPLICATE, [
      guardIssue("SHIFT_DUPLICATE", entry, {
        oldValue: "该日期班次未登记",
        newValue: shiftLabel(draft.date, draft.shift)
      })
    ]);
  }

  const snap = normalizeSnapshot(draft);
  entry.date = draft.date;
  entry.shift = draft.shift;
  Object.assign(entry, snap);
  entry.status = PENDING;
  entry.confirmedAt = undefined;
  entry.currentVersion += 1;
  entry.versionHistory.push({
    version: entry.currentVersion,
    createdAt: new Date().toISOString(),
    reason: trimmed,
    ...snap
  });
  persist();

  const hits = ownIssues(id);
  if (hits.length) {
    return raiseBlocked(
      "发起修正",
      entry,
      `修正版本 v${entry.currentVersion} 已另存并保留旧内容，但命中 ${hits.length} 项校验，需复核`,
      hits
    );
  }
  blocked.value = null;
  return { ok: true, entryId: id };
}

/** 删除：只允许待复核；已复核须先修正留痕，不能物理删除。 */
function removeEntry(id: string): ActionResult {
  const entry = findEntry(id);
  if (!entry) return { ok: false };
  if (entry.status === CONFIRMED) {
    return raiseBlocked(
      "删除班次",
      entry,
      "已复核班次不可删除；如需调整请发起修正并保留版本痕迹",
      [
        guardIssue("CONFIRMED_LOCKED", entry, {
          ticketSegment: rangeOf(entry),
          oldValue: `已复核 v${entry.currentVersion} 票号/金额固定`,
          newValue: "请求物理删除"
        })
      ]
    );
  }

  entries.value = entries.value.filter((e) => e.id !== id);
  persist();
  blocked.value = null;
  return { ok: true, entryId: id };
}

function rangeOf(entry: LedgerEntry): string {
  const first = parseTicket(entry.first);
  const last = parseTicket(entry.last);
  if (first === null || last === null || first > last) return `${entry.first || "?"}-${entry.last || "?"}`;
  return `${formatTicket(first)}${first === last ? "" : `-${formatTicket(last)}`}`;
}

function dismissBlocked() {
  blocked.value = null;
}

export const ledgerStore = reactive({
  entries: sortedEntries,
  issues,
  issueMap,
  occupied,
  expectation,
  blocked,
  totalAmount,
  preview,
  createEntry,
  updateDraft,
  confirmEntry,
  correctEntry,
  removeEntry,
  dismissBlocked
});
