<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue'

// ============ 类型定义 ============
interface PMStatus {
  success: boolean
  projectName: string
  projectPath: string
  units: string
  activeToolpath: string
  activeTool: string
  activeBoundary: string
  activeNCProgram: string
  toolpathCount: number
  toolCount: number
  timestamp: string
  error?: string
}

interface PMTool {
  name: string
  type: string
  diameter: string
  length: string
  toolNumber: string
}

interface PMToolpath {
  name: string
  tool: string
  status: string
  strategy: string
  feedRate: string
  spindleSpeed: string
}

interface Drawing {
  id: number
  filename: string
  description: string
  material: string
  created_at: string
}

interface SearchResult {
  id: number
  filename: string
  description: string
  material: string
  machining_params: Record<string, unknown>
  similarity: number
  created_at: string
}

// ============ PowerMill 状态 ============
const pmStatus = ref<PMStatus | null>(null)
const pmTools = ref<PMTool[]>([])
const pmToolpaths = ref<PMToolpath[]>([])
const pmLoading = ref(false)
const pmError = ref('')
const pmConnected = ref(false)
const screenshotUrl = ref('')
const polling = ref(false)
let pollTimer: ReturnType<typeof setInterval> | null = null

async function fetchPMStatus() {
  pmLoading.value = true
  pmError.value = ''
  try {
    const res = await fetch('/api/powermill/status')
    const data = await res.json()
    pmStatus.value = data
    pmConnected.value = data.success
    if (!data.success && data.error) {
      pmError.value = data.error
    }
  } catch (err) {
    pmError.value = (err as Error).message
    pmConnected.value = false
  } finally {
    pmLoading.value = false
  }
}

async function fetchPMTools() {
  try {
    const res = await fetch('/api/powermill/tools')
    const data = await res.json()
    pmTools.value = data.tools || []
  } catch {}
}

async function fetchPMToolpaths() {
  try {
    const res = await fetch('/api/powermill/toolpaths')
    const data = await res.json()
    pmToolpaths.value = data.toolpaths || []
  } catch {}
}

async function refreshPM() {
  await Promise.all([fetchPMStatus(), fetchPMTools(), fetchPMToolpaths()])
}

async function takeScreenshot() {
  try {
    const res = await fetch('/api/powermill/screenshot', { method: 'POST' })
    const data = await res.json()
    if (data.success) {
      screenshotUrl.value = data.url + '?t=' + Date.now()
    }
  } catch {}
}

function togglePolling() {
  if (polling.value) {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
    polling.value = false
  } else {
    polling.value = true
    pollTimer = setInterval(fetchPMStatus, 5000)
  }
}

const statusBadge = computed(() => {
  if (pmLoading.value) return { text: '加载中...', class: 'badge-loading' }
  if (!pmConnected.value) return { text: '未连接', class: 'badge-error' }
  if (pmStatus.value && pmStatus.value.toolCount > 0) return { text: '已连接', class: 'badge-ok' }
  return { text: '无项目', class: 'badge-warn' }
})

// ============ 图纸上传 & 搜索 ============
const drawings = ref<Drawing[]>([])
const searchResults = ref<SearchResult[]>([])
const uploading = ref(false)
const searching = ref(false)
const uploadDesc = ref('')
const uploadMaterial = ref('')
const uploadFile = ref<File | null>(null)
const searchFile = ref<File | null>(null)
const previewUrl = ref<string>('')
const searchPreviewUrl = ref<string>('')

async function fetchDrawings() {
  try {
    const res = await fetch('/api/drawings')
    const data = await res.json()
    drawings.value = data.drawings || []
  } catch {}
}

function onUploadChange(e: Event) {
  const input = e.target as HTMLInputElement
  if (input.files?.[0]) {
    uploadFile.value = input.files[0]
    previewUrl.value = URL.createObjectURL(input.files[0])
  }
}

function onSearchChange(e: Event) {
  const input = e.target as HTMLInputElement
  if (input.files?.[0]) {
    searchFile.value = input.files[0]
    searchPreviewUrl.value = URL.createObjectURL(input.files[0])
  }
}

async function upload() {
  if (!uploadFile.value) return
  uploading.value = true
  try {
    const formData = new FormData()
    formData.append('file', uploadFile.value)
    formData.append('description', uploadDesc.value)
    formData.append('material', uploadMaterial.value)
    await fetch('/api/drawings/upload', { method: 'POST', body: formData })
    uploadFile.value = null
    uploadDesc.value = ''
    uploadMaterial.value = ''
    previewUrl.value = ''
    await fetchDrawings()
  } finally {
    uploading.value = false
  }
}

async function search() {
  if (!searchFile.value) return
  searching.value = true
  try {
    const formData = new FormData()
    formData.append('file', searchFile.value)
    formData.append('topK', '5')
    const res = await fetch('/api/search', { method: 'POST', body: formData })
    const data = await res.json()
    searchResults.value = data.results || []
  } finally {
    searching.value = false
  }
}

