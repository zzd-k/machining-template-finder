/**
 * 配置服务 - 管理用户运行时配置（API Key 等）
 *
 * 配置文件路径由环境变量 MTF_CONFIG_PATH 指定（Electron 主进程设置），
 * 默认回退到项目根目录的 data/config.json。
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CONFIG_PATH = process.env.MTF_CONFIG_PATH ||
  path.resolve(__dirname, '..', '..', '..', 'data', 'config.json');

export interface AppConfig {
  siliconflowApiKey: string;
  siliconflowBaseUrl: string;
  embeddingModel: string;
}

const DEFAULT_CONFIG: AppConfig = {
  siliconflowApiKey: 'sk-texuxcwmtttsqhrtljmvvohgqgxqitqusatvzgyehzdfjzqv',
  siliconflowBaseUrl: 'https://api.siliconflow.cn/v1',
  embeddingModel: 'Qwen/Qwen3-VL-Embedding-8B',
};

let cachedConfig: AppConfig | null = null;

function ensureConfigDir(): void {
  const dir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadFromEnv(): Partial<AppConfig> {
  const env: Partial<AppConfig> = {};
  if (process.env.MTF_SILICONFLOW_API_KEY) env.siliconflowApiKey = process.env.MTF_SILICONFLOW_API_KEY;
  if (process.env.MTF_SILICONFLOW_BASE_URL) env.siliconflowBaseUrl = process.env.MTF_SILICONFLOW_BASE_URL;
  if (process.env.MTF_EMBEDDING_MODEL) env.embeddingModel = process.env.MTF_EMBEDDING_MODEL;
  return env;
}

export function getConfig(): AppConfig {
  if (cachedConfig) return cachedConfig;
  let fileConfig: Partial<AppConfig> = {};
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      fileConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    }
  } catch (err) {
    console.error('[config] 读取配置失败:', err);
  }
  const envConfig = loadFromEnv();
  cachedConfig = { ...DEFAULT_CONFIG, ...envConfig, ...fileConfig };
  return cachedConfig;
}

export function saveConfig(updates: Partial<AppConfig>): AppConfig {
  const newConfig: AppConfig = { ...getConfig(), ...updates };
  ensureConfigDir();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(newConfig, null, 2), 'utf8');
  cachedConfig = newConfig;
  process.env.MTF_SILICONFLOW_API_KEY = newConfig.siliconflowApiKey;
  process.env.MTF_SILICONFLOW_BASE_URL = newConfig.siliconflowBaseUrl;
  process.env.MTF_EMBEDDING_MODEL = newConfig.embeddingModel;
  console.log('[config] 配置已保存:', CONFIG_PATH);
  return newConfig;
}

export function isConfigured(): boolean {
  return !!getConfig().siliconflowApiKey;
}

export function getConfigPath(): string {
  return CONFIG_PATH;
}
