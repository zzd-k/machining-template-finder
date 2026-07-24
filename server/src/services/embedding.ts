import axios from 'axios';
import fs from 'fs';

const API_KEY = process.env.MTF_SILICONFLOW_API_KEY!;
const BASE_URL = process.env.MTF_SILICONFLOW_BASE_URL || 'https://api.siliconflow.cn/v1';
const MODEL = process.env.MTF_EMBEDDING_MODEL || 'Qwen/Qwen3-VL-Embedding-8B';

/**
 * 将图片文件转为 base64
 */
function imageToBase64(filePath: string): string {
  const buffer = fs.readFileSync(filePath);
  return buffer.toString('base64');
}

/**
 * 调用 SiliconFlow API 获取图片的向量嵌入
 * 支持 image URL 和 base64 格式
 */
export async function getImageEmbedding(imageInput: { url?: string; filePath?: string }): Promise<number[]> {
  let input: string;

  if (imageInput.filePath) {
    const base64 = imageToBase64(imageInput.filePath);
    // Detect mime type
    const ext = imageInput.filePath.split('.').pop()?.toLowerCase();
    const mime = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : 'image/jpeg';
    input = `data:${mime};base64,${base64}`;
  } else if (imageInput.url) {
    input = imageInput.url;
  } else {
    throw new Error('Must provide either url or filePath');
  }

  const response = await axios.post(
    `${BASE_URL}/embeddings`,
    {
      model: MODEL,
      input,
      encoding_format: 'float',
    },
    {
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    }
  );

  return response.data.data[0].embedding;
}

/**
 * 计算两个向量的余弦相似度
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error('Vector dimensions must match');
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}
