<script setup lang="ts">
/**
 * 发票票号台账界面层
 * 只负责渲染与交互；号段规则在 rules.ts，数据与版本在 store.ts。
 */
import { computed, ref } from "vue";
import {
  CONFIRMED,
  PENDING,
  SHIFTS,
  TICKET_MAX,
  formatTicket,
  type ValidationIssue
} from "./rules";
import { ledgerStore, type DraftValues, type LedgerEntry, type VoidRow } from "./store";

type FormMode = "new" | "edit" | "correct";

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function blankDraft(): DraftValues {
  return {
    date: today(),
    shift: SHIFTS[0],
    first: "",
    last: "",
    amount: "",
    voids: [{ ticket: "", reason: "" }]
  };
}

const mode = ref<FormMode>("new");
const editingId = ref<string | null>(null);
const correctReason = ref("");
const form = ref<DraftValues>(blankDraft());
const filter = ref<"全部班次" | (typeof SHIFTS)[number]>("全部班次");
const expanded = ref<Set<string>>(new Set());
const lastResult = ref<{ ok: boolean; message: string } | null>(null);

const isNew = computed(() => mode.value === "new");
const editingEntry = computed(() =>
  editingId.value ? ledgerStore.entries.find((e) => e.id === editingId.value) : undefined
);

const formTitle = computed(() => {
  if (mode.value === "edit") return "修改待复核班次";
  if (mode.value === "correct") return "发起修正（另存原因版本）";
  return "登记班次发票票号";
});

/** 实时预览候选班次放进号段链后的命中项（不含编辑项自身旧值）。 */
const previewIssues = computed<ValidationIssue[]>(() => {
  if (mode.value === "correct" && !correctReason.value.trim()) {
    return ledgerStore.preview(form.value, editingId.value ?? undefined);
  }
  return ledgerStore.preview(form.value, editingId.value ?? undefined);
});

const filteredEntries = computed(() =>
  filter.value === "全部班次"
    ? ledgerStore.entries
    : ledgerStore.entries.filter((e) => e.shift === filter.value)
);

const metrics = computed(() => {
  const list = ledgerStore.entries;
  const confirmed = list.filter((e) => e.status === CONFIRMED).length;
  const pending = list.filter((e) => e.status === PENDING).length;
  const pendingHit = list.filter((e) => e.status === PENDING && (ledgerStore.issueMap[e.id]?.length ?? 0) > 0).length;
  const voidCount = list.reduce((sum, e) => sum + e.voids.filter((v) => v.ticket).length, 0);
  return [
    { label: "登记班次", value: list.length },
    { label: "已复核（票号金额固定）", value: confirmed },
    { label: "待复核", value: pending },
    { label: "待复核且命中校验", value: pendingHit },
    { label: "作废发票", value: voidCount },
    { label: "累计开票金额", value: `¥${ledgerStore.totalAmount.toLocaleString("zh-CN", { minimumFractionDigits: 2 })}` }
  ];
});

function issuesOf(entry: LedgerEntry): ValidationIssue[] {
  return ledgerStore.issueMap[entry.id] ?? [];
}

function fillExpected() {
  const expected = ledgerStore.expectation.expectedFirst;
  if (expected !== null) form.value.first = expected;
}

function addVoidRow() {
  form.value.voids.push({ ticket: "", reason: "" });
}

function removeVoidRow(index: number) {
  form.value.voids.splice(index, 1);
  if (form.value.voids.length === 0) addVoidRow();
}

function draftFromEntry(entry: LedgerEntry): DraftValues {
  return {
    date: entry.date,
    shift: entry.shift as DraftValues["shift"],
    first: entry.first,
    last: entry.last,
    amount: entry.amount,
    voids: entry.voids.length
      ? entry.voids.map((v) => ({ ...v }))
      : [{ ticket: "", reason: "" }]
  };
}

function resetForm() {
  form.value = blankDraft();
  correctReason.value = "";
  editingId.value = null;
  mode.value = "new";
  lastResult.value = null;
}

function startEdit(entry: LedgerEntry) {
  if (entry.status === CONFIRMED) return;
  mode.value = "edit";
  editingId.value = entry.id;
  form.value = draftFromEntry(entry);
  correctReason.value = "";
  lastResult.value = null;
}

function startCorrect(entry: LedgerEntry) {
  mode.value = "correct";
  editingId.value = entry.id;
  form.value = draftFromEntry(entry);
  correctReason.value = "";
  lastResult.value = null;
}

