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
const screenshotFilename = ref('')
const screenshotLoading = ref(false)
const saveScreenshotLoading = ref(false)
const screenshotDesc = ref('')
const screenshotMaterial = ref('')
const polling = ref(false)
let pollTimer: ReturnType<typeof setInterval> | null = null

// 轻量提示
const toastVisible = ref(false)
const toastText = ref('')
let toastTimer: ReturnType<typeof setTimeout> | null = null
function showToast(text: string, duration = 2500) {
  toastText.value = text
  toastVisible.value = true
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toastVisible.value = false }, duration)
}

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
  // Use /refresh to force a fresh PowerShell query, then fetch tools/pathlists
  pmLoading.value = true
  try {
    const res = await fetch('/api/powermill/refresh', { method: 'POST' })
    const data = await res.json()
    pmStatus.value = data
    pmConnected.value = data.success
    if (!data.success && data.error) pmError.value = data.error
  } catch (err) {
    pmError.value = (err as Error).message
    pmConnected.value = false
  } finally {
    pmLoading.value = false
  }
  fetchPMTools()
  fetchPMToolpaths()
}

async function takeScreenshot() {
  if (screenshotLoading.value) return
  screenshotLoading.value = true
  pmError.value = ''
  try {
    const body: { view?: string } = {}
    if (screenshotView.value) body.view = screenshotView.value
    const res = await fetch('/api/powermill/screenshot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json()
    if (data.success) {
      screenshotUrl.value = data.url + '?t=' + Date.now()
      screenshotFilename.value = data.filename || ''
    } else {
      pmError.value = data.error || '截图失败，请确认 PowerMill 已启动且窗口未最小化'
      screenshotFilename.value = ''
    }
  } catch (err) {
    pmError.value = '截图请求失败: ' + (err as Error).message
  } finally {
    screenshotLoading.value = false
  }
}

async function saveScreenshotToLibrary() {
  if (!screenshotFilename.value) return
  saveScreenshotLoading.value = true
  try {
    const res = await fetch('/api/drawings/from-screenshot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: screenshotFilename.value,
        description: screenshotDesc.value,
        material: screenshotMaterial.value,
      }),
    })
    const data = await res.json()
    if (data.success) {
      screenshotDesc.value = ''
      screenshotMaterial.value = ''
      await fetchDrawings()
      showToast('截图已保存到图库')
    } else {
      showToast('保存失败：' + (data.error || '未知错误'))
    }
  } catch (err) {
    showToast('保存失败：' + (err as Error).message)
  } finally {
    saveScreenshotLoading.value = false
  }
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
const recognizing = ref(false)
const showSettings = ref(false)
const settingsConfig = ref({ siliconflowApiKey: '', siliconflowBaseUrl: 'https://api.siliconflow.cn/v1', embeddingModel: 'Qwen/Qwen3-VL-Embedding-8B', configured: false })
const settingsInput = ref({ siliconflowApiKey: '', siliconflowBaseUrl: 'https://api.siliconflow.cn/v1', embeddingModel: 'Qwen/Qwen3-VL-Embedding-8B' })
const savingSettings = ref(false)
const recognizeResult = ref<any>(null)
const recognizeError = ref('')
const uploadDesc = ref('')
const uploadMaterial = ref('')
const uploadFile = ref<File | null>(null)
const searchFile = ref<File | null>(null)
const previewUrl = ref<string>('')
const searchPreviewUrl = ref<string>('')
const uploadDragOver = ref(false)
const searchDragOver = ref(false)
const uploadInputRef = ref<HTMLInputElement | null>(null)
const searchInputRef = ref<HTMLInputElement | null>(null)
const showLibrary = ref(false)
const showLightbox = ref(false)
const lightboxUrl = ref('')
const applyLoading = ref<Record<number, boolean>>({})
const applyMessage = ref<Record<number, { type: 'success' | 'error'; text: string }>>({})
const screenshotView = ref<'iso' | 'front' | 'top' | 'left' | 'right' | 'back' | 'bottom' | ''>('')

function openLightbox(url: string) {
  lightboxUrl.value = url
  showLightbox.value = true
}

