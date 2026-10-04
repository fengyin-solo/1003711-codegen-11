<template>
  <section class="page" data-module="waterquality">
    <header class="page-head">
      <div>
        <h2>水质检测管理</h2>
        <p class="page-desc">维护水质检测报告，围绕报告编号、采样站点、采样时间、检测项目做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记水质检测报告</button>
        <button class="btn" type="button" @click="exportRows">导出水质检测清单</button>
      </div>
    </header>

    <!-- 地下水对账确认后联动：采样站点井点核查（多终端并发只生效一次） -->
    <section class="reconcile-panel">
      <h3>采样站点井点核查</h3>
      <p class="panel-hint">
        地下水观测对账批次确认后，可对全部水质报告核查采样站点是否在井点台账内；
        同一对账批次只核查一次，多个终端同时发起仅第一个终端生效，其余终端复用同一核查结果。
      </p>
      <div v-if="checkBanner" :class="['check-banner', checkBanner.kind]">{{ checkBanner.text }}</div>
      <div class="panel-toolbar">
        <button
          class="btn primary"
          type="button"
          :disabled="!pending.canCheck || checking"
          :title="pending.canCheck ? '' : pending.reason"
          @click="startCheck"
        >
          {{ checking ? '核查中…' : pending.canCheck ? `按批次 ${pending.batchId} 发起核查` : '暂无可核查批次' }}
        </button>
        <span v-if="!pending.canCheck" class="note-text">{{ pending.reason }}</span>
      </div>
      <div v-if="lastSummary" class="mini-grid">
        <div class="mini-card"><strong>{{ lastSummary.total }}</strong>报告总数</div>
        <div class="mini-card"><strong>{{ lastSummary.matched }}</strong>井点一致</div>
        <div class="mini-card"><strong class="error-text">{{ lastSummary.unmatched }}</strong>站点不符</div>
      </div>
      <p v-if="lastSummary" class="panel-hint">
        核查终端：{{ lastSummary.terminal.slice(0, 8) }} · 操作人：{{ lastSummary.checkedBy }}
        · {{ lastSummary.checkedAt.slice(0, 19).replace('T', ' ') }}
        <template v-if="lastSummary.unmatchedSites.length">
          <br />不符站点：{{ lastSummary.unmatchedSites.join('、') }}
        </template>
      </p>
    </section>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无水质检测数据，可先登记水质检测报告</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条水质检测记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import {
  latestCheckEntry,
  pendingCheck,
  readCheckSummary,
  runWaterQualityCheck,
  subscribeStore,
  type CheckSummary,
  type PendingCheck,
} from '@/api/waterquality-check'
import { useSessionStore } from '@/stores/session'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('waterquality')
const columns = ["报告编号", "采样站点", "采样时间", "检测项目", "检测值", "标准上限", "检测人", "报告状态", "核查结果"]
const actions = ["开始检测", "出具报告", "发起复核"]
const statuses = ["已采样", "检测中", "已出报告", "超标", "已复核"]
const stats = [{"label": "本月检测次数", "value": 0}, {"label": "超标报告数", "value": 0}, {"label": "检测中样本", "value": 0}]
const session = useSessionStore()

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const pending = ref<PendingCheck>({ canCheck: false, batchId: null, reason: '' })
const checking = ref(false)
const checkBanner = ref<{ kind: 'ok' | 'info'; text: string } | null>(null)
const lastSummary = ref<CheckSummary | null>(null)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '水质检测报告登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '水质检测列表读取失败'
  }
}

function refreshCheckState() {
  pending.value = pendingCheck()
  const latest = latestCheckEntry()
  if (latest) {
    lastSummary.value = readCheckSummary(latest.batchId)
    if (lastSummary.value && !checkBanner.value) {
      checkBanner.value = { kind: 'ok', text: `批次 ${latest.batchId} 的井点核查已完成（可能由其它终端执行）` }
    }
  }
  reload()
}

async function startCheck() {
  if (!pending.value.canCheck) {
    checkBanner.value = { kind: 'info', text: pending.value.reason }
    return
  }
  checking.value = true
  errorMessage.value = ''
  try {
    const outcome = await runWaterQualityCheck(session.operator)
    if (outcome.applied && outcome.summary) {
      lastSummary.value = outcome.summary
      checkBanner.value = { kind: 'ok', text: `批次 ${outcome.summary.batchId} 核查完成：本终端生效` }
    } else {
      checkBanner.value = {
        kind: 'info',
        text: `批次核查已由终端 ${outcome.entry.terminal.slice(0, 8)} 抢先完成，本终端未重复生效，结果已同步`,
      }
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '核查发起失败'
  } finally {
    checking.value = false
    refreshCheckState()
  }
}

let unsubscribe: (() => void) | null = null
onMounted(() => {
  refreshCheckState()
  unsubscribe = subscribeStore((key) => {
    if (key.includes('reconcile') || key.includes('once-ledger') || key.includes('entries')) {
      refreshCheckState()
    }
  })
})
onBeforeUnmount(() => {
  unsubscribe?.()
})
</script>
