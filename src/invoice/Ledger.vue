<script setup lang="ts">
// 发票票号台账界面：只负责展示与交互；规则 / 存储 / 状态均来自 src/invoice 下拆分模块。
import { computed, onMounted, onUnmounted, reactive, ref } from "vue";
import { useLedger } from "./state";
import {
  NO_MAX,
  NO_MIN,
  SHIFTS,
  formatRange,
  occupancyView,
  pad,
  type DraftInput,
  type Issue,
  type VoidInput
} from "./rules";
import type { LedgerEntry } from "./model";

const ledger = useLedger();

interface FormState {
  date: string;
  shift: string;
  startText: string;
  endText: string;
  amountText: string;
  voids: VoidInput[];
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function blankForm(): FormState {
  return {
    date: today(),
    shift: SHIFTS[0],
    startText: "",
    endText: "",
    amountText: "",
    voids: []
  };
}

const form = reactive<FormState>(blankForm());
const editId = ref<string | null>(null);
const reviseReason = ref("");
const openHistory = ref<Set<string>>(new Set());
const lastResult = ref<{ ok: boolean; text: string } | null>(null);
const lastBlockedId = ref<string | null>(null);

function toInput(): DraftInput {
  return {
    date: form.date,
    shift: form.shift,
    startText: form.startText,
    endText: form.endText,
    amountText: form.amountText,
    voids: form.voids
  };
}

const chainSegments = computed(() => ledger.segments());
const occupancy = computed(() => occupancyView(chainSegments.value));
const formIssues = computed<Issue[]>(() => ledger.issuesFor(toInput(), editId ?? undefined));
const hasFormBlock = computed(() => formIssues.value.some((issue) => issue.level === "block"));
const hasFormReview = computed(() => formIssues.value.length > 0);

const suggestion = computed(() => {
  // 占用一览已按时间排序，直接基于全量段推算当前编辑班次的上一班。
  const occasion = `${form.date}#${String(SHIFTS.indexOf(form.shift as (typeof SHIFTS)[number]) + 1).padStart(2, "0")}`;
  const segmentsBefore = chainSegments.value
    .filter((segment) => occasionKeyOf(segment.date, segment.shift) < occasion);
  const prev = segmentsBefore.length > 0 ? segmentsBefore[segmentsBefore.length - 1] : null;
  if (!prev) {
    return { text: `${pad(NO_MIN)}（期初起号）`, startNo: NO_MIN, wraps: false, blocked: false };
  }
  if (prev.endNo >= NO_MAX) {
    if (prev.date === form.date) {
      return { text: `前班已到 ${pad(NO_MAX)}：须跨日回绕，同日不能回绕；跨日首号填 ${pad(NO_MIN)}`, startNo: NO_MIN, wraps: true, blocked: true };
    }
    return { text: `跨日回绕：首号填 ${pad(NO_MIN)}（全周期限回绕一次）`, startNo: NO_MIN, wraps: true, blocked: false };
  }
  const next = prev.endNo + 1;
  return { text: `应紧接 ${prev.date} ${prev.shift} 尾号 ${pad(prev.endNo)}，首号 ${pad(next)}`, startNo: next, wraps: false, blocked: false };
});

function occasionKeyOf(date: string, shift: string): string {
  return `${date}#${String(SHIFTS.indexOf(shift as (typeof SHIFTS)[number]) + 1).padStart(2, "0")}`;
}

const metrics = computed(() => {
  const entries = ledger.entries.value;
  const confirmed = entries.filter((entry) => entry.status === ledger.STATUS_CONFIRMED).length;
  const amount = entries.reduce((sum, entry) => sum + entry.current.amount, 0);
  const voidCount = entries.reduce((sum, entry) => sum + entry.current.voids.length, 0);
  const versions = entries.reduce((sum, entry) => sum + 1 + entry.history.length, 0);
  return { total: entries.length, confirmed, amount, voidCount, versions };
});

function addVoidRow() {
  form.voids.push({ noText: "", reason: "" });
}

function removeVoidRow(index: number) {
  form.voids.splice(index, 1);
}

function flashResult(ok: boolean, text: string) {
  lastResult.value = { ok, text };
}

function save() {
  if (editId.value) {
    const result = ledger.revise(editId.value, toInput(), reviseReason.value);
    if (!result.ok && result.blocked) {
      lastBlockedId.value = result.blocked.id;
      flashResult(false, "修正被挡下：命中硬校验，旧版本原样保留");
      return;
    }
    flashResult(true, "修正已另存为新版本，旧内容已保留在版本历史；班次回到待复核");
    exitEdit();
    return;
  }

  const result = ledger.addEntry(toInput());
  if (!result.ok || result.blocked) {
    if (result.blocked) lastBlockedId.value = result.blocked.id;
    flashResult(false, "登记被挡下：票号段存在硬校验问题，未写入台账");
    return;
  }
  const reviewNote = result.issues.length > 0 ? "；存在待复核项，班次保持待复核" : "";
  flashResult(true, `已登记${reviewNote}`);
  Object.assign(form, blankForm());
  form.voids = [];
}

function confirmEntryAction(entry: LedgerEntry) {
  const input: DraftInput = {
    date: entry.date,
    shift: entry.shift,
    startText: String(entry.current.startNo),
    endText: String(entry.current.endNo),
    amountText: String(entry.current.amount),
    voids: entry.current.voids.map((item) => ({ noText: String(item.no), reason: item.reason }))
  };
  const result = ledger.confirm(entry.id, input);
  if (!result.ok && result.blocked) {
    lastBlockedId.value = result.blocked.id;
    flashResult(false, "确认被挡下：仍有校验未通过（详见被挡操作）");
    return;
  }
  flashResult(true, "票号与金额已固定；日后修正将另存原因版本");
}

function startEdit(entry: LedgerEntry) {
  editId.value = entry.id;
  form.date = entry.date;
  form.shift = entry.shift;
  form.startText = String(entry.current.startNo).padStart(8, "0");
  form.endText = String(entry.current.endNo).padStart(8, "0");
  form.amountText = String(entry.current.amount);
  form.voids = entry.current.voids.map((item) => ({ noText: pad(item.no), reason: item.reason }));
  reviseReason.value = "";
  lastResult.value = null;
}

function exitEdit() {
  editId.value = null;
  reviseReason.value = "";
  Object.assign(form, blankForm());
  form.voids = [];
}

function applySuggestedStart() {
  form.startText = pad(suggestion.value.startNo);
}

function toggleHistory(id: string) {
  const next = new Set(openHistory.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  openHistory.value = next;
}

function entryIssues(entry: LedgerEntry): Issue[] {
  return ledger.issuesFor(
    {
      date: entry.date,
      shift: entry.shift,
      startText: String(entry.current.startNo),
      endText: String(entry.current.endNo),
      amountText: String(entry.current.amount),
      voids: entry.current.voids.map((item) => ({ noText: String(item.no), reason: item.reason }))
    },
    entry.id
  );
}

function issueClass(level: Issue["level"]) {
  return level === "block" ? "issue-block" : "issue-review";
}

function timeText(iso: string): string {
  return new Date(iso).toLocaleString("zh-CN", { hour12: false });
}

function onStorage(event: StorageEvent) {
  if (event.key === "dfwlfront-7-invoice-ledger") {
    ledger.reloadFromStorage();
    flashResult(true, "检测到其他标签页写入，已按存储重新对齐占用与版本");
  }
}

onMounted(() => window.addEventListener("storage", onStorage));
onUnmounted(() => window.removeEventListener("storage", onStorage));
</script>

<template>
  <div class="ledger">
    <div class="ledger-toolbar">
      <div>
        <h2>发票票号台账</h2>
        <p class="ledger-hint">
          每班登记票号首尾、开票金额与作废明细；后班首号紧接前班尾号，跨日最多回绕一次。
        </p>
      </div>
      <div class="toolbar-actions">
        <span class="loaded-at">存储载入：{{ timeText(ledger.loadedAt.value) }}</span>
        <button type="button" class="secondary" @click="ledger.reloadFromStorage(); flashResult(true, '已从 localStorage 重新读取，占用与版本历史已重算')">刷新重算</button>
        <button type="button" class="danger" @click="ledger.resetAll(); exitEdit()">恢复演示数据</button>
      </div>
    </div>

    <section class="ledger-metrics">
      <article class="metric"><span>班次登记</span><strong>{{ metrics.total }}</strong></article>
      <article class="metric"><span>已确认固定</span><strong>{{ metrics.confirmed }}</strong></article>
      <article class="metric"><span>开票金额合计</span><strong>¥{{ metrics.amount.toLocaleString("zh-CN", { maximumFractionDigits: 2 }) }}</strong></article>
      <article class="metric"><span>作废发票</span><strong>{{ metrics.voidCount }}</strong></article>
      <article class="metric"><span>版本总数（含留痕）</span><strong>{{ metrics.versions }}</strong></article>
    </section>

    <p v-if="lastResult" :class="['save-flash', lastResult.ok ? 'flash-ok' : 'flash-bad']">{{ lastResult.text }}</p>

    <div class="ledger-grid">
      <!-- 左：登记 / 修正表单 -->
      <form class="panel ledger-form" @submit.prevent="save">
        <h3>{{ editId ? "修正登记（另存原因版本）" : "当班票号登记" }}</h3>

        <div class="form-row">
          <label>日期
            <input v-model="form.date" type="date" required />
          </label>
          <label>班次
            <select v-model="form.shift">
              <option v-for="name in SHIFTS" :key="name" :value="name">{{ name }}</option>
            </select>
          </label>
        </div>

        <div class="suggestion" :class="{ blocked: suggestion.blocked }">
          <span>衔接提示：{{ suggestion.text }}</span>
          <button type="button" class="mini" @click="applySuggestedStart">带入首号</button>
        </div>

        <div class="form-row">
          <label>首号
            <input v-model="form.startText" inputmode="numeric" placeholder="如 00000051" required />
          </label>
          <label>尾号
            <input v-model="form.endText" inputmode="numeric" placeholder="如 00000080" required />
          </label>
        </div>

        <label>开票金额（元）
          <input v-model="form.amountText" inputmode="decimal" placeholder="当班有效发票合计金额" required />
        </label>

        <fieldset class="voids">
          <legend>作废明细（作废必须填原因）</legend>
          <p v-if="form.voids.length === 0" class="void-empty">本班无作废</p>
          <div v-for="(row, index) in form.voids" :key="index" class="void-row">
            <input v-model="row.noText" inputmode="numeric" placeholder="作废票号" />
            <input v-model="row.reason" placeholder="作废原因（必填）" />
            <button type="button" class="secondary mini" @click="removeVoidRow(index)">移除</button>
          </div>
          <button type="button" class="secondary mini" @click="addVoidRow">+ 增加作废</button>
        </fieldset>

        <div v-if="formIssues.length" class="issue-list">
          <p v-for="(issue, index) in formIssues" :key="index" :class="['issue', issueClass(issue.level)]">
            <strong>{{ issue.level === "block" ? "硬校验·挡下" : "待复核" }}</strong>
            {{ issue.message }}
            <em v-if="issue.expected">应为：{{ issue.expected }}</em>
          </p>
        </div>
        <p v-else class="issue-ok">实时校验通过，无跳号 / 重号 / 作废缺因。</p>

        <template v-if="editId">
          <label>修正原因（必填，旧版本原样保留）
            <textarea v-model="reviseReason" placeholder="如：交接单抄错尾号，以票本实物为准" />
          </label>
          <div class="form-actions">
            <button type="submit" :disabled="hasFormBlock || !reviseReason.trim()">另存修正版本</button>
            <button type="button" class="secondary" @click="exitEdit">取消修正</button>
          </div>
        </template>
        <template v-else>
          <div class="form-actions">
            <button type="submit" :disabled="hasFormBlock">
              {{ hasFormBlock ? "存在硬校验，无法登记" : hasFormReview ? "登记并保持待复核" : "保存登记" }}
            </button>
          </div>
        </template>
      </form>

      <!-- 右：台账与占用 -->
      <div class="ledger-side">
        <section class="panel occupancy">
          <h3>占用一览（刷新 / 切班次后按存储重算，不错位）</h3>
          <div v-if="occupancy.length === 0" class="empty">尚无班次占用</div>
          <ol v-else class="chain">
            <li v-for="row in occupancy" :key="row.segment.entryId" :class="['chain-row', `chain-${row.level}`]">
              <div class="chain-main">
                <span class="chain-occasion">{{ row.segment.date }} {{ row.segment.shift }}</span>
                <span class="chain-range">{{ formatRange(row.segment.startNo, row.segment.endNo) }}</span>
                <span :class="['chain-badge', `badge-${row.level}`]">{{ row.label }}</span>
                <span class="chain-status">{{ row.segment.confirmed ? "已确认" : "待复核" }}</span>
              </div>
              <p class="chain-detail">{{ row.detail }}<template v-if="row.expected">（期望：{{ row.expected }}）</template></p>
            </li>
          </ol>
        </section>

        <section class="panel entries-panel">
          <h3>班次台账</h3>
          <div v-if="ledger.entries.value.length === 0" class="empty">暂无登记</div>
          <article
            v-for="entry in ledger.entries.value"
            :key="entry.id"
            :class="['entry-card', { editing: entry.id === editId }]"
          >
            <div class="entry-head">
              <strong>{{ entry.date }} {{ entry.shift }}</strong>
              <span :class="['status-pill', entry.status === ledger.STATUS_CONFIRMED ? 'pill-confirmed' : 'pill-draft']">
                {{ entry.status }}
              </span>
              <span class="version-tag">v{{ entry.current.version }}</span>
            </div>

            <div class="entry-values">
              <span>票号段：<b>{{ formatRange(entry.current.startNo, entry.current.endNo) }}</b></span>
              <span>开票金额：<b>¥{{ entry.current.amount.toLocaleString("zh-CN") }}</b></span>
            </div>

            <ul v-if="entry.current.voids.length" class="void-list">
              <li v-for="voidItem in entry.current.voids" :key="voidItem.no" :class="{ 'reason-empty': !voidItem.reason }">
                作废 {{ pad(voidItem.no) }}：{{ voidItem.reason || "（原因为空 → 待复核）" }}
              </li>
            </ul>
            <p v-else class="no-void">本班无作废</p>

            <ul v-if="entryIssues(entry).length" class="entry-issues">
              <li v-for="(issue, index) in entryIssues(entry)" :key="index" :class="issueClass(issue.level)">
                {{ issue.message }}
              </li>
            </ul>

            <div v-if="entry.history.length" class="history">
              <button type="button" class="secondary mini" @click="toggleHistory(entry.id)">
                {{ openHistory.has(entry.id) ? "收起" : "查看" }}版本历史（{{ entry.history.length }} 个旧版本）
              </button>
              <ol v-if="openHistory.has(entry.id)" class="version-list">
                <li v-for="version in [...entry.history].reverse()" :key="version.version">
                  <div>
                    <b>v{{ version.version }}</b>
                    <span class="version-meta">{{ formatRange(version.startNo, version.endNo) }} · ¥{{ version.amount }} · {{ timeText(version.createdAt) }}</span>
                  </div>
                  <p class="version-reason">原值留痕：{{ version.reason }}；作废 {{ version.voids.length }} 张</p>
                </li>
              </ol>
            </div>

            <div class="entry-actions">
              <button
                v-if="entry.status === ledger.STATUS_DRAFT"
                type="button"
                @click="confirmEntryAction(entry)"
              >确认固定</button>
              <button type="button" class="secondary" @click="startEdit(entry)">
                {{ entry.id === editId ? "正在修正…" : "修正（另存版本）" }}
              </button>
              <button
                v-if="entry.status === ledger.STATUS_DRAFT"
                type="button"
                class="danger"
                @click="ledger.remove(entry.id)"
              >删除</button>
            </div>
          </article>
        </section>

        <section class="panel blocked-panel">
          <div class="blocked-head">
            <h3>被挡操作（票号段 / 原值 / 新值 / 命中校验）</h3>
            <button v-if="ledger.blockedLog.value.length" type="button" class="secondary mini" @click="ledger.clearBlockedLog()">清空</button>
          </div>
          <div v-if="ledger.blockedLog.value.length === 0" class="empty">暂无被挡操作</div>
          <ol v-else class="blocked-list">
            <li
              v-for="item in ledger.blockedLog.value"
              :key="item.id"
              :class="['blocked-item', { highlight: item.id === lastBlockedId }]"
            >
              <div class="blocked-top">
                <b>{{ item.action }}</b>
                <span>{{ item.date }} {{ item.shift }}</span>
                <time>{{ timeText(item.time) }}</time>
              </div>
              <p class="blocked-range">票号段：{{ item.range }}</p>
              <p class="blocked-value"><label>原值</label>{{ item.oldValue }}</p>
              <p class="blocked-value"><label>新值</label>{{ item.newValue }}</p>
              <ul class="blocked-rules">
                <li v-for="(message, index) in item.messages" :key="index">{{ message }}</li>
              </ul>
            </li>
          </ol>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ledger { display: grid; gap: 16px; }
.ledger-toolbar { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; flex-wrap: wrap; }
.ledger-toolbar h2 { margin: 0 0 6px; }
.ledger-hint { margin: 0; color: #5b667a; font-size: 14px; line-height: 1.6; }
.toolbar-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.loaded-at { color: #69758c; font-size: 12px; }

.ledger-metrics { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 12px; }
.ledger-metrics .metric { background: #fff; border: 1px solid #dfe7f1; border-radius: 8px; padding: 14px; }
.ledger-metrics .metric span { display: block; color: #69758c; font-size: 12px; }
.ledger-metrics .metric strong { display: block; margin-top: 6px; font-size: 22px; }

.save-flash { margin: 0; padding: 10px 14px; border-radius: 8px; font-size: 14px; }
.flash-ok { background: #e8f6ee; color: #14724f; border: 1px solid #bfe3cf; }
.flash-bad { background: #fdecea; color: #b03a24; border: 1px solid #f3c4bc; }

.ledger-grid { display: grid; grid-template-columns: minmax(300px, 380px) 1fr; gap: 16px; align-items: start; }
.ledger-side { display: grid; gap: 16px; min-width: 0; }

.panel { background: #fff; border: 1px solid #dfe7f1; border-radius: 8px; padding: 16px; }
.panel h3 { margin: 0 0 12px; font-size: 17px; }

.ledger-form { display: grid; gap: 12px; position: sticky; top: 16px; }
.form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
label { display: grid; gap: 6px; color: #445069; font-size: 13px; }
input, select, textarea { width: 100%; border: 1px solid #cfd8e5; border-radius: 8px; padding: 9px 11px; background: #fbfcfe; color: #172033; }
textarea { min-height: 64px; resize: vertical; }
.mini { padding: 5px 10px; font-size: 12px; border-radius: 6px; }

.suggestion { display: flex; justify-content: space-between; gap: 8px; align-items: center; background: #eef5fb; border: 1px solid #d4e4f2; border-radius: 8px; padding: 8px 10px; font-size: 12px; color: #31506b; }
.suggestion.blocked { background: #fdf1ec; border-color: #f0cdbf; color: #a04524; }

.voids { border: 1px dashed #cfd8e5; border-radius: 8px; padding: 10px; margin: 0; }
.voids legend { padding: 0 6px; color: #445069; font-size: 12px; }
.void-empty { margin: 0 0 8px; color: #8a94a6; font-size: 12px; }
.void-row { display: grid; grid-template-columns: 130px 1fr auto; gap: 8px; margin-bottom: 8px; }

.issue-list { display: grid; gap: 6px; }
.issue { margin: 0; border-radius: 6px; padding: 7px 9px; font-size: 12px; line-height: 1.5; display: grid; gap: 2px; }
.issue strong { font-size: 11px; }
.issue em { font-style: normal; color: inherit; opacity: .8; }
.issue-block { background: #fdecea; border: 1px solid #f3c4bc; color: #b03a24; }
.issue-review { background: #fff7e6; border: 1px solid #f5d99b; color: #8a6116; }
.issue-ok { margin: 0; font-size: 12px; color: #14724f; background: #e8f6ee; border-radius: 6px; padding: 8px 10px; }

.form-actions { display: flex; gap: 8px; flex-wrap: wrap; }

.chain { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.chain-row { border: 1px solid #dfe7f1; border-left-width: 4px; border-radius: 6px; padding: 8px 10px; background: #fbfcfe; }
.chain-ok { border-left-color: #2f9e6e; }
.chain-review { border-left-color: #d99a26; background: #fffdf5; }
.chain-block { border-left-color: #c84b31; background: #fdf6f4; }
.chain-main { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; font-size: 13px; }
.chain-occasion { font-weight: 700; }
.chain-range { font-family: ui-monospace, "SFMono-Regular", Consolas, monospace; color: #31506b; }
.chain-badge { border-radius: 999px; padding: 2px 8px; font-size: 11px; }
.badge-ok { background: #e2f3ea; color: #14724f; }
.badge-review { background: #fbecc8; color: #8a6116; }
.badge-block { background: #f8d7d0; color: #a03a22; }
.chain-status { margin-left: auto; color: #69758c; font-size: 12px; }
.chain-detail { margin: 4px 0 0; font-size: 12px; color: #5b667a; }

.entry-card { border: 1px solid #dfe7f1; border-radius: 8px; padding: 12px 14px; background: #fbfcfe; margin-bottom: 10px; }
.entry-card.editing { border-color: #176b87; box-shadow: 0 0 0 2px rgba(23, 107, 135, .15); }
.entry-head { display: flex; gap: 10px; align-items: center; }
.status-pill { border-radius: 999px; padding: 3px 10px; font-size: 12px; }
.pill-confirmed { background: #e2f3ea; color: #14724f; }
.pill-draft { background: #fff0d6; color: #8a6116; }
.version-tag { margin-left: auto; font-size: 11px; color: #69758c; background: #eef2f7; border-radius: 6px; padding: 2px 7px; }
.entry-values { display: flex; gap: 18px; flex-wrap: wrap; margin: 10px 0 6px; font-size: 14px; color: #445069; }
.void-list { margin: 6px 0; padding-left: 18px; font-size: 13px; color: #536078; }
.void-list .reason-empty { color: #a03a22; font-weight: 700; }
.no-void { margin: 6px 0; font-size: 12px; color: #8a94a6; }
.entry-issues { margin: 6px 0; padding-left: 18px; font-size: 12px; }
.entry-issues .issue-block { color: #b03a24; list-style: square; }
.entry-issues .issue-review { color: #8a6116; list-style: square; }
.history { margin: 8px 0; }
.version-list { margin: 8px 0 0; padding-left: 18px; display: grid; gap: 6px; font-size: 12px; color: #536078; }
.version-meta { margin-left: 8px; font-family: ui-monospace, Consolas, monospace; }
.version-reason { margin: 2px 0 0; }
.entry-actions { display: flex; gap: 8px; flex-wrap: wrap; }

.blocked-head { display: flex; justify-content: space-between; align-items: center; }
.blocked-head h3 { margin: 0; }
.blocked-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.blocked-item { border: 1px solid #f0cdbf; border-left: 4px solid #c84b31; border-radius: 6px; padding: 10px; background: #fdf6f4; font-size: 13px; }
.blocked-item.highlight { box-shadow: 0 0 0 2px rgba(200, 75, 49, .25); }
.blocked-top { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; color: #5b667a; font-size: 12px; }
.blocked-top time { margin-left: auto; }
.blocked-range { margin: 6px 0; font-family: ui-monospace, Consolas, monospace; }
.blocked-value { margin: 3px 0; display: flex; gap: 8px; }
.blocked-value label { all: unset; min-width: 32px; font-weight: 700; color: #a04524; font-size: 12px; }
.blocked-rules { margin: 6px 0 0; padding-left: 18px; color: #a03a22; }
.empty { color: #69758c; font-size: 13px; padding: 14px; text-align: center; }

@media (max-width: 980px) {
  .ledger-grid { grid-template-columns: 1fr; }
  .ledger-form { position: static; }
  .ledger-metrics { grid-template-columns: repeat(2, 1fr); }
}
</style>