async function deleteDrawing(id: number) {
  await fetch(`/api/drawings/${id}`, { method: 'DELETE' })
  await fetchDrawings()
}

onMounted(() => {
  refreshPM()
  fetchDrawings()
})

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer)
})
</script>

<template>
  <div class="app">
    <header>
      <h1>CNC 图纸智能匹配系统</h1>
      <span class="badge" :class="statusBadge.class">{{ statusBadge.text }}</span>
    </header>

    <main>
      <!-- ====== PowerMill 状态面板 ====== -->
      <section class="card pm-panel">
        <div class="card-header">
          <h2>PowerMill 实时状态</h2>
          <div class="header-actions">
            <button class="btn-sm" :disabled="pmLoading" @click="refreshPM">
              {{ pmLoading ? '刷新中...' : '刷新' }}
            </button>
            <button class="btn-sm" :class="{ 'btn-active': polling }" @click="togglePolling">
              {{ polling ? '停止轮询' : '自动刷新' }}
            </button>
            <button class="btn-sm" @click="takeScreenshot">截图</button>
          </div>
        </div>

        <div v-if="pmError" class="error-msg">{{ pmError }}</div>

        <div v-if="pmStatus && pmStatus.success" class="pm-grid">
          <!-- 状态概览 -->
          <div class="pm-status">
            <div class="stat-item">
              <span class="stat-label">单位</span>
              <span class="stat-value">{{ pmStatus.units || '-' }}</span>
            </div>
            <div class="stat-item">
              <span class="stat-label">刀具数</span>
              <span class="stat-value">{{ pmStatus.toolCount }}</span>
            </div>
            <div class="stat-item">
              <span class="stat-label">刀路数</span>
              <span class="stat-value">{{ pmStatus.toolpathCount }}</span>
            </div>
            <div class="stat-item" v-if="pmStatus.activeTool">
              <span class="stat-label">当前刀具</span>
              <span class="stat-value highlight">{{ pmStatus.activeTool }}</span>
            </div>
            <div class="stat-item" v-if="pmStatus.activeToolpath">
              <span class="stat-label">当前刀路</span>
              <span class="stat-value highlight">{{ pmStatus.activeToolpath }}</span>
            </div>
            <div class="stat-item" v-if="pmStatus.activeNCProgram">
              <span class="stat-label">NC程序</span>
              <span class="stat-value">{{ pmStatus.activeNCProgram }}</span>
            </div>
          </div>

          <!-- 截图预览 -->
          <div v-if="screenshotUrl" class="screenshot-preview">
            <img :src="screenshotUrl" alt="PowerMill 截图" />
          </div>
        </div>

        <div v-else-if="!pmLoading" class="empty-state">
          <p>PowerMill 未连接或未打开项目</p>
          <p class="hint">请启动 PowerMill 并打开一个项目</p>
        </div>

        <!-- 刀具列表 -->
        <div v-if="pmTools.length" class="pm-lists">
          <div class="pm-list">
            <h3>刀具 ({{ pmTools.length }})</h3>
            <div class="list-items">
              <div v-for="t in pmTools" :key="t.name" class="list-item"
                   :class="{ active: pmStatus?.activeTool === t.name }">
                <span class="item-name">{{ t.name }}</span>
              </div>
            </div>
          </div>

          <div class="pm-list">
            <h3>刀具路径 ({{ pmToolpaths.length }})</h3>
            <div class="list-items">
              <div v-for="tp in pmToolpaths" :key="tp.name" class="list-item"
                   :class="{ active: pmStatus?.activeToolpath === tp.name }">
                <span class="item-name">{{ tp.name }}</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- ====== 图纸上传 ====== -->
      <section class="card">
        <h2>上传图纸</h2>
        <div class="upload-area">
          <input type="file" accept="image/*" @change="onUploadChange" />
          <img v-if="previewUrl" :src="previewUrl" class="preview" />
        </div>
        <div class="form-row">
          <input v-model="uploadDesc" placeholder="描述（可选）" />
          <input v-model="uploadMaterial" placeholder="材料（可选）" />
        </div>
        <button :disabled="!uploadFile || uploading" @click="upload">
          {{ uploading ? '上传中...' : '上传' }}
        </button>
      </section>

      <!-- ====== 相似搜索 ====== -->
      <section class="card">
        <h2>相似图纸搜索</h2>
        <div class="upload-area">
          <input type="file" accept="image/*" @change="onSearchChange" />
          <img v-if="searchPreviewUrl" :src="searchPreviewUrl" class="preview" />
        </div>
        <button :disabled="!searchFile || searching" @click="search">
          {{ searching ? '搜索中...' : '搜索' }}
        </button>

        <div v-if="searchResults.length" class="results">
          <h3>搜索结果</h3>
          <div v-for="r in searchResults" :key="r.id" class="result-item">
            <img :src="`/api/drawings/${r.id}/image`" class="result-thumb" />
            <div class="result-info">
              <p><strong>{{ r.filename }}</strong></p>
              <p>相似度: {{ (r.similarity * 100).toFixed(1) }}%</p>
              <p v-if="r.material">材料: {{ r.material }}</p>
              <p v-if="r.description">{{ r.description }}</p>
            </div>
          </div>
        </div>
      </section>

      <!-- ====== 图库 ====== -->
      <section class="card">
        <h2>图库 ({{ drawings.length }})</h2>
        <div class="gallery">
          <div v-for="d in drawings" :key="d.id" class="gallery-item">
            <img :src="`/api/drawings/${d.id}/image`" class="gallery-thumb" />
            <p>{{ d.filename }}</p>
            <button class="delete-btn" @click="deleteDrawing(d.id)">删除</button>
          </div>
        </div>
      </section>
    </main>
  </div>
