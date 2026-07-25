import axios from 'axios';
import fs from 'fs';
import { getConfig } from './config.js';

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
 * API Key 从运行时配置读取（非环境变量常量）
 */
export async function getImageEmbedding(imageInput: { url?: string; filePath?: string }): Promise<number[]> {
  const config = getConfig();
  if (!config.siliconflowApiKey) {
    throw new Error('未配置 SiliconFlow API Key，请在设置中填写');
  }

  let input: string;
  if (imageInput.filePath) {
    const base64 = imageToBase64(imageInput.filePath);
    const ext = imageInput.filePath.split('.').pop()?.toLowerCase();
    const mime = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : 'image/jpeg';
    input = `data:${mime};base64,${base64}`;
  } else if (imageInput.url) {
    input = imageInput.url;
  } else {
    throw new Error('Must provide either url or filePath');
  }

  const response = await axios.post(
    `${config.siliconflowBaseUrl}/embeddings`,
    {
      model: config.embeddingModel,
      input,
      encoding_format: 'float',
    },
    {
      headers: {
        'Authorization': `Bearer ${config.siliconflowApiKey}`,
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
