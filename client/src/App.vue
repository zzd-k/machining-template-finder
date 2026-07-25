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
            <label>SiliconFlow API Key</label>
            <input v-model="settingsInput.siliconflowApiKey" type="password" :placeholder="settingsConfig.configured ? '已配置（输入新值可替换）' : '请输入 API Key'" />
            <p class="form-hint">获取地址：https://cloud.siliconflow.cn</p>
          </div>
          <div class="form-group">
            <label>API Base URL</label>
            <input v-model="settingsInput.siliconflowBaseUrl" />
          </div>
          <div class="form-group">
            <label>Embedding 模型</label>
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

      <!-- ====== 全局识别结果 ====== -->
      <section v-if="recognizeResult || recognizeError" class="card recognize-panel">
        <h2>全局识别结果</h2>
        <div v-if="recognizeError" class="error-msg">{{ recognizeError }}</div>
        <div v-if="recognizeResult">
          <div class="recognize-summary">
            <div class="rec-stat">
              <span class="rec-label">项目</span>
              <span class="rec-value">{{ recognizeResult.project.name || '-' }}</span>
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
            <img :src="recognizeResult.screenshot.url" alt="PowerMill 视图截图" />
          </div>

          <div v-if="recognizeResult.matches.length" class="recognize-matches">
            <h3>相似图纸匹配 (Top {{ recognizeResult.matches.length }})</h3>
            <div v-for="m in recognizeResult.matches" :key="m.id" class="match-item"
                 :class="{ 'match-best': m.similarity > 0.8 }">
              <img :src="`/api/drawings/${m.id}/image`" class="match-thumb" />
              <div class="match-info">
                <p><strong>{{ m.filename }}</strong></p>
                <p>相似度: <span class="sim-value">{{ (m.similarity * 100).toFixed(1) }}%</span></p>
                <p v-if="m.material">材料: {{ m.material }}</p>
                <p v-if="m.description">{{ m.description }}</p>
                <details v-if="Object.keys(m.machining_params).length">
                  <summary>推荐加工参数</summary>
                  <pre class="params-pre">{{ JSON.stringify(m.machining_params, null, 2) }}</pre>
                </details>
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
</style>