</template>

<style scoped>
.app { max-width: 1200px; margin: 0 auto; padding: 20px; font-family: 'Segoe UI', system-ui, sans-serif; }

header { display: flex; align-items: center; gap: 15px; margin-bottom: 25px; }
h1 { color: #1a1a2e; margin: 0; font-size: 24px; }
h2 { color: #1a1a2e; font-size: 18px; margin: 0 0 15px 0; }
h3 { color: #333; font-size: 14px; margin: 0 0 8px 0; }

.badge { padding: 4px 12px; border-radius: 12px; font-size: 12px; font-weight: 600; }
.badge-ok { background: #e8f5e9; color: #2e7d32; }
.badge-error { background: #ffebee; color: #c62828; }
.badge-warn { background: #fff3e0; color: #e65100; }
.badge-loading { background: #e3f2fd; color: #1565c0; }

.card { background: #fff; border-radius: 10px; padding: 20px; margin-bottom: 20px; box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
.card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; }
.card-header h2 { margin: 0; }
.header-actions { display: flex; gap: 8px; }

.btn-sm { padding: 6px 14px; font-size: 13px; border: 1px solid #ddd; background: #fff; border-radius: 6px; cursor: pointer; transition: all 0.15s; }
.btn-sm:hover { background: #f0f0f0; }
.btn-sm:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-active { background: #1565c0; color: #fff; border-color: #1565c0; }

.pm-panel { border-top: 3px solid #1565c0; }
.pm-grid { display: flex; gap: 20px; flex-wrap: wrap; }
.pm-status { flex: 1; min-width: 300px; }
.stat-item { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid #f0f0f0; }
.stat-label { color: #666; font-size: 13px; }
.stat-value { color: #1a1a2e; font-weight: 600; font-size: 13px; }
.stat-value.highlight { color: #1565c0; }

.screenshot-preview { flex: 1; min-width: 300px; }
.screenshot-preview img { width: 100%; border-radius: 6px; border: 1px solid #eee; }

.empty-state { text-align: center; padding: 30px; color: #999; }
.empty-state .hint { font-size: 13px; margin-top: 5px; }

.pm-lists { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-top: 20px; }
.pm-list { }
.list-items { max-height: 250px; overflow-y: auto; border: 1px solid #eee; border-radius: 6px; }
.list-item { padding: 8px 12px; border-bottom: 1px solid #f5f5f5; font-size: 13px; }
.list-item:last-child { border-bottom: none; }
.list-item.active { background: #e3f2fd; border-left: 3px solid #1565c0; }
.item-name { color: #333; }

.error-msg { color: #c62828; background: #ffebee; padding: 8px 12px; border-radius: 6px; margin-bottom: 10px; font-size: 13px; }

.upload-area { display: flex; gap: 15px; align-items: center; margin-bottom: 10px; }
.preview { max-width: 200px; max-height: 150px; border-radius: 4px; }
.form-row { display: flex; gap: 10px; margin-bottom: 10px; }
.form-row input { flex: 1; padding: 8px; border: 1px solid #ddd; border-radius: 4px; }
button { padding: 8px 20px; background: #4CAF50; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 14px; }
button:disabled { background: #ccc; cursor: not-allowed; }

.results { margin-top: 15px; }
.result-item { display: flex; gap: 10px; margin-bottom: 10px; padding: 10px; background: #f9f9f9; border-radius: 4px; }
.result-thumb { width: 80px; height: 80px; object-fit: cover; border-radius: 4px; }
.result-info p { margin: 2px 0; font-size: 13px; }

.gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 15px; }
.gallery-item { text-align: center; }
.gallery-thumb { width: 100%; aspect-ratio: 1; object-fit: cover; border-radius: 4px; }
.gallery-item p { font-size: 12px; margin: 5px 0; }
.delete-btn { background: #f44336; font-size: 12px; padding: 4px 10px; }

@media (max-width: 768px) {
  .pm-lists { grid-template-columns: 1fr; }
}
</style>
