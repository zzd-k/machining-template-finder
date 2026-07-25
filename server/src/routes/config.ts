/**
 * 配置管理路由
 *   GET  /api/config          - 获取当前配置（API Key 脱敏）
 *   PUT  /api/config          - 更新配置
 *   GET  /api/config/status   - 检查是否已配置
 */

import { FastifyInstance } from 'fastify';
import { getConfig, saveConfig, isConfigured, getConfigPath } from '../services/config.js';

export async function configRoutes(fastify: FastifyInstance) {
  /** GET /api/config - 获取配置（API Key 脱敏显示） */
  fastify.get('/api/config', async (_request, reply) => {
    const config = getConfig();
    return reply.send({
      success: true,
      config: {
        siliconflowApiKey: config.siliconflowApiKey
          ? config.siliconflowApiKey.substring(0, 8) + '****' + config.siliconflowApiKey.substring(config.siliconflowApiKey.length - 4)
          : '',
        siliconflowBaseUrl: config.siliconflowBaseUrl,
        embeddingModel: config.embeddingModel,
        configured: !!config.siliconflowApiKey,
      },
      configPath: getConfigPath(),
    });
  });

  /** PUT /api/config - 更新配置 */
  fastify.put('/api/config', async (request, reply) => {
    try {
      const body = request.body as {
        siliconflowApiKey?: string;
        siliconflowBaseUrl?: string;
        embeddingModel?: string;
      };
      const updates: Record<string, string> = {};
      if (body.siliconflowApiKey !== undefined) updates.siliconflowApiKey = body.siliconflowApiKey;
      if (body.siliconflowBaseUrl !== undefined) updates.siliconflowBaseUrl = body.siliconflowBaseUrl;
      if (body.embeddingModel !== undefined) updates.embeddingModel = body.embeddingModel;
      const newConfig = saveConfig(updates);
      return reply.send({
        success: true,
        config: {
          siliconflowApiKey: newConfig.siliconflowApiKey
            ? newConfig.siliconflowApiKey.substring(0, 8) + '****' + newConfig.siliconflowApiKey.substring(newConfig.siliconflowApiKey.length - 4)
            : '',
          siliconflowBaseUrl: newConfig.siliconflowBaseUrl,
          embeddingModel: newConfig.embeddingModel,
          configured: !!newConfig.siliconflowApiKey,
        },
      });
    } catch (err) {
      return reply.status(500).send({ success: false, error: (err as Error).message });
    }
  });

  /** GET /api/config/status - 检查是否已配置 */
  fastify.get('/api/config/status', async (_request, reply) => {
    return reply.send({ success: true, configured: isConfigured() });
  });
}
