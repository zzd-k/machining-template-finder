import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load environment variables BEFORE any module that reads them at import time.
// searchRoutes -> database.ts reads process.env.MTF_DB_PATH at module load, so it
// must be dynamically imported after this call (ESM static imports are hoisted).
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

const { searchRoutes } = await import('./routes/search.js');

const PORT = parseInt(process.env.MTF_PORT || '3100', 10);
const UPLOAD_DIR = process.env.MTF_UPLOAD_DIR || './uploads';

const app = Fastify({ logger: true });

// CORS
await app.register(cors, { origin: true });

// Static files for uploaded images
await app.register(fastifyStatic, {
  root: path.join(__dirname, '..', '..', UPLOAD_DIR),
  prefix: '/uploads/',
});

// Routes
await app.register(searchRoutes);

// Health check
app.get('/api/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

// Start
try {
  await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log(`Server running on http://localhost:${PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}