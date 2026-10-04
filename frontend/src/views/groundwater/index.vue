<template>
  <section class="page" data-module="groundwater">
    <header class="page-head">
      <div>
        <h2>地下水观测管理</h2>
        <p class="page-desc">维护地下水观测记录，围绕记录编号、井点编号、观测日期、埋深值做登记、筛选与状态流转；支持井点编号资料对账包导入。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记地下水观测记录</button>
        <button class="btn" type="button" @click="exportRows">导出地下水观测清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <!-- 井点编号资料对账包 -->
    <section class="reconcile-panel">
      <h3>井点编号资料对账包</h3>
      <p class="panel-hint">
        导入埋深值、水位标高（表头兼容「井点编号/观测日期/埋深值/水位标高」等写法，日期兼容
        2026.9.1、20260902、9月5日、Excel 序列值）。与现场记录冲突时以现场为准，缺测字段按地面高程反算补全；
        同一文件重复导入只形成一个批次，失败/缺失井点可在补录井点后从断点继续。
      </p>

      <div class="panel-toolbar">
        <input ref="fileInput" class="file-input" type="file" accept=".csv,.txt,.tsv" @change="onFilePicked" />
        <button class="btn primary" type="button" :disabled="busy" @click="triggerImport">
          {{ busy ? '处理中…' : '导入对账文件' }}
        </button>
        <button class="btn" type="button" @click="exportTemplate">下载导入模板</button>
        <button class="btn" type="button" :disabled="!activeMissingCount" @click="exportMissing">
          导出缺失井点清单{{ activeMissingCount ? `（${activeMissingCount}）` : '' }}
        </button>
        <button class="btn" type="button" :disabled="!activeMissingCount" @click="registerMissing">
          补录缺失井点到台账{{ activeMissingCount ? `（${activeMissingCount}）` : '' }}
        </button>
      </div>

      <div v-if="activeBatch" class="mini-grid">
        <div class="mini-card"><strong>{{ activeBatch.inserted }}</strong>新增导入</div>
        <div class="mini-card"><strong>{{ activeBatch.updated }}</strong>更新/补全</div>
        <div class="mini-card"><strong>{{ activeBatch.skipped }}</strong>以现场为准跳过</div>
        <div class="mini-card"><strong class="error-text">{{ activeBatch.failed }}</strong>失败</div>
        <div class="mini-card"><strong class="error-text">{{ activeBatch.missing }}</strong>缺失井点</div>
      </div>

      <div v-if="activeBatch" class="batch-item" style="margin:8px 0">
        <span class="batch-id">{{ activeBatch.id }}</span>
        <span class="note-text">{{ activeBatch.fileName }} · {{ activeBatch.createdAt.slice(0, 19).replace('T', ' ') }}</span>
        <span v-if="activeBatch.state === 'confirmed'" class="badge ok">已确认</span>
        <span v-else class="badge warn">待确认</span>
        <button
          v-if="activeBatch.state === 'imported'"
          class="btn"
          type="button"
          :disabled="busy || (activeBatch.failed + activeBatch.missing) === 0"
          @click="resumeActive"
        >从断点继续</button>
        <button
          v-if="activeBatch.state === 'imported'"
          class="btn primary"
          type="button"
          :disabled="busy"
          @click="confirmActive"
        >确认对账批次</button>
        <span v-if="activeBatch.state === 'confirmed'" class="note-text">
          确认人：{{ activeBatch.confirmedBy }} · {{ (activeBatch.confirmedAt ?? '').slice(0, 19).replace('T', ' ') }}
        </span>
      </div>

      <details v-if="activeBatch" open>
        <summary class="note-text">查看本批次逐行结果（{{ activeBatch.rows.length }} 行）</summary>
        <table class="mini-table">
          <thead>
            <tr><th>行</th><th>井点编号</th><th>观测日期(原文)</th><th>标准化日期</th><th>埋深</th><th>水位标高</th><th>结果</th><th>说明</th></tr>
          </thead>
          <tbody>
            <tr v-for="row in activeBatch.rows" :key="row.line">
              <td>{{ row.line }}</td>
              <td>{{ row.wellCode || '—' }}</td>
              <td>{{ row.raw.dateRaw }}</td>
              <td>{{ row.date ?? '—' }}</td>
              <td>{{ row.depth ?? '—' }}</td>
              <td>{{ row.elevation ?? '—' }}</td>
              <td><span :class="['badge', rowBadge(row.status)]">{{ rowStatusLabel(row.status) }}</span></td>
              <td class="note-text">{{ row.note || row.changes.join('；') }}</td>
            </tr>
          </tbody>
        </table>
      </details>

      <h4 style="margin:14px 0 4px">井点台账（{{ wells.length }}）</h4>
      <table class="mini-table">
        <thead>
          <tr><th>井点编号</th><th>井点名称</th><th>位置</th><th>地面高程(m)</th><th>来源</th><th>状态</th></tr>
        </thead>
        <tbody>
          <tr v-for="well in wells" :key="well.code">
            <td>{{ well.code }}</td>
            <td>{{ well.name }}</td>
            <td>{{ well.location || '—' }}</td>
            <td>{{ well.groundElevation ?? '待补' }}</td>
            <td>{{ well.source }}</td>
            <td><span :class="['badge', well.active ? 'ok' : 'muted']">{{ well.active ? '在用' : '停用' }}</span></td>
          </tr>
        </tbody>
      </table>

      <h4 style="margin:14px 0 4px">历史批次</h4>
      <div class="batch-list">
        <div v-for="batch in batches" :key="batch.id" class="batch-item">
          <button class="link" type="button" @click="selectBatch(batch.id)">{{ batch.id }}</button>
          <span class="note-text">{{ batch.fileName }}</span>
          <span :class="['badge', batch.state === 'confirmed' ? 'ok' : 'warn']">
            {{ batch.state === 'confirmed' ? '已确认' : '待确认' }}
          </span>
          <span class="note-text">
            新增 {{ batch.inserted }} / 补全 {{ batch.updated }} / 跳过 {{ batch.skipped }} / 失败 {{ batch.failed }} / 缺失 {{ batch.missing }}
          </span>
          <span class="note-text">{{ batch.createdAt.slice(0, 10) }}</span>
        </div>
        <p v-if="!batches.length" class="note-text">还没有导入过对账文件。</p>
      </div>
    </section>

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
          <td :colspan="columns.length + 2" class="empty-state">暂无地下水观测数据，可先登记或通过对账包导入</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条地下水观测记录</span>
      <span v-if="message" :class="messageKind === 'error' ? 'error-text' : 'note-text'">{{ message }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import { downloadEntries, downloadText, listEntries, moduleMeta, runAction as applyAction } from '@/api/local-service'
import {
  IMPORT_ROW_STATUS_LABEL,
  missingWellsCsv,
  missingWellsOf,
  type ImportBatch,
  type ImportRowStatus,
} from '@/data/reconcile'
import {
  addWells,
  batchMissingWells,
  confirmBatchOnce,
  getBatch,
  importReconcileFile,
  listBatches,
  listWells,
  resumeBatch,
} from '@/data/reconcile-store'
import { useSessionStore } from '@/stores/session'
import { subscribeStore } from '@/data/browser-store'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('groundwater')
const columns = ["记录编号", "井点编号", "观测日期", "埋深值", "水位标高", "水温", "观测人", "记录状态"]
const actions = ["提交审核", "确认通过", "标记异常"]
const statuses = ["已采集", "待审核", "已通过", "异常值"]
const session = useSessionStore()

const rows = ref<EntryRow[]>([])
const total = ref(0)
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const message = ref('')
const messageKind = ref<'info' | 'error'>('info')
const busy = ref(false)

const wells = ref(listWells())
const batches = ref(listBatches())
const activeBatchId = ref<string | null>(batches.value[0]?.id ?? null)
const activeBatch = computed<ImportBatch | null>(() =>
  activeBatchId.value ? getBatch(activeBatchId.value) ?? null : null,
)
const activeMissing = computed(() => (activeBatch.value ? missingWellsOf(activeBatch.value) : []))
const activeMissingCount = computed(() => activeMissing.value.length)

const stats = computed(() => {
  const today = new Date().toISOString().slice(0, 10)
  return [
    { label: '今日观测井次', value: rows.value.filter((row) => String(row['观测日期']) === today).length },
    { label: '待审核记录', value: rows.value.filter((row) => String(row.status) === '待审核').length },
    { label: '异常记录数', value: rows.value.filter((row) => row.abnormal).length },
  ]
})

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function notify(text: string, kind: 'info' | 'error' = 'info') {
  message.value = text
  messageKind.value = kind
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  notify('地下水观测记录登记入口尚未接入审批流', 'error')
}

function runAction(action: string, row: EntryRow) {
  message.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    notify(result.message, 'error')
    return
  }
  reload()
}

