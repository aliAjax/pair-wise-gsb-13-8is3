// 界面状态层：响应式台账状态 + 操作编排。
// 票号规则来自 rules.ts，持久化来自 store.ts，本层只负责组合与界面状态，不内嵌规则。

import { computed, reactive, ref } from "vue";
import {
  STATUS_CONFIRMED,
  STATUS_DRAFT,
  confirmEntry,
  createEntry,
  reviseEntry,
  sortEntries,
  type LedgerEntry
} from "./model";
import { invoiceStore, type BlockedAttempt } from "./store";
import {
  buildSegments,
  evaluate,
  hasBlock,
  ISSUE_META,
  parseDraft,
  type DraftInput,
  type Issue
} from "./rules";

interface State {
  entries: LedgerEntry[];
  blockedLog: BlockedAttempt[];
  loadedAt: string;
}

const initial = invoiceStore.load();
const state = reactive<State>({
  entries: sortEntries(initial.entries),
  blockedLog: initial.blockedLog,
  loadedAt: new Date().toISOString()
});

function persist() {
  state.entries = sortEntries(state.entries);
  invoiceStore.save(state.entries, state.blockedLog);
}

export interface ActionResult {
  ok: boolean;
  blocked?: BlockedAttempt;
  issues: Issue[];
}

function describeCurrent(entry: LedgerEntry): string {
  const v = entry.current;
  const voidText = v.voids.length
    ? `；作废 ${v.voids.map((item) => `${String(item.no).padStart(8, "0")}(${item.reason || "原因空"})`).join("、")}`
    : "；无作废";
  return `票号 ${String(v.startNo).padStart(8, "0")}–${String(v.endNo).padStart(8, "0")}，金额 ${v.amount}${voidText}`;
}

function describeDraft(input: DraftInput): string {
  const parsed = parseDraft(input);
  const range =
    parsed.startNo !== null && parsed.endNo !== null
      ? `${String(parsed.startNo).padStart(8, "0")}–${String(parsed.endNo).padStart(8, "0")}`
      : `${input.startText.trim() || "?"}–${input.endText.trim() || "?"}`;
  const amount = parsed.amount !== null ? String(parsed.amount) : input.amountText.trim() || "?";
  const voidText = input.voids.some((row) => row.noText.trim() || row.reason.trim())
    ? `；作废 ${input.voids
        .filter((row) => row.noText.trim() || row.reason.trim())
        .map((row) => `${row.noText.trim() || "?"}(${row.reason.trim() || "原因空"})`)
        .join("、")}`
    : "；无作废";
  return `票号 ${range}，金额 ${amount}${voidText}`;
}

function recordBlocked(params: {
  action: BlockedAttempt["action"];
  input: DraftInput;
  issues: Issue[];
  oldValue: string;
  editId?: string;
}): BlockedAttempt {
  const parsed = parseDraft(params.input);
  const range =
    parsed.startNo !== null && parsed.endNo !== null
      ? `${String(parsed.startNo).padStart(8, "0")}–${String(parsed.endNo).padStart(8, "0")}`
      : `${params.input.startText.trim() || "?"}–${params.input.endText.trim() || "?"}`;
  const attempt: BlockedAttempt = {
    id: crypto.randomUUID(),
    time: new Date().toISOString(),
    action: params.action,
    date: params.input.date,
    shift: params.input.shift,
    range,
    oldValue: params.oldValue,
    newValue: describeDraft(params.input),
    codes: params.issues.map((issue) => issue.code),
    messages: params.issues.map((issue) => `[${ISSUE_META[issue.code].label}] ${issue.message}`)
  };
  state.blockedLog = [attempt, ...state.blockedLog].slice(0, 50);
  persist();
  return attempt;
}

