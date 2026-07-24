<script setup lang="ts">
import { ref, onMounted } from 'vue'

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
  const res = await fetch('/api/drawings')
  const data = await res.json()
  drawings.value = data.drawings || []
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
    const res = await fetch('/api/drawings/upload', { method: 'POST', body: formData })
    await res.json()
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

onMounted(fetchDrawings)
</script>

<template>
  <div class="app">
    <header>
      <h1>CNC 图纸智能匹配系统</h1>
    </header>

    <main>
      <!-- 上传区域 -->
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

      <!-- 搜索区域 -->
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

      <!-- 图库列表 -->
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
.app { max-width: 1200px; margin: 0 auto; padding: 20px; }
header { text-align: center; margin-bottom: 30px; }
h1 { color: #333; }
.card { background: #f5f5f5; border-radius: 8px; padding: 20px; margin-bottom: 20px; }
.upload-area { display: flex; gap: 15px; align-items: center; margin-bottom: 10px; }
.preview { max-width: 200px; max-height: 150px; border-radius: 4px; }
.form-row { display: flex; gap: 10px; margin-bottom: 10px; }
.form-row input { flex: 1; padding: 8px; border: 1px solid #ddd; border-radius: 4px; }
button { padding: 8px 20px; background: #4CAF50; color: white; border: none; border-radius: 4px; cursor: pointer; }
button:disabled { background: #ccc; cursor: not-allowed; }
.results { margin-top: 15px; }
.result-item { display: flex; gap: 10px; margin-bottom: 10px; padding: 10px; background: white; border-radius: 4px; }
.result-thumb { width: 80px; height: 80px; object-fit: cover; border-radius: 4px; }
.gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 15px; }
.gallery-item { text-align: center; }
.gallery-thumb { width: 100%; aspect-ratio: 1; object-fit: cover; border-radius: 4px; }
.delete-btn { background: #f44336; font-size: 12px; padding: 4px 10px; }
</style>