function reload() {
  message.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    notify(error instanceof Error ? error.message : '地下水观测列表读取失败', 'error')
  }
}

function refreshPanels() {
  wells.value = listWells()
  batches.value = listBatches()
  if (activeBatchId.value) {
    const stillThere = getBatch(activeBatchId.value)
    if (!stillThere) {
      activeBatchId.value = batches.value[0]?.id ?? null
    }
  }
  reload()
}

const fileInput = ref<HTMLInputElement | null>(null)
let pickedFile: File | null = null

function onFilePicked(event: Event) {
  const input = event.target as HTMLInputElement
  pickedFile = input.files && input.files[0] ? input.files[0] : null
  if (pickedFile) {
    notify(`已选择文件 ${pickedFile.name}，点击「导入对账文件」开始处理`)
  }
}

function triggerImport() {
  if (!pickedFile) {
    notify('请先选择要导入的 CSV/TSV 文件', 'error')
    return
  }
  const file = pickedFile
  busy.value = true
  const reader = new FileReader()
  reader.onload = () => {
    try {
      const text = String(reader.result ?? '')
      const outcome = importReconcileFile(file.name, file.size, text)
      activeBatchId.value = outcome.batch.id
      refreshPanels()
      const b = outcome.batch
      if (outcome.reopened) {
        notify(
          `文件「${file.name}」此前已导入（批次 ${b.id}），已从断点继续重算：成功 ${b.inserted + b.updated + b.skipped} 行，失败 ${b.failed}，缺失井点 ${b.missing}`,
        )
      } else {
        notify(
          `批次 ${b.id} 已生成：新增 ${b.inserted}、补全 ${b.updated}、以现场为准跳过 ${b.skipped}、失败 ${b.failed}、缺失井点 ${b.missing}`,
          b.failed + b.missing > 0 ? 'error' : 'info',
        )
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : '导入失败', 'error')
    } finally {
      busy.value = false
    }
  }
  reader.onerror = () => {
    busy.value = false
    notify('文件读取失败，请重试', 'error')
  }
  reader.readAsText(file, 'utf-8')
}