export function useLedger() {
  const entries = computed(() => state.entries);
  const blockedLog = computed(() => state.blockedLog);
  const loadedAt = computed(() => state.loadedAt);

  /** 所有班次当前生效版本的占用段（排除可选条目），每次读取都由最新持久化状态推导。 */
  function segments(excludeId?: string) {
    return buildSegments(
      state.entries.map((entry) => ({ ...entry, confirmed: entry.status === STATUS_CONFIRMED })),
      excludeId
    );
  }

  function issuesFor(input: DraftInput, editId?: string): Issue[] {
    return evaluate(input, segments(editId));
  }

  function addEntry(input: DraftInput): ActionResult {
    const issues = evaluate(input, segments());
    if (hasBlock(issues)) {
      return { ok: false, blocked: recordBlocked({ action: "保存登记", input, issues, oldValue: "无（新登记）" }), issues };
    }
    const parsed = parseDraft(input);
    const entry = createEntry({
      id: crypto.randomUUID(),
      date: parsed.date,
      shift: parsed.shift,
      startNo: parsed.startNo as number,
      endNo: parsed.endNo as number,
      amount: parsed.amount as number,
      voids: parsed.voids
        .filter((row) => row.no !== null)
        .map((row) => ({ no: row.no as number, reason: row.reason }))
    });
    // 存在待复核级问题（跳号/重号/作废原因空）时，保存成功但保持待复核（createEntry 默认即待复核）。
    state.entries.push(entry);
    persist();
    return { ok: true, issues };
  }

  function confirm(id: string, currentInput: DraftInput): ActionResult {
    const entry = state.entries.find((item) => item.id === id);
    if (!entry) return { ok: false, issues: [] };
    const issues = evaluate(currentInput, segments(id));
    if (issues.length > 0) {
      return {
        ok: false,
        blocked: recordBlocked({ action: "确认固定", input: currentInput, issues, oldValue: describeCurrent(entry), editId: id }),
        issues
      };
    }
    const idx = state.entries.findIndex((item) => item.id === id);
    state.entries[idx] = confirmEntry(entry);
    persist();
    return { ok: true, issues };
  }

  function revise(id: string, input: DraftInput, reason: string): ActionResult {
    const entry = state.entries.find((item) => item.id === id);
    if (!entry) return { ok: false, issues: [] };
    const issues = evaluate(input, segments(id));
    if (hasBlock(issues)) {
      return {
        ok: false,
        blocked: recordBlocked({ action: "修正版本", input, issues, oldValue: describeCurrent(entry), editId: id }),
        issues
      };
    }
    if (!reason.trim()) {
      const issue: Issue = { code: "INCOMPLETE", level: "block", message: "修正必须填写修正原因，旧版本将原样保留" };
      return {
        ok: false,
        blocked: recordBlocked({ action: "修正版本", input, issues: [issue, ...issues], oldValue: describeCurrent(entry), editId: id }),
        issues: [issue, ...issues]
      };
    }
    const parsed = parseDraft(input);
    const idx = state.entries.findIndex((item) => item.id === id);
    state.entries[idx] = reviseEntry(entry, {
      startNo: parsed.startNo as number,
      endNo: parsed.endNo as number,
      amount: parsed.amount as number,
      voids: parsed.voids
        .filter((row) => row.no !== null)
        .map((row) => ({ no: row.no as number, reason: row.reason })),
      reason: reason.trim()
    });
    persist();
    return { ok: true, issues };
  }

  function remove(id: string) {
    const entry = state.entries.find((item) => item.id === id);
    if (entry && entry.status === STATUS_DRAFT) {
      state.entries = state.entries.filter((item) => item.id !== id);
      persist();
    }
  }

  function clearBlockedLog() {
    state.blockedLog = [];
    persist();
  }

  function resetAll() {
    const data = invoiceStore.reset();
    state.entries = sortEntries(data.entries);
    state.blockedLog = data.blockedLog;
    state.loadedAt = new Date().toISOString();
  }

  /** 模拟“刷新”：重新从 localStorage 读取，验证占用段与版本历史不错位。 */
  function reloadFromStorage() {
    const data = invoiceStore.load();
    state.entries = sortEntries(data.entries);
    state.blockedLog = data.blockedLog;
    state.loadedAt = new Date().toISOString();
  }

  return {
    entries,
    blockedLog,
    loadedAt,
    segments,
    issuesFor,
    addEntry,
    confirm,
    revise,
    remove,
    clearBlockedLog,
    resetAll,
    reloadFromStorage,
    STATUS_CONFIRMED,
    STATUS_DRAFT
  };
}
