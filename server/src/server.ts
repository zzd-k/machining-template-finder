import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import fs from 'fs';
import multipart from '@fastify/multipart';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load environment variables BEFORE any module that reads them at import time.
// searchRoutes -> database.ts reads process.env.MTF_DB_PATH at module load, so it
// must be dynamically imported after this call (ESM static imports are hoisted).
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

const { configRoutes } = await import('./routes/config.js');
const { searchRoutes } = await import('./routes/search.js');
const { powermillRoutes } = await import('./routes/powermill.js');
const { default: powerMillService } = await import('./services/powermill.js');

const PORT = parseInt(process.env.MTF_PORT || '3100', 10);
const UPLOAD_DIR = process.env.MTF_UPLOAD_DIR || './uploads';

const app = Fastify({ logger: true });

// CORS
await app.register(cors, { origin: true });

// Multipart support for file uploads
await app.register(multipart, {
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
});

// Static files for uploaded images
// 注意：UPLOAD_DIR 可能是绝对路径（打包后由 Electron 注入 userData 路径），
// path.join 会把绝对路径当字符串拼接产生无效路径，必须用 path.isAbsolute 判断
const UPLOAD_ROOT = path.isAbsolute(UPLOAD_DIR)
  ? UPLOAD_DIR
  : path.join(__dirname, '..', '..', UPLOAD_DIR);
if (!fs.existsSync(UPLOAD_ROOT)) {
  fs.mkdirSync(UPLOAD_ROOT, { recursive: true });
}
await app.register(fastifyStatic, {
  root: UPLOAD_ROOT,
  prefix: '/uploads/',
});

// Routes (config first, so API key is available to other routes)
await app.register(configRoutes);
await app.register(searchRoutes);
await app.register(powermillRoutes);

// Health check
app.get('/api/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

// Start
try {
  await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log(`Server running on http://localhost:${PORT}`);

  // Start background auto-polling (every 15s) to keep status cache warm
  powerMillService.startAutoPolling(15000);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}