function closeLightbox() {
  showLightbox.value = false
}

function openLibrary() {
  showLibrary.value = true
  fetchDrawings()
}

function closeLibrary() {
  showLibrary.value = false
}

function formatParamValue(value: unknown): string {
  if (value === null || value === undefined) return '-'
  if (typeof value === 'number') return Number.isInteger(value) ? value.toString() : value.toFixed(2)
  return String(value)
}

async function applyParams(match: SearchResult) {
  if (!match.machining_params || !Object.keys(match.machining_params).length) return
  applyLoading.value[match.id] = true
  applyMessage.value[match.id] = { type: 'success', text: '' }
  try {
    const res = await fetch('/api/powermill/apply-params', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ params: match.machining_params }),
    })
    const data = await res.json()
    if (data.success) {
      applyMessage.value[match.id] = { type: 'success', text: '参数已应用到当前项目' }
      // 刷新 PowerMill 状态以显示新激活的刀具
      await refreshPM()
    } else {
      const failed = (data.results || []).filter((r: any) => !r.success).map((r: any) => r.error || r.command).join('; ')
      applyMessage.value[match.id] = { type: 'error', text: failed || data.error || '应用失败' }
    }
  } catch (err) {
    applyMessage.value[match.id] = { type: 'error', text: (err as Error).message }
  } finally {
    applyLoading.value[match.id] = false
  }
}

async function fetchDrawings() {
  try {
    const res = await fetch('/api/drawings')
    const data = await res.json()
    drawings.value = data.drawings || []
  } catch {}
}

function readFile(file: File | undefined, setter: (url: string) => void, fileSetter: (f: File) => void) {
  if (!file || !file.type.startsWith('image/')) return
  setter(URL.createObjectURL(file))
  fileSetter(file)
}

function onUploadChange(e: Event) {
  const input = e.target as HTMLInputElement
  readFile(input.files?.[0], (url) => { previewUrl.value = url }, (f) => { uploadFile.value = f })
}

function onUploadDrop(e: DragEvent) {
  uploadDragOver.value = false
  const file = e.dataTransfer?.files?.[0]
  readFile(file, (url) => { previewUrl.value = url }, (f) => { uploadFile.value = f })
}

function onSearchChange(e: Event) {
  const input = e.target as HTMLInputElement
  readFile(input.files?.[0], (url) => { searchPreviewUrl.value = url }, (f) => { searchFile.value = f })
}

