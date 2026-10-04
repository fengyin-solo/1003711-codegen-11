<template>
  <section class="page" data-module="groundwater">
    <header class="page-head">
      <div>
        <h2>地下水观测管理</h2>
        <p class="page-desc">维护地下水观测记录，围绕记录编号、井点编号、观测日期、埋深值做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记地下水观测记录</button>
        <label class="btn" :class="{ disabled: importing }">
          {{ importing ? '对账导入中…' : '导入井点对账包' }}
          <input type="file" accept=".csv,text/csv" hidden :disabled="importing" @change="onImportFile" />
        </label>
        <button class="btn" type="button" @click="exportMissing">导出缺失井点</button>
        <button class="btn" type="button" @click="exportRows">导出地下水观测清单</button>
      </div>
    </header>

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

    <section v-if="batches.length" class="batch-panel">
      <h3>井点资料对账批次</h3>
      <table class="data-table">
        <thead>
          <tr>
            <th>批次号</th>
            <th>对账文件</th>
            <th>导入时间</th>
            <th>数据行</th>
            <th>新增</th>
            <th>补全存量</th>
            <th>冲突保留</th>
            <th>失败</th>
            <th>缺失井点</th>
            <th>批次状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="batch in batches" :key="batch.id">
            <td>{{ batch.id }}</td>
            <td>{{ batch.fileName }}</td>
            <td>{{ batch.updatedAt }}</td>
            <td>{{ batch.totalRows }}</td>
            <td>{{ batch.imported }}</td>
            <td>{{ batch.complemented }}</td>
            <td>{{ batch.conflicts }}</td>
            <td>{{ batch.failed.length }}</td>
            <td>{{ batch.missing.length }}</td>
            <td>{{ batch.confirmed ? '已确认' : '待确认' }}</td>
            <td class="row-actions">
              <button
                v-if="!batch.confirmed"
                class="link"
                type="button"
                @click="confirmBatch(batch.id)"
              >
                确认
              </button>
              <button
                v-if="batch.failed.length"
                class="link"
                type="button"
                @click="exportFailed(batch.id)"
              >
                失败清单
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

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
          <td :colspan="columns.length + 2" class="empty-state">暂无地下水观测数据，可先登记地下水观测记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条地下水观测记录</span>
      <span v-if="noticeMessage" class="notice-text">{{ noticeMessage }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import {
  confirmReconBatch,
  downloadCsvFile,
  exportFailedWellPoints,
  exportMissingWellPoints,
  importReconFile,
  listReconBatches,
} from '@/api/groundwater-recon'
import type { ImportBatch } from '@/data/import-batches'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('groundwater')
const columns = ["记录编号", "井点编号", "观测日期", "埋深值", "水位标高", "水温", "观测人", "记录状态"]
const actions = ["提交审核", "确认通过", "标记异常"]
const statuses = ["已采集", "待审核", "已通过", "异常值"]
const stats = [{"label": "今日观测井次", "value": 0}, {"label": "待审核记录", "value": 0}, {"label": "异常记录数", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const noticeMessage = ref('')
const importing = ref(false)
const batches = ref<ImportBatch[]>([])
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
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

function exportMissing() {
  noticeMessage.value = ''
  errorMessage.value = ''
  downloadCsvFile(exportMissingWellPoints())
  noticeMessage.value = '缺失井点清单已导出'
}

function exportFailed(batchId: string) {
  noticeMessage.value = ''
  errorMessage.value = ''
  const file = exportFailedWellPoints(batchId)
  if (!file) {
    errorMessage.value = `没有找到批次 ${batchId} 的失败清单`
    return
  }
  downloadCsvFile(file)
}

function openCreate() {
  errorMessage.value = '地下水观测记录登记入口尚未接入审批流'
}

async function onImportFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) {
    return
  }
  errorMessage.value = ''
  noticeMessage.value = ''
  importing.value = true
  try {
    const content = await file.text()
    const result = await importReconFile(file.name, content)
    if (!result.ok) {
      errorMessage.value = result.message
      return
    }
    noticeMessage.value = result.message
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '对账文件导入失败'
  } finally {
    importing.value = false
    refreshBatches()
    reload()
  }
}

async function confirmBatch(batchId: string) {
  errorMessage.value = ''
  noticeMessage.value = ''
  try {
    const result = await confirmReconBatch(batchId)
    if (!result.ok) {
      errorMessage.value = result.message
      return
    }
    noticeMessage.value = result.message
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '批次确认失败'
  } finally {
    refreshBatches()
    reload()
  }
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  noticeMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function refreshBatches() {
  batches.value = listReconBatches()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '地下水观测列表读取失败'
  }
}

onMounted(() => {
  reload()
  refreshBatches()
})
</script>
