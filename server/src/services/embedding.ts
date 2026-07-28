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
 *
 * Qwen/Qwen3-VL-Embedding-8B 要求 VL 格式请求：
 *   input 必须是对象 {"image": "<url-or-base64>"} 或 {"text": "..."}
 * 而非经典格式的纯字符串。
 *
 * 支持 image URL 和 base64 格式。
 * API Key 从运行时配置读取（非环境变量常量）
 */
export async function getImageEmbedding(imageInput: { url?: string; filePath?: string }): Promise<number[]> {
  const config = getConfig();
  if (!config.siliconflowApiKey) {
    throw new Error('未配置 SiliconFlow API Key，请在设置中填写');
  }

  let imageValue: string;
  if (imageInput.filePath) {
    const base64 = imageToBase64(imageInput.filePath);
    const ext = imageInput.filePath.split('.').pop()?.toLowerCase();
    const mime = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : 'image/jpeg';
    imageValue = `data:${mime};base64,${base64}`;
  } else if (imageInput.url) {
    imageValue = imageInput.url;
  } else {
    throw new Error('Must provide either url or filePath');
  }

  // 截图可能很大，记录大小用于调试
  const imageParam = imageInput.filePath
    ? `${imageValue.substring(0, 50)}... (${(imageValue.length / 1024).toFixed(0)}KB base64)`
    : imageInput.url;
  console.log(`[embedding] 调用 SiliconFlow API, model=${config.embeddingModel}, image=${imageParam}`);

  try {
    const response = await axios.post(
      `${config.siliconflowBaseUrl}/embeddings`,
      {
        model: config.embeddingModel,
        // VL 格式：image 输入必须放在对象中，不能直接传字符串
        input: { image: imageValue },
        encoding_format: 'float',
      },
      {
        headers: {
          'Authorization': `Bearer ${config.siliconflowApiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 60000,
      }
    );

    return response.data.data[0].embedding;
  } catch (err: any) {
    // 提取 SiliconFlow 返回的详细错误信息
    const status = err?.response?.status || 'N/A';
    const errorData = err?.response?.data;
    const errorMsg = errorData
      ? (typeof errorData === 'string' ? errorData : JSON.stringify(errorData))
      : err.message;
    console.error(`[embedding] API 调用失败 (HTTP ${status}): ${errorMsg}`);
    throw new Error(`SiliconFlow API 返回 ${status}: ${errorMsg.substring(0, 200)}`);
  }
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