function resumeActive() {
  if (!activeBatch.value) {
    return
  }
  try {
    const next = resumeBatch(activeBatch.value.id)
    activeBatchId.value = next.id
    refreshPanels()
    notify(
      `断点继续完成：成功 ${next.inserted + next.updated + next.skipped} 行，失败 ${next.failed}、缺失井点 ${next.missing}` +
      '（仍未通过的行多为日期/数值错误，请修正文件后重导）',
      next.failed + next.missing > 0 ? 'error' : 'info',
    )
  } catch (error) {
    notify(error instanceof Error ? error.message : '断点继续失败', 'error')
  }
}

function registerMissing() {
  if (!activeBatch.value) {
    return
  }
  const codes = batchMissingWells(activeBatch.value.id).map((well) => well.code)
  const added = addWells(codes, '缺失井点补录')
  refreshPanels()
  if (added.length === 0) {
    notify('缺失井点已在台账中，可直接「从断点继续」')
    return
  }
  notify(`已补录井点 ${added.map((well) => well.code).join('、')}（地面高程待补），再点「从断点继续」即可入账`)
}

async function confirmActive() {
  if (!activeBatch.value) {
    return
  }
  try {
    const outcome = await confirmBatchOnce(activeBatch.value.id, session.operator)
    activeBatchId.value = outcome.batch.id
    refreshPanels()
    if (outcome.applied) {
      notify(`批次 ${outcome.batch.id} 已确认，可到「水质检测」页面发起采样站点井点核查`)
    } else {
      notify(`批次已由其它终端确认，本终端未重复生效`)
    }
  } catch (error) {
    notify(error instanceof Error ? error.message : '确认失败', 'error')
  }
}

function selectBatch(id: string) {
  activeBatchId.value = id
}

function exportMissing() {
  if (!activeBatch.value) {
    return
  }
  const list = missingWellsOf(activeBatch.value)
  if (list.length === 0) {
    notify('当前批次没有缺失井点', 'error')
    return
  }
  downloadText(
    `${activeBatch.value.id}-缺失井点.csv`,
    missingWellsCsv(list),
    'text/csv;charset=utf-8',
  )
}

function exportTemplate() {
  const content = '﻿井点编号,观测日期,埋深值,水位标高,水温,观测人\nJG-001,2026-10-01,3.18,42.02,16.5,王立群\nJG-005,2026/10/01,2.6,,16.9,赵建国\n'
  downloadText('地下水对账导入模板.csv', content, 'text/csv;charset=utf-8')
}

function rowStatusLabel(status: ImportRowStatus): string {
  return IMPORT_ROW_STATUS_LABEL[status]
}

function rowBadge(status: ImportRowStatus): string {
  if (status === 'imported') return 'ok'
  if (status === 'updated') return 'info'
  if (status === 'skipped') return 'muted'
  return 'bad'
}

function onStoreChange(key: string) {
  if (key.includes('reconcile') || key.includes('entries') || key.includes('once-ledger')) {
    refreshPanels()
  }
}

let unsubscribe: (() => void) | null = null
onMounted(() => {
  reload()
  unsubscribe = subscribeStore(onStoreChange)
})
onBeforeUnmount(() => {
  unsubscribe?.()
})
</script>
