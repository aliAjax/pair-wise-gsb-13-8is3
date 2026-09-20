/** 内存版 localStorage，供 node 下存储层自检使用，必须在 store 之前导入。 */
const mem = new Map<string, string>();

mem.set(
  "dfwlfront-7-invoice-ledger-v1",
  JSON.stringify({ schema: 1, entries: [] })
);

(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => (mem.has(k) ? (mem.get(k) as string) : null),
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => void mem.clear(),
  key: (i: number) => [...mem.keys()][i] ?? null,
  get length() {
    return mem.size;
  }
} as Storage;
