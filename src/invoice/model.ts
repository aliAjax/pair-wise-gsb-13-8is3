// 发票台账数据模型层：条目结构、版本快照、修正留痕。
// 不接触 localStorage，不依赖 Vue，只保证“确认后固定、修正另存版本、旧内容保留”。

import type { VoidItem } from "./rules";

export const STATUS_DRAFT = "待复核" as const;
export const STATUS_CONFIRMED = "已确认" as const;
export type LedgerStatus = typeof STATUS_DRAFT | typeof STATUS_CONFIRMED;

export interface LedgerVersion {
  version: number;
  startNo: number;
  endNo: number;
  amount: number;
  voids: VoidItem[];
  reason: string;
  createdAt: string;
}

export interface LedgerEntry {
  id: string;
  date: string;
  shift: string;
  status: LedgerStatus;
  current: LedgerVersion;
  history: LedgerVersion[];
  createdAt: string;
  updatedAt: string;
}

export function latestVersion(entry: LedgerEntry): LedgerVersion {
  return entry.current;
}

export function createEntry(params: {
  id: string;
  date: string;
  shift: string;
  startNo: number;
  endNo: number;
  amount: number;
  voids: VoidItem[];
  now?: string;
}): LedgerEntry {
  const now = params.now ?? new Date().toISOString();
  const initial: LedgerVersion = {
    version: 1,
    startNo: params.startNo,
    endNo: params.endNo,
    amount: params.amount,
    voids: params.voids.map((item) => ({ no: item.no, reason: item.reason })),
    reason: "当班登记",
    createdAt: now
  };
  return {
    id: params.id,
    date: params.date,
    shift: params.shift,
    status: STATUS_DRAFT,
    current: initial,
    history: [],
    createdAt: now,
    updatedAt: now
  };
}

/** 确认后票号与金额固定：确认仅改状态，不改任何业务值。 */
export function confirmEntry(entry: LedgerEntry, now: string = new Date().toISOString()): LedgerEntry {
  return { ...entry, status: STATUS_CONFIRMED, updatedAt: now };
}

/**
 * 修正另存为原因版本：旧 current 完整进入 history，新值成为 current。
 * 未确认班次修正后仍为待复核；已确认班次修正后也回到待复核，需重新确认。
 */
export function reviseEntry(
  entry: LedgerEntry,
  revision: {
    startNo: number;
    endNo: number;
    amount: number;
    voids: VoidItem[];
    reason: string;
  },
  now: string = new Date().toISOString()
): LedgerEntry {
  const next: LedgerVersion = {
    version: entry.current.version + 1,
    startNo: revision.startNo,
    endNo: revision.endNo,
    amount: revision.amount,
    voids: revision.voids.map((item) => ({ no: item.no, reason: item.reason })),
    reason: revision.reason,
    createdAt: now
  };
  return {
    ...entry,
    status: STATUS_DRAFT,
    current: next,
    history: [...entry.history, entry.current],
    updatedAt: now
  };
}

export function sortEntries(entries: LedgerEntry[]): LedgerEntry[] {
  return [...entries].sort((a, b) => {
    const keyA = `${a.date}#${a.shift}#${a.createdAt}`;
    const keyB = `${b.date}#${b.shift}#${b.createdAt}`;
    return keyA.localeCompare(keyB);
  });
}