function onSearchDrop(e: DragEvent) {
  searchDragOver.value = false
  const file = e.dataTransfer?.files?.[0]
  readFile(file, (url) => { searchPreviewUrl.value = url }, (f) => { searchFile.value = f })
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

async function openLibraryFolder() {
  try {
    const res = await fetch('/api/drawings/folder', { method: 'POST' })
    const data = await res.json()
    if (!data.success) {
      showToast('打开文件夹失败：' + (data.error || '未知错误'))
    }
  } catch (err) {
    showToast('打开文件夹失败：' + (err as Error).message)
  }
}

async function globalRecognize() {
  recognizing.value = true
  recognizeError.value = ''
  recognizeResult.value = null
  try {
    const res = await fetch('/api/powermill/global-recognize', { method: 'POST' })
    const data = await res.json()
    if (data.success) {
      recognizeResult.value = data
    } else {
      recognizeError.value = data.error || '识别失败'
    }
  } catch (err) {
    recognizeError.value = (err as Error).message
  } finally {
    recognizing.value = false
  }
}

async function fetchSettings() {
  try {
    const res = await fetch('/api/config')
    const data = await res.json()
    if (data.success) {
      settingsConfig.value = data.config
      settingsInput.value.siliconflowApiKey = ''
      settingsInput.value.siliconflowBaseUrl = data.config.siliconflowBaseUrl
      settingsInput.value.embeddingModel = data.config.embeddingModel
    }
  } catch {}
}

async function saveSettings() {
  savingSettings.value = true
  try {
    const body: Record<string, string> = {}
    if (settingsInput.value.siliconflowApiKey) body.siliconflowApiKey = settingsInput.value.siliconflowApiKey
    if (settingsInput.value.siliconflowBaseUrl) body.siliconflowBaseUrl = settingsInput.value.siliconflowBaseUrl
    if (settingsInput.value.embeddingModel) body.embeddingModel = settingsInput.value.embeddingModel
    const res = await fetch('/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const data = await res.json()
    if (data.success) {
      settingsConfig.value = data.config
      showSettings.value = false
    }
  } finally {
    savingSettings.value = false
  }
}

onMounted(() => {
  refreshPM()
  fetchDrawings()
  fetchSettings()
  // Auto-refresh PowerMill status every 15s (backend caches, so this is fast)
  pollTimer = setInterval(fetchPMStatus, 15000)
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
      <button class="btn-sm" @click="openLibrary">历史库 ({{ drawings.length }})</button>
      <button class="btn-sm settings-btn" @click="showSettings = true">设置</button>
    </header>


    <!-- ====== 设置弹窗 ====== -->
    <div v-if="showSettings" class="modal-overlay" @click.self="showSettings = false">
      <div class="modal">
        <div class="modal-header">
          <h2>API 配置</h2>
          <button class="modal-close" @click="showSettings = false">&times;</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label>硅基流动 API 密钥</label>
            <input v-model="settingsInput.siliconflowApiKey" type="password" :placeholder="settingsConfig.configured ? '已配置（输入新值可替换）' : '请输入 API 密钥'" />
            <p class="form-hint">获取地址：https://cloud.siliconflow.cn （注册免费获取）</p>
          </div>
          <div class="form-group">
            <label>接口地址</label>
            <input v-model="settingsInput.siliconflowBaseUrl" />
          </div>
          <div class="form-group">
            <label>向量化模型</label>
            <input v-model="settingsInput.embeddingModel" />
          </div>
          <div v-if="settingsConfig.configured" class="config-status ok">
            当前状态：已配置 ({{ settingsConfig.siliconflowApiKey }})
          </div>
          <div v-else class="config-status warn">
            当前状态：未配置，全局识别功能不可用
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn-cancel" @click="showSettings = false">取消</button>
          <button class="btn-save" :disabled="savingSettings" @click="saveSettings">
            {{ savingSettings ? '保存中...' : '保存' }}
          </button>
        </div>
      </div>
    </div>

    <!-- 全局轻量提示 -->
    <transition name="toast">
      <div v-if="toastVisible" class="global-toast">{{ toastText }}</div>
    </transition>

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
            <select v-model="screenshotView" class="view-select" title="截图前先切换视角">
              <option value="">当前视角</option>
              <option value="iso">等轴测</option>
              <option value="front">主视图</option>
              <option value="top">俯视图</option>
              <option value="left">左视图</option>
              <option value="right">右视图</option>
              <option value="back">后视图</option>
              <option value="bottom">仰视图</option>
            </select>
            <button class="btn-sm" :disabled="screenshotLoading" @click="takeScreenshot">
              {{ screenshotLoading ? '截图中...' : '截图' }}
            </button>
            <button class="btn-sm" @click="openLibrary">历史库 ({{ drawings.length }})</button>
            <button class="btn-sm btn-primary" :disabled="recognizing || !pmConnected" @click="globalRecognize">
              {{ recognizing ? '识别中...' : '全局识别' }}
            </button>
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
            <img :src="screenshotUrl" alt="PowerMill 截图" @click="openLightbox(screenshotUrl)" />
            <p class="preview-hint">点击图片查看大图</p>
            <div class="screenshot-save">
              <div class="form-row">
                <div class="form-field">
                  <label>描述</label>
                  <input v-model="screenshotDesc" placeholder="例如：前壳体粗加工" />
                </div>
                <div class="form-field">
                  <label>材料</label>
                  <input v-model="screenshotMaterial" placeholder="例如：P20" />
                </div>
              </div>
              <button
                class="btn-save-screenshot"
                :disabled="saveScreenshotLoading || !screenshotFilename"
                @click="saveScreenshotToLibrary"
              >
                {{ saveScreenshotLoading ? '保存中...' : '保存截图到图库' }}
              </button>
            </div>
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
        <h2>上传历史图纸</h2>
        <div
          class="upload-dropzone"
          :class="{ 'has-file': previewUrl, 'drag-over': uploadDragOver }"
          @dragover.prevent="uploadDragOver = true"
          @dragleave.prevent="uploadDragOver = false"
          @drop.prevent="onUploadDrop"
          @click="uploadInputRef?.click()"
        >
          <input ref="uploadInputRef" type="file" accept="image/*" @change="onUploadChange" />
          <template v-if="!previewUrl">
            <div class="upload-icon">+</div>
            <p class="upload-title">点击或拖拽图片到此处上传</p>
            <p class="upload-hint">支持 JPG、PNG、BMP 等常见图片格式</p>
          </template>
          <img v-else :src="previewUrl" class="upload-preview" @click.stop="openLightbox(previewUrl)" />
        </div>
        <div class="form-row">
          <div class="form-field">
            <label>描述</label>
            <input v-model="uploadDesc" placeholder="例如：前壳体粗加工" />
          </div>
          <div class="form-field">
            <label>材料</label>
            <input v-model="uploadMaterial" placeholder="例如：P20、铝 6061" />
          </div>
        </div>
        <button :disabled="!uploadFile || uploading" @click="upload">
          {{ uploading ? '上传中...' : '上传至图库' }}
        </button>
      </section>

      <!-- ====== 相似搜索 ====== -->
      <section class="card">
        <h2>相似图纸搜索</h2>
        <div
          class="upload-dropzone"
          :class="{ 'has-file': searchPreviewUrl, 'drag-over': searchDragOver }"
          @dragover.prevent="searchDragOver = true"
          @dragleave.prevent="searchDragOver = false"
          @drop.prevent="onSearchDrop"
          @click="searchInputRef?.click()"
        >
          <input ref="searchInputRef" type="file" accept="image/*" @change="onSearchChange" />
          <template v-if="!searchPreviewUrl">
            <div class="upload-icon">Q</div>
            <p class="upload-title">点击或拖拽图片搜索相似图纸</p>
            <p class="upload-hint">将从历史图库中匹配最相似的加工图纸</p>
          </template>
          <img v-else :src="searchPreviewUrl" class="upload-preview" @click.stop="openLightbox(searchPreviewUrl)" />
        </div>
        <button :disabled="!searchFile || searching" @click="search">
          {{ searching ? '搜索中...' : '开始搜索' }}
        </button>

        <div v-if="searchResults.length" class="results">
          <h3>搜索结果</h3>
          <div v-for="r in searchResults" :key="r.id" class="result-item">
            <div class="result-thumb-wrap">
              <img :src="`/api/drawings/${r.id}/image`" class="result-thumb" @click="openLightbox(`/api/drawings/${r.id}/image`)" />
            </div>
            <div class="result-info">
              <p class="result-name">{{ r.filename }}</p>
              <div class="result-meta">
                <span class="similarity-badge" :class="{ high: r.similarity > 0.8 }">相似度 {{ (r.similarity * 100).toFixed(1) }}%</span>
                <span v-if="r.material" class="meta-tag">{{ r.material }}</span>
              </div>
              <p v-if="r.description" class="result-desc">{{ r.description }}</p>
            </div>
          </div>
        </div>
      </section>

      <!-- ====== 全局识别结果 ====== -->
      <section v-if="recognizeResult || recognizeError" class="card recognize-panel">
        <h2>全局识别结果</h2>
        <div v-if="recognizeError" class="error-msg">{{ recognizeError }}</div>
        <div v-if="recognizeResult">
          <div class="recognize-summary">
            <div class="rec-stat">
              <span class="rec-label">项目</span>
              <span class="rec-value" :title="recognizeResult.project.path">
                {{ recognizeResult.project.name || '当前项目' }}
              </span>
            </div>
            <div class="rec-stat">
              <span class="rec-label">刀具数</span>
              <span class="rec-value">{{ recognizeResult.project.toolCount }}</span>
            </div>
            <div class="rec-stat">
              <span class="rec-label">刀路数</span>
              <span class="rec-value">{{ recognizeResult.project.toolpathCount }}</span>
            </div>
            <div class="rec-stat">
              <span class="rec-label">历史库</span>
              <span class="rec-value">{{ recognizeResult.totalInDb }} 张</span>
            </div>
          </div>

          <div v-if="recognizeResult.screenshot" class="recognize-screenshot">
            <img :src="recognizeResult.screenshot.url" alt="PowerMill 视图截图" @click="openLightbox(recognizeResult.screenshot.url)" />
            <p class="preview-hint">点击图片查看大图</p>
          </div>

          <div v-if="recognizeResult.matches.length" class="recognize-matches">
            <h3>相似图纸匹配 (Top {{ recognizeResult.matches.length }})</h3>
            <div v-for="m in recognizeResult.matches" :key="m.id" class="match-item"
                 :class="{ 'match-best': m.similarity > 0.8 }">
              <img :src="`/api/drawings/${m.id}/image`" class="match-thumb" @click="openLightbox(`/api/drawings/${m.id}/image`)" />
              <div class="match-info">
                <p><strong>{{ m.filename }}</strong></p>
                <p>相似度: <span class="sim-value">{{ (m.similarity * 100).toFixed(1) }}%</span></p>
                <p v-if="m.material">材料: {{ m.material }}</p>
                <p v-if="m.description">{{ m.description }}</p>

                <!-- 结构化加工参数 -->
                <div v-if="Object.keys(m.machining_params).length" class="params-panel">
                  <h4>推荐加工参数</h4>
                  <table class="params-table">
                    <tbody>
                      <tr v-for="(value, key) in m.machining_params" :key="key">
                        <td class="param-key">{{ key }}</td>
                        <td class="param-value">{{ formatParamValue(value) }}</td>
                      </tr>
                    </tbody>
                  </table>
                  <button
                    class="btn-apply"
                    :disabled="applyLoading[m.id] || !pmConnected"
                    @click="applyParams(m)"
                  >
                    {{ applyLoading[m.id] ? '应用中...' : '应用到当前项目' }}
                  </button>
                  <p v-if="applyMessage[m.id]?.text" class="apply-msg" :class="applyMessage[m.id].type">
                    {{ applyMessage[m.id].text }}
                  </p>
                </div>
              </div>
            </div>
          </div>

          <div v-else class="empty-state">
            <p>未找到相似图纸</p>
            <p class="hint">请先在图库中上传历史图纸</p>
          </div>
        </div>
      </section>

      <!-- ====== 图库 ====== -->
      <section class="card">
        <div class="card-header">
          <h2>图库 ({{ drawings.length }})</h2>
          <button class="btn-sm" @click="openLibraryFolder">打开图库文件夹</button>
        </div>
        <div class="gallery">
          <div v-for="d in drawings" :key="d.id" class="gallery-item">
            <img :src="`/api/drawings/${d.id}/image`" class="gallery-thumb" @click="openLightbox(`/api/drawings/${d.id}/image`)" />
            <p>{{ d.filename }}</p>
            <button class="delete-btn" @click="deleteDrawing(d.id)">删除</button>
          </div>
        </div>
      </section>
    </main>

    <!-- ====== 历史库弹窗 ====== -->
    <div v-if="showLibrary" class="modal-overlay" @click.self="closeLibrary">
      <div class="modal modal-wide">
        <div class="modal-header">
          <h2>历史图库 ({{ drawings.length }} 张)</h2>
          <div class="modal-actions">
            <button class="btn-sm" @click="openLibraryFolder">打开图库文件夹</button>
            <button class="modal-close" @click="closeLibrary">&times;</button>
          </div>
        </div>
        <div class="modal-body">
          <div v-if="!drawings.length" class="empty-state">
            <p>历史库为空</p>
            <p class="hint">请在「上传图纸」区域添加历史图纸</p>
          </div>
          <div v-else class="library-grid">
            <div v-for="d in drawings" :key="d.id" class="library-item">
              <img :src="`/api/drawings/${d.id}/image`" @click="openLightbox(`/api/drawings/${d.id}/image`)" />
              <div class="library-meta">
                <p class="library-name">{{ d.filename }}</p>
                <p v-if="d.description" class="library-desc">{{ d.description }}</p>
                <p v-if="d.material" class="library-desc">材料: {{ d.material }}</p>
                <p class="library-date">{{ new Date(d.created_at).toLocaleString() }}</p>
              </div>
              <button class="delete-btn" @click="deleteDrawing(d.id)">删除</button>
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn-cancel" @click="closeLibrary">关闭</button>
        </div>
      </div>
    </div>

    <!-- ====== 图片放大查看 ====== -->
    <div v-if="showLightbox" class="lightbox-overlay" @click.self="closeLightbox">
      <img :src="lightboxUrl" class="lightbox-img" @click.stop />
      <button class="lightbox-close" @click="closeLightbox">&times;</button>
    </div>
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
.screenshot-save { margin-top: 12px; padding: 12px; background: #f9f9f9; border-radius: 8px; }
.screenshot-save .form-row { margin-bottom: 10px; }
.btn-save-screenshot { background: #1565c0; color: #fff; padding: 8px 16px; font-size: 13px; border-radius: 6px; border: none; cursor: pointer; }
.btn-save-screenshot:disabled { background: #ccc; cursor: not-allowed; }

.global-toast {
  position: fixed;
  top: 20px;
  left: 50%;
  transform: translateX(-50%);
  background: rgba(0,0,0,0.8);
  color: #fff;
  padding: 10px 20px;
  border-radius: 8px;
  font-size: 14px;
  z-index: 2000;
  pointer-events: none;
  box-shadow: 0 4px 12px rgba(0,0,0,0.15);
}
.toast-enter-active, .toast-leave-active { transition: opacity 0.3s, transform 0.3s; }
.toast-enter-from, .toast-leave-to { opacity: 0; transform: translateX(-50%) translateY(-10px); }

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

.upload-dropzone {
  border: 2px dashed #d0d7de;
  border-radius: 10px;
  padding: 32px 20px;
  text-align: center;
  cursor: pointer;
  transition: all 0.2s;
  background: #fafbfc;
  margin-bottom: 16px;
  position: relative;
  overflow: hidden;
}
.upload-dropzone:hover,
.upload-dropzone.drag-over {
  border-color: #1565c0;
  background: #f0f7ff;
}
.upload-dropzone input[type="file"] {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
}
.upload-icon {
  width: 48px;
  height: 48px;
  line-height: 46px;
  border-radius: 50%;
  background: #e3f2fd;
  color: #1565c0;
  font-size: 24px;
  margin: 0 auto 12px;
  font-weight: 600;
}
.upload-title { margin: 0 0 6px 0; font-size: 15px; color: #333; font-weight: 500; }
.upload-hint { margin: 0; font-size: 12px; color: #999; }
.upload-preview {
  max-width: 100%;
  max-height: 240px;
  border-radius: 6px;
  object-fit: contain;
}
.upload-dropzone.has-file {
  padding: 16px;
  background: #fff;
}

.form-row { display: flex; gap: 12px; margin-bottom: 16px; }
.form-field { flex: 1; }
.form-field label { display: block; font-size: 13px; color: #555; margin-bottom: 6px; font-weight: 600; }
.form-field input { width: 100%; padding: 8px 12px; border: 1px solid #ddd; border-radius: 6px; box-sizing: border-box; }
button { padding: 8px 20px; background: #4CAF50; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 14px; }
button:disabled { background: #ccc; cursor: not-allowed; }

.results { margin-top: 20px; }
.results h3 { margin: 0 0 12px 0; font-size: 15px; color: #333; }
.result-item { display: flex; gap: 14px; margin-bottom: 12px; padding: 12px; background: #f9f9f9; border-radius: 8px; align-items: flex-start; }
.result-thumb-wrap { flex-shrink: 0; }
.result-thumb { width: 100px; height: 100px; object-fit: cover; border-radius: 6px; cursor: zoom-in; }
.result-info { flex: 1; min-width: 0; }
.result-name { margin: 0 0 8px 0; font-size: 14px; font-weight: 600; color: #1a1a2e; word-break: break-all; }
.result-meta { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 6px; }
.similarity-badge { display: inline-block; padding: 3px 10px; border-radius: 12px; font-size: 12px; font-weight: 600; background: #e3f2fd; color: #1565c0; }
.similarity-badge.high { background: #e8f5e9; color: #2e7d32; }
.meta-tag { display: inline-block; padding: 3px 10px; border-radius: 12px; font-size: 12px; background: #f0f0f0; color: #666; }
.result-desc { margin: 0; font-size: 12px; color: #666; line-height: 1.4; }

.gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 15px; }
.gallery-item { text-align: center; }
.gallery-thumb { width: 100%; aspect-ratio: 1; object-fit: cover; border-radius: 4px; }
.gallery-item p { font-size: 12px; margin: 5px 0; }
.delete-btn { background: #f44336; font-size: 12px; padding: 4px 10px; }

@media (max-width: 768px) {
  .pm-lists { grid-template-columns: 1fr; }
}

/* 全局识别 */
.recognize-panel { border-top: 3px solid #4CAF50; }
.recognize-summary { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 15px; }
.rec-stat { background: #f5f7fa; padding: 10px; border-radius: 6px; text-align: center; }
.rec-label { display: block; font-size: 12px; color: #666; }
.rec-value { display: block; font-size: 16px; font-weight: 600; color: #1a1a2e; margin-top: 4px; }
.recognize-screenshot { margin-bottom: 15px; }
.recognize-screenshot img { width: 100%; max-height: 300px; object-fit: contain; border-radius: 6px; border: 1px solid #eee; }
.recognize-matches h3 { margin: 0 0 12px 0; font-size: 14px; color: #333; }
.match-item { display: flex; gap: 12px; padding: 12px; background: #f9f9f9; border-radius: 6px; margin-bottom: 10px; }
.match-item.match-best { background: #e8f5e9; border-left: 3px solid #4CAF50; }
.match-thumb { width: 80px; height: 80px; object-fit: cover; border-radius: 4px; }
.match-info { flex: 1; }
.match-info p { margin: 2px 0; font-size: 13px; }
.sim-value { font-weight: 600; color: #4CAF50; }
.match-info details { margin-top: 8px; }
.match-info summary { font-size: 12px; color: #1565c0; cursor: pointer; }
.params-pre { background: #fff; padding: 8px; border-radius: 4px; font-size: 11px; overflow-x: auto; }
.btn-primary { background: #4CAF50; color: white; border-color: #4CAF50; }
.settings-btn { margin-left: auto; }
.modal-overlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 1000; }
.modal { background: white; border-radius: 10px; width: 480px; max-width: 90%; max-height: 80vh; display: flex; flex-direction: column; box-shadow: 0 8px 32px rgba(0,0,0,0.2); }
.modal-header { display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; border-bottom: 1px solid #eee; }
.modal-header h2 { margin: 0; font-size: 18px; }
.modal-actions { display: flex; align-items: center; gap: 8px; }
.modal-close { background: none; border: none; font-size: 24px; cursor: pointer; color: #999; padding: 0 8px; }
.modal-body { padding: 20px; overflow-y: auto; }
.form-group { margin-bottom: 16px; }
.form-group label { display: block; font-size: 13px; color: #333; margin-bottom: 6px; font-weight: 600; }
.form-group input { width: 100%; padding: 8px 12px; border: 1px solid #ddd; border-radius: 6px; font-size: 14px; box-sizing: border-box; }
.form-hint { font-size: 12px; color: #999; margin: 4px 0 0 0; }
.config-status { padding: 10px; border-radius: 6px; font-size: 13px; margin-top: 8px; }
.config-status.ok { background: #e8f5e9; color: #2e7d32; }
.config-status.warn { background: #fff3e0; color: #e65100; }
.modal-footer { display: flex; justify-content: flex-end; gap: 10px; padding: 16px 20px; border-top: 1px solid #eee; }
.btn-cancel { padding: 8px 20px; background: #f5f5f5; color: #666; border: 1px solid #ddd; border-radius: 6px; cursor: pointer; font-size: 14px; }
.btn-save { padding: 8px 20px; background: #1565c0; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 14px; }
.btn-save:disabled { background: #ccc; cursor: not-allowed; }
.btn-primary:hover { background: #43a047; }
@media (max-width: 768px) {
  .recognize-summary { grid-template-columns: repeat(2, 1fr); }
}

/* === 确保所有文字和输入框在浅色背景下可见 === */
input, textarea, select {
  color: #333333 !important;
  background: #ffffff !important;
  border: 1px solid #cccccc !important;
}
input::placeholder, textarea::placeholder {
  color: #999999 !important;
}
input[type="file"] {
  color: #333333 !important;
}
.btn-sm {
  color: #333333 !important;
}
.btn-sm:not(.btn-primary):not(.btn-active) {
  background: #ffffff !important;
}
.btn-sm.btn-active {
  color: #ffffff !important;
  background: #1565c0 !important;
}
.btn-primary {
  color: #ffffff !important;
  background: #4CAF50 !important;
  border-color: #4CAF50 !important;
}
.btn-primary:hover {
  background: #43a047 !important;
}
.btn-primary:disabled {
  background: #cccccc !important;
  border-color: #cccccc !important;
}
.modal-close {
  color: #666666 !important;
}
.modal-close:hover {
  color: #333333 !important;
}

/* ===== 图片放大 & 历史库 ===== */
.preview-hint {
  text-align: center;
  font-size: 12px;
  color: #999;
  margin: 6px 0 0 0;
}
.screenshot-preview img,
.preview,
.result-thumb,
.match-thumb,
.gallery-thumb,
.library-item img {
  cursor: zoom-in;
}

/* 结构化加工参数 */
.params-panel {
  margin-top: 10px;
  padding: 10px;
  background: #fff;
  border-radius: 6px;
  border: 1px solid #e0e0e0;
}
.params-panel h4 {
  margin: 0 0 8px 0;
  font-size: 13px;
  color: #333;
}
.params-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
  margin-bottom: 10px;
}
.params-table td {
  padding: 6px 8px;
  border-bottom: 1px solid #f0f0f0;
}
.params-table .param-key {
  color: #666;
  width: 120px;
  text-transform: capitalize;
}
.params-table .param-value {
  color: #1a1a2e;
  font-weight: 600;
}
.btn-apply {
  padding: 6px 14px;
  font-size: 13px;
  background: #1565c0;
  color: #fff;
  border: none;
  border-radius: 6px;
  cursor: pointer;
}
.btn-apply:disabled {
  background: #ccc;
  cursor: not-allowed;
}
.apply-msg {
  margin: 8px 0 0 0;
  font-size: 12px;
}
.apply-msg.success { color: #2e7d32; }
.apply-msg.error { color: #c62828; }

/* 历史库弹窗 */
.modal-wide {
  width: 760px;
  max-width: 92%;
}
.library-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 16px;
  max-height: 60vh;
  overflow-y: auto;
  padding-right: 4px;
}
.library-item {
  background: #f9f9f9;
  border-radius: 8px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.library-item img {
  width: 100%;
  aspect-ratio: 1;
  object-fit: cover;
  border-bottom: 1px solid #eee;
}
.library-meta {
  padding: 10px;
  flex: 1;
}
.library-name {
  font-size: 13px;
  font-weight: 600;
  margin: 0 0 4px 0;
  word-break: break-all;
}
.library-desc {
  font-size: 12px;
  color: #666;
  margin: 2px 0;
}
.library-date {
  font-size: 11px;
  color: #999;
  margin: 6px 0 0 0;
}
.library-item .delete-btn {
  margin: 0 10px 10px 10px;
  padding: 4px 10px;
  font-size: 12px;
}

/* 图片 Lightbox */
.lightbox-overlay {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background: rgba(0, 0, 0, 0.88);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2000;
}
.lightbox-img {
  max-width: 94vw;
  max-height: 92vh;
  object-fit: contain;
  border-radius: 4px;
  cursor: default;
}
.lightbox-close {
  position: absolute;
  top: 16px;
  right: 24px;
  background: none;
  border: none;
  color: #fff;
  font-size: 36px;
  cursor: pointer;
  line-height: 1;
}

.view-select {
  padding: 6px 10px;
  font-size: 13px;
  border: 1px solid #ddd;
  border-radius: 6px;
  background: #fff;
  color: #333;
  cursor: pointer;
}
</style>