function submit() {
  let result;
  if (mode.value === "new") {
    result = ledgerStore.createEntry(form.value);
  } else if (mode.value === "edit" && editingId.value) {
    result = ledgerStore.updateDraft(editingId.value, form.value);
  } else if (mode.value === "correct" && editingId.value) {
    result = ledgerStore.correctEntry(editingId.value, correctReason.value, form.value);
  } else {
    return;
  }

  lastResult.value = result.ok
    ? { ok: true, message: mode.value === "correct" ? "修正版本已另存，旧内容保留在版本历史" : "已保存" }
    : { ok: false, message: result.blocked?.reason ?? "操作被拦截" };

  if (result.ok) resetForm();
}

function confirmEntry(entry: LedgerEntry) {
  const result = ledgerStore.confirmEntry(entry.id);
  if (result.ok) lastResult.value = { ok: true, message: "已确认，票号与金额固定" };
}

function removeEntry(entry: LedgerEntry) {
  ledgerStore.removeEntry(entry.id);
}

function toggleHistory(id: string) {
  const next = new Set(expanded.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expanded.value = next;
}

function formatTime(iso: string): string {
  return iso.replace("T", " ").slice(0, 16);
}

function amountText(value: string): string {
  const num = Number(value);
  return Number.isFinite(num) && value.trim() !== ""
    ? `¥${num.toLocaleString("zh-CN", { minimumFractionDigits: 2 })}`
    : value || "（空）";
}

const wrapText = computed(() =>
  ledgerStore.expectation.wrapUsed ? "跨日回绕 1/1（额度已用完）" : "跨日回绕 0/1（允许跨日回绕一次）"
);

const maxTicket = formatTicket(TICKET_MAX);
</script>

<template>
  <section class="ledger">
    <header class="ledger-head">
      <div>
        <p class="eyebrow">发票票号台账</p>
        <h2>班次交接票号登记</h2>
        <p class="subtitle">
          每班登记票号首尾、开票金额与作废明细；后班首号紧接前班尾号，跨日最多回绕一次（{{ maxTicket }} → 00000000）。
          跳号、重号或作废说明为空时保持待复核；确认后票号金额固定，修正另存原因版本并保留旧内容。
        </p>
      </div>
    </header>

    <div class="inv-metrics">
      <article v-for="m in metrics" :key="m.label" class="inv-metric">
        <span>{{ m.label }}</span>
        <strong>{{ m.value }}</strong>
      </article>
    </div>

    <!-- 被挡操作：票号段、原值、新值、命中校验 -->
    <div v-if="ledgerStore.blocked" class="blocked">
      <div class="blocked-head">
        <strong>被挡操作：{{ ledgerStore.blocked.action }} · {{ ledgerStore.blocked.entryLabel }}</strong>
        <button type="button" class="secondary" @click="ledgerStore.dismissBlocked()">知道了</button>
      </div>
      <p class="blocked-reason">{{ ledgerStore.blocked.reason }}</p>
      <div class="blocked-summary">
        <span>命中票号段：<b>{{ ledgerStore.blocked.ticketSegment }}</b></span>
        <span>原值：<b>{{ ledgerStore.blocked.oldValue }}</b></span>
        <span>新值：<b>{{ ledgerStore.blocked.newValue }}</b></span>
      </div>
      <table class="blocked-table">
        <thead>
          <tr><th>命中校验</th><th>票号段</th><th>原值</th><th>新值</th></tr>
        </thead>
        <tbody>
          <tr v-for="(item, i) in ledgerStore.blocked.issues" :key="`${item.code}-${i}`">
            <td><span class="code">{{ item.code }}</span>{{ item.message }}</td>
            <td>{{ item.ticketSegment }}</td>
            <td>{{ item.oldValue }}</td>
            <td>{{ item.newValue }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <p v-if="lastResult?.ok" class="result-ok">{{ lastResult.message }}</p>

    <div class="inv-workspace">
      <!-- 左：登记表单 -->
      <form class="panel inv-form" @submit.prevent="submit">
        <h3>{{ formTitle }}</h3>
        <p v-if="mode === 'edit' && editingEntry" class="form-context">
          正在修改：{{ editingEntry.date }} {{ editingEntry.shift }}（待复核，保存即覆盖）
        </p>
        <p v-if="mode === 'correct' && editingEntry" class="form-context warn">
          正在修正：{{ editingEntry.date }} {{ editingEntry.shift }}（当前 v{{ editingEntry.currentVersion }} 已复核，
          提交后旧版本原样保留，新版本回到待复核）
        </p>

        <div class="field">
          <label>班次日期</label>
          <input v-model="form.date" type="date" required />
        </div>
        <div class="field">
          <label>班次</label>
          <select v-model="form.shift" required>
            <option v-for="s in SHIFTS" :key="s" :value="s">{{ s }}</option>
          </select>
        </div>
        <div class="field two">
          <div>
            <label>票号首号</label>
            <input v-model="form.first" placeholder="00000000" inputmode="numeric" maxlength="8" required />
          </div>
          <div>
            <label>票号尾号</label>
            <input v-model="form.last" placeholder="99999999" inputmode="numeric" maxlength="8" required />
          </div>
        </div>
        <p v-if="ledgerStore.expectation.expectedFirst !== null" class="hint">
          前班（{{ ledgerStore.expectation.tailLabel }}）之后，本班首号应为
          <b>{{ ledgerStore.expectation.expectedFirst }}</b>
          <button type="button" class="link" @click="fillExpected">填入</button>
          · {{ wrapText }}
        </p>
        <div class="field">
          <label>开票金额（元）</label>
          <input v-model="form.amount" placeholder="0.00" inputmode="decimal" required />
        </div>

        <fieldset class="voids">
          <legend>作废明细（作废必须填票号和原因）</legend>
          <div v-for="(row, i) in form.voids" :key="i" class="void-row">
            <input v-model="row.ticket" placeholder="作废票号" inputmode="numeric" maxlength="8" />
            <input v-model="row.reason" placeholder="作废原因（必填）" />
            <button type="button" class="secondary small" @click="removeVoidRow(i)">删行</button>
          </div>
          <button type="button" class="secondary small" @click="addVoidRow">+ 增加作废行</button>
        </fieldset>

        <label v-if="mode === 'correct'" class="correct-reason">
          修正原因（另存版本必填）
          <textarea v-model="correctReason" placeholder="说明为何修正已复核票号/金额，旧内容将保留" />
        </label>

        <!-- 实时校验预览：保存后命中项仍保持待复核 -->
        <div v-if="previewIssues.length" class="preview">
          <p>当前填写将命中 {{ previewIssues.length }} 项校验，保存后保持“待复核”：</p>
          <ul>
            <li v-for="(item, i) in previewIssues" :key="`p-${item.code}-${i}`">
              <span class="code">{{ item.code }}</span>{{ item.message }}
              <span class="pv">段 {{ item.ticketSegment }} ｜ 原值 {{ item.oldValue }} ｜ 新值 {{ item.newValue }}</span>
            </li>
          </ul>
        </div>
        <p v-else-if="form.first && form.last" class="hint ok">当前填写未命中号段/作废校验。</p>

        <div class="form-actions">
          <button type="submit">
            {{ mode === "new" ? "保存登记（待复核）" : mode === "edit" ? "覆盖保存" : "另存修正版本" }}
          </button>
          <button v-if="!isNew" type="button" class="secondary" @click="resetForm">取消</button>
        </div>
      </form>

      <!-- 右：台账列表 -->
      <div class="inv-right">
        <div class="toolbar">
          <h3>票号台账（按时序）</h3>
          <select v-model="filter">
            <option>全部班次</option>
            <option v-for="s in SHIFTS" :key="s" :value="s">{{ s }}</option>
          </select>
        </div>

        <div v-if="filteredEntries.length === 0" class="empty">暂无匹配班次</div>

        <article v-for="entry in filteredEntries" :key="entry.id" class="record inv-card">
          <div class="record-head">
            <p class="record-title">{{ entry.date }} {{ entry.shift }}</p>
            <span class="status" :class="{ pending: entry.status === PENDING }">{{ entry.status }}</span>
          </div>

          <div class="details">
            <span>票号段：{{ entry.first }}{{ entry.first === entry.last ? "" : ` - ${entry.last}` }}</span>
            <span>当前版本：v{{ entry.currentVersion }}</span>
            <span>开票金额：{{ amountText(entry.amount) }}</span>
            <span>作废：{{ entry.voids.filter((v) => v.ticket).length }} 张</span>
          </div>

          <ul v-if="entry.voids.filter((v) => v.ticket || v.reason).length" class="void-list">
            <li v-for="(v, i) in entry.voids.filter((x) => x.ticket || x.reason)" :key="i">
              <b>{{ v.ticket || "（票号空）" }}</b>
              <span :class="{ missing: !v.reason.trim() }">{{ v.reason.trim() || "作废原因未填" }}</span>
            </li>
          </ul>

          <div v-if="issuesOf(entry).length" class="issue-box">
            <p v-for="(item, i) in issuesOf(entry)" :key="`${item.code}-${i}`" class="issue">
              <span class="code">{{ item.code }}</span>{{ item.message }}
              <span class="issue-detail">段 {{ item.ticketSegment }} ｜ 原值 {{ item.oldValue }} ｜ 新值 {{ item.newValue }}</span>
            </p>
          </div>

          <div class="actions">
            <button v-if="entry.status === PENDING" type="button" @click="confirmEntry(entry)">确认复核</button>
            <button v-if="entry.status === PENDING" type="button" class="secondary" @click="startEdit(entry)">修改</button>
            <button v-if="entry.status === CONFIRMED" type="button" class="secondary" @click="startCorrect(entry)">发起修正</button>
            <button type="button" class="secondary" @click="toggleHistory(entry.id)">
              {{ expanded.has(entry.id) ? "收起版本" : `版本历史（${entry.versionHistory.length}）` }}
            </button>
            <button type="button" class="danger" @click="removeEntry(entry)">删除</button>
          </div>

          <div v-if="expanded.has(entry.id)" class="versions">
            <p class="versions-tip" v-if="entry.versionHistory.length > 1">
              修正另存为新版本，旧内容原样保留；当前生效 v{{ entry.currentVersion }}。
            </p>
            <div v-for="ver in [...entry.versionHistory].reverse()" :key="ver.version"
                 class="version" :class="{ active: ver.version === entry.currentVersion }">
              <div class="version-head">
                <b>v{{ ver.version }}</b>
                <span>{{ formatTime(ver.createdAt) }}</span>
                <em v-if="ver.version === entry.currentVersion">当前生效</em>
              </div>
              <p v-if="ver.reason" class="version-reason">修正原因：{{ ver.reason }}</p>
              <div class="details">
                <span>票号段：{{ ver.first }}{{ ver.first === ver.last ? "" : ` - ${ver.last}` }}</span>
                <span>开票金额：{{ amountText(ver.amount) }}</span>
              </div>
              <ul v-if="ver.voids.filter((v: VoidRow) => v.ticket).length" class="void-list compact">
                <li v-for="(v, i) in ver.voids.filter((v: VoidRow) => v.ticket)" :key="i">
                  <b>{{ v.ticket }}</b><span :class="{ missing: !v.reason.trim() }">{{ v.reason.trim() || "原因未填" }}</span>
                </li>
              </ul>
            </div>
          </div>
        </article>

        <!-- 占用视图：刷新/切班次后仍与版本一致，因为全部由持久化数据派生 -->
        <div class="panel occupancy">
          <h3>票号占用台账</h3>
          <p class="hint">{{ wrapText }}；占用仅按各班当前生效版本计算，历史版本不重复占号。</p>
          <div v-if="ledgerStore.occupied.length === 0" class="empty">尚无有效号段</div>
          <table v-else class="occ-table">
            <thead><tr><th>班次</th><th>占用票号段</th></tr></thead>
            <tbody>
              <tr v-for="seg in ledgerStore.occupied" :key="seg.id">
                <td>{{ seg.label }}</td>
                <td class="mono">{{ seg.segment }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.ledger {
  margin-top: 26px;
  background: #fff;
  border: 1px solid #dfe7f1;
  border-radius: 8px;
  padding: 20px;
}

.ledger-head h2 {
  margin: 6px 0;
  font-size: 22px;
}

.inv-metrics {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 10px;
  margin: 16px 0;
}

.inv-metric {
  background: #f6f9fc;
  border: 1px solid #e2e9f2;
  border-radius: 8px;
  padding: 12px;
}

.inv-metric span {
  display: block;
  color: #69758c;
  font-size: 12px;
}

.inv-metric strong {
  display: block;
  margin-top: 6px;
  font-size: 18px;
}

.inv-workspace {
  display: grid;
  grid-template-columns: minmax(300px, 380px) 1fr;
  gap: 18px;
  align-items: start;
}

.inv-form h3,
.toolbar h3,
.occupancy h3 {
  margin: 0 0 12px;
  font-size: 18px;
}

.field {
  display: grid;
  gap: 6px;
  margin-bottom: 12px;
}

.field.two {
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.field.two > div {
  display: grid;
  gap: 6px;
}

.form-context {
  margin: 0 0 12px;
  padding: 8px 10px;
  border-radius: 8px;
  background: #eef5fb;
  color: #34506b;
  font-size: 13px;
}

.form-context.warn {
  background: #fdf3e7;
  color: #8a5317;
}

.hint {
  margin: -4px 0 12px;
  color: #5b667a;
  font-size: 13px;
}

.hint.ok { color: #14724f; }

button.link {
  border: 0;
  background: none;
  color: #176b87;
  padding: 0 2px;
  text-decoration: underline;
}

.voids {
  border: 1px dashed #cfd8e5;
  border-radius: 8px;
  padding: 10px;
  margin: 0 0 12px;
}

.voids legend {
  padding: 0 6px;
  color: #445069;
  font-size: 13px;
}

.void-row {
  display: grid;
  grid-template-columns: 130px 1fr auto;
  gap: 8px;
  margin-bottom: 8px;
}

button.small { padding: 6px 10px; font-size: 13px; }

.correct-reason {
  display: grid;
  gap: 6px;
  margin-bottom: 12px;
}

.preview {
  border: 1px solid #f0d9d2;
  background: #fdf3f0;
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 12px;
}

.preview p { margin: 0 0 6px; color: #8a3a26; font-size: 13px; font-weight: 700; }
.preview ul { margin: 0; padding-left: 18px; display: grid; gap: 6px; }
.preview li { font-size: 13px; color: #536078; }

.pv { display: block; color: #8a94a8; font-size: 12px; margin-top: 2px; }

.code {
  display: inline-block;
  margin-right: 6px;
  padding: 1px 7px;
  border-radius: 999px;
  background: #172033;
  color: #fff;
  font-size: 11px;
  font-family: ui-monospace, Menlo, Consolas, monospace;
}

.form-actions {
  display: flex;
  gap: 8px;
}

.inv-right {
  display: grid;
  gap: 14px;
}

.inv-card .status.pending {
  background: #fdf3e7;
  color: #8a5317;
}

.void-list {
  margin: 0 0 12px;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 6px;
}

.void-list li {
  display: flex;
  gap: 10px;
  align-items: baseline;
  font-size: 13px;
  color: #536078;
  background: #f6f9fc;
  border-radius: 6px;
  padding: 6px 10px;
}

.void-list .missing { color: #c84b31; font-weight: 700; }
.void-list.compact { margin: 8px 0 0; }

.issue-box {
  border: 1px solid #f0d9d2;
  background: #fdf3f0;
  border-radius: 8px;
  padding: 8px 12px;
  margin-bottom: 12px;
  display: grid;
  gap: 6px;
}

.issue {
  margin: 0;
  font-size: 13px;
  color: #7a3421;
}

.issue-detail {
  display: block;
  color: #a97666;
  font-size: 12px;
  margin-top: 2px;
}

.versions {
  margin-top: 12px;
  border-top: 1px dashed #cfd8e5;
  padding-top: 12px;
  display: grid;
  gap: 10px;
}

.versions-tip { margin: 0; color: #69758c; font-size: 12px; }

.version {
  border: 1px solid #e2e9f2;
  border-radius: 8px;
  padding: 10px 12px;
  background: #fbfcfe;
}

.version.active { border-color: #176b87; }

.version-head {
  display: flex;
  gap: 10px;
  align-items: baseline;
  font-size: 13px;
  color: #536078;
}

.version-head em {
  font-style: normal;
  color: #14724f;
  font-size: 12px;
}

.version-reason {
  margin: 6px 0;
  font-size: 13px;
  color: #8a5317;
  background: #fdf3e7;
  border-radius: 6px;
  padding: 6px 10px;
}

.blocked {
  border: 1px solid #e3b3a5;
  background: #fbeae5;
  border-radius: 8px;
  padding: 14px 16px;
  margin-bottom: 16px;
}

.blocked-head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: center;
}

.blocked-reason { margin: 8px 0; color: #7a3421; font-weight: 700; font-size: 14px; }

.blocked-summary {
  display: flex;
  gap: 18px;
  flex-wrap: wrap;
  font-size: 13px;
  color: #536078;
  margin-bottom: 10px;
}

.blocked-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
  background: #fff;
  border-radius: 8px;
  overflow: hidden;
}

.blocked-table th,
.blocked-table td {
  border: 1px solid #ecd9d2;
  padding: 8px 10px;
  text-align: left;
  vertical-align: top;
}

.blocked-table th { background: #f6ded7; color: #7a3421; }

.result-ok {
  margin: 0 0 12px;
  color: #14724f;
  font-weight: 700;
}

.occupancy { padding: 16px; }

.occ-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;
}

.occ-table th,
.occ-table td {
  border-bottom: 1px solid #e7edf4;
  padding: 8px 10px;
  text-align: left;
}

.mono { font-family: ui-monospace, Menlo, Consolas, monospace; }

@media (max-width: 860px) {
  .inv-workspace { grid-template-columns: 1fr; }
  .inv-metrics { grid-template-columns: repeat(2, 1fr); }
}
</style>
