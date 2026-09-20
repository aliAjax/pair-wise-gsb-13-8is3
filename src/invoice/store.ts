// 存储层：只管 localStorage 读写、种子数据与结构迁移，不做票号业务校验。

import type { LedgerEntry } from "./model";
import { STATUS_DRAFT } from "./model";
import type { IssueCode } from "./rules";
import { pad } from "./rules";

export const STORAGE_KEY = "dfwlfront-7-invoice-ledger";
export const SCHEMA_VERSION = 1;

/** 被挡操作留痕：票号段、原值、新值、命中校验一并持久化，刷新不丢。 */
export interface BlockedAttempt {
  id: string;
  time: string;
  action: "保存登记" | "确认固定" | "修正版本";
  date: string;
  shift: string;
  range: string;
  oldValue: string;
  newValue: string;
  codes: IssueCode[];
  messages: string[];
}

interface StoredShape {
  schema: number;
  entries: LedgerEntry[];
  blockedLog: BlockedAttempt[];
}

/**
 * 种子数据演示完整链路：
 * 早班 00000001–00000050（含一张有原因作废，已确认）；
 * 中班紧接 00000051 起，尚未登记尾号，由界面引导衔接校验。
 */
function seed(): StoredShape {
  const day = new Date().toISOString().slice(0, 10);
  const morning: LedgerEntry = {
    id: "seed-morning",
    date: day,
    shift: "早班",
    status: "已确认",
    current: {
      version: 1,
      startNo: 1,
      endNo: 50,
      amount: 18650.5,
      voids: [{ no: 37, reason: "打印机卡纸，票面污损" }],
      reason: "当班登记",
      createdAt: new Date(Date.now() - 6 * 3600_000).toISOString()
    },
    history: [],
    createdAt: new Date(Date.now() - 6 * 3600_000).toISOString(),
    updatedAt: new Date(Date.now() - 2 * 3600_000).toISOString()
  };
  const noon: LedgerEntry = {
    id: "seed-noon",
    date: day,
    shift: "中班",
    status: STATUS_DRAFT,
    current: {
      version: 1,
      startNo: 51,
      endNo: 51,
      amount: 0,
      voids: [],
      reason: "当班登记",
      createdAt: new Date(Date.now() - 3600_000).toISOString()
    },
    history: [],
    createdAt: new Date(Date.now() - 3600_000).toISOString(),
    updatedAt: new Date(Date.now() - 3600_000).toISOString()
  };
  return { schema: SCHEMA_VERSION, entries: [morning, noon], blockedLog: [] };
}

function normalize(raw: unknown): StoredShape {
  if (raw && typeof raw === "object") {
    const obj = raw as Partial<StoredShape>;
    if (Array.isArray(obj.entries)) {
      return { schema: SCHEMA_VERSION, entries: obj.entries as LedgerEntry[], blockedLog: Array.isArray(obj.blockedLog) ? obj.blockedLog : [] };
    }
  }
  // 兼容最初可能直接存数组的形态。
  if (Array.isArray(raw)) return { schema: SCHEMA_VERSION, entries: raw as LedgerEntry[], blockedLog: [] };
  return seed();
}

export const invoiceStore = {
  load(): StoredShape {
    try {
      const text = localStorage.getItem(STORAGE_KEY);
      if (!text) return seed();
      return normalize(JSON.parse(text));
    } catch {
      return seed();
    }
  },
  save(entries: LedgerEntry[], blockedLog: BlockedAttempt[]): void {
    const payload: StoredShape = { schema: SCHEMA_VERSION, entries, blockedLog };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  },
  reset(): StoredShape {
    const data = seed();
    this.save(data.entries, data.blockedLog);
    return data;
  }
};

/** 版本展示用：票号段文本。 */
export function versionRangeText(entry: LedgerEntry): string {
  return `${pad(entry.current.startNo)} – ${pad(entry.current.endNo)}`;
}
