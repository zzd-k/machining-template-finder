import { FastifyInstance } from 'fastify';
import db from '../db/database.js';
import { getImageEmbedding, cosineSimilarity } from '../services/embedding.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pipeline } from 'stream/promises';
import { randomUUID } from 'crypto';
import { exec } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const UPLOAD_DIR = path.resolve(PROJECT_ROOT, process.env.MTF_UPLOAD_DIR || './uploads');

export async function searchRoutes(fastify: FastifyInstance) {
  // 确保上传目录存在
  const drawingsDir = path.join(UPLOAD_DIR, 'drawings');
  const toolpathsDir = path.join(UPLOAD_DIR, 'toolpaths');
  if (!fs.existsSync(drawingsDir)) fs.mkdirSync(drawingsDir, { recursive: true });
  if (!fs.existsSync(toolpathsDir)) fs.mkdirSync(toolpathsDir, { recursive: true });

  /**
   * POST /api/drawings/upload
   * 上传图纸到数据库，自动提取向量
   * Body: multipart form
   *   - file: 图片文件
   *   - description: 描述（可选）
   *   - material: 材料（可选）
   *   - machining_params: 加工参数 JSON（可选）
   */
  fastify.post('/api/drawings/upload', async (request, reply) => {
    const data = await request.file();
    if (!data) {
      return reply.status(400).send({ error: 'No file uploaded' });
    }

    // Get form fields
    const fields = data.fields as Record<string, { value: string }>;
    const description = fields?.description?.value || '';
    const material = fields?.material?.value || '';
    const machiningParams = fields?.machining_params?.value || '{}';

    // Save file
    const fileId = randomUUID();
    const ext = path.extname(data.filename);
    const savedFilename = `${fileId}${ext}`;
    const savedPath = path.join(drawingsDir, savedFilename);

    await pipeline(
      data.file,
      fs.createWriteStream(savedPath)
    );

    // Extract embedding
    let embedding: number[] | null = null;
    try {
      embedding = await getImageEmbedding({ filePath: savedPath });
    } catch (err) {
      console.error('Embedding extraction failed:', err);
    }

    // Save to database
    const embeddingBuffer = embedding
      ? Buffer.from(new Float32Array(embedding).buffer)
      : null;

    const result = db.prepare(`
      INSERT INTO drawings (filename, original_path, description, material, machining_params, embedding, embedding_dim)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      data.filename,
      savedPath,
      description,
      material,
      machiningParams,
      embeddingBuffer,
      embedding?.length || null
    );

    return reply.send({
      success: true,
      id: result.lastInsertRowid,
      filename: data.filename,
      hasEmbedding: !!embedding,
    });
  });

  /**
   * POST /api/search
   * 上传一张图纸，搜索最相似的历史图纸
   * Body: multipart form
   *   - file: 图片文件
   *   - topK: 返回最相似的 N 张（默认 5）
   */
  fastify.post('/api/search', async (request, reply) => {
    const data = await request.file();
    if (!data) {
      return reply.status(400).send({ error: 'No file uploaded' });
    }

    const fields = data.fields as Record<string, { value: string }>;
    const topK = parseInt(fields?.topK?.value || '5', 10);

    // Save temp file for embedding extraction
    const tempPath = path.join(drawingsDir, `temp_${randomUUID()}${path.extname(data.filename)}`);
    await pipeline(data.file, fs.createWriteStream(tempPath));

    // Extract embedding of query image
    let queryEmbedding: number[];
    try {
      queryEmbedding = await getImageEmbedding({ filePath: tempPath });
    } catch (err) {
      fs.unlinkSync(tempPath);
      return reply.status(500).send({ error: 'Failed to extract embedding from query image' });
    } finally {
      // Clean up temp file
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    }

    // Search in database
    const rows = db.prepare('SELECT * FROM drawings WHERE embedding IS NOT NULL').all() as Array<{
      id: number;
      filename: string;
      original_path: string;
      thumbnail_path: string | null;
      description: string;
      material: string;
      machining_params: string;
      embedding: Uint8Array | Buffer;
      embedding_dim: number;
      created_at: string;
    }>;

    // Calculate similarities
    const results = rows.map((row) => {
      const storedEmbedding = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding_dim);
      const similarity = cosineSimilarity(queryEmbedding, Array.from(storedEmbedding));
      return {
        id: row.id,
        filename: row.filename,
        description: row.description,
        material: row.material,
        machining_params: JSON.parse(row.machining_params || '{}'),
        similarity: Math.round(similarity * 10000) / 10000,  // 保留4位小数
        created_at: row.created_at,
      };
    });

    // Sort by similarity descending, take top K
    results.sort((a, b) => b.similarity - a.similarity);
    const topResults = results.slice(0, topK);

    return reply.send({
      query: data.filename,
      totalInDb: rows.length,
      results: topResults,
    });
  });

  /**
   * GET /api/drawings
   * 列出所有已上传的图纸
   */
  fastify.get('/api/drawings', async (_request, reply) => {
    const rows = db.prepare('SELECT id, filename, description, material, created_at FROM drawings ORDER BY created_at DESC').all();
    return reply.send({ drawings: rows });
  });

  /**
   * POST /api/drawings/from-screenshot
   * 将已截取的 PowerMill 截图保存到图库
   * Body: { filename: string, description?: string, material?: string }
   */
  fastify.post<{ Body: { filename?: string; description?: string; material?: string } }>('/api/drawings/from-screenshot', async (request, reply) => {
    const { filename, description = '', material = '' } = request.body || {};
    if (!filename || filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      return reply.status(400).send({ success: false, error: 'Invalid filename' });
    }
    const screenshotPath = path.join(UPLOAD_DIR, 'screenshots', filename);
    if (!fs.existsSync(screenshotPath)) {
      return reply.status(404).send({ success: false, error: 'Screenshot not found' });
    }

    const fileId = randomUUID();
    const savedFilename = `${fileId}.png`;
    const savedPath = path.join(drawingsDir, savedFilename);
    fs.copyFileSync(screenshotPath, savedPath);

    let embedding: number[] | null = null;
    try {
      embedding = await getImageEmbedding({ filePath: savedPath });
    } catch (err) {
      console.error('Embedding extraction failed:', err);
    }

    const embeddingBuffer = embedding
      ? Buffer.from(new Float32Array(embedding).buffer)
      : null;

    const result = db.prepare(`
      INSERT INTO drawings (filename, original_path, description, material, machining_params, embedding, embedding_dim)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      filename,
      savedPath,
      description,
      material,
      '{}',
      embeddingBuffer,
      embedding?.length || null
    );

    return reply.send({
      success: true,
      id: result.lastInsertRowid,
      filename,
      hasEmbedding: !!embedding,
    });
  });

  /**
   * POST /api/drawings/folder
   * 打开图库所在文件夹
   */
  fastify.post('/api/drawings/folder', async (_request, reply) => {
    try {
      if (!fs.existsSync(UPLOAD_DIR)) {
        fs.mkdirSync(UPLOAD_DIR, { recursive: true });
      }
      if (process.platform === 'win32') {
        exec(`explorer "${UPLOAD_DIR}"`);
      } else if (process.platform === 'darwin') {
        exec(`open "${UPLOAD_DIR}"`);
      } else {
        exec(`xdg-open "${UPLOAD_DIR}"`);
      }
      return reply.send({ success: true, path: UPLOAD_DIR });
    } catch (err) {
      return reply.status(500).send({ success: false, error: String(err) });
    }
  });

  /**
   * DELETE /api/drawings/:id
   * 删除指定图纸
   */
  fastify.delete<{ Params: { id: string } }>('/api/drawings/:id', async (request, reply) => {
    const { id } = request.params;
    const row = db.prepare('SELECT original_path FROM drawings WHERE id = ?').get(id) as { original_path: string } | undefined;
    if (!row) {
      return reply.status(404).send({ error: 'Drawing not found' });
    }
    // Delete file
    if (fs.existsSync(row.original_path)) {
      fs.unlinkSync(row.original_path);
    }
    db.prepare('DELETE FROM drawings WHERE id = ?').run(id);
    return reply.send({ success: true });
  });

  /**
   * GET /api/drawings/:id/image
   * 获取图纸图片
   */
  fastify.get<{ Params: { id: string } }>('/api/drawings/:id/image', async (request, reply) => {
    const { id } = request.params;
    const row = db.prepare('SELECT original_path, filename FROM drawings WHERE id = ?').get(id) as { original_path: string; filename: string } | undefined;
    if (!row || !fs.existsSync(row.original_path)) {
      return reply.status(404).send({ error: 'Image not found' });
    }
    const ext = path.extname(row.filename).toLowerCase();
    const contentType = ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : 'image/jpeg';
    reply.type(contentType);
    return fs.createReadStream(row.original_path);
  });
}
