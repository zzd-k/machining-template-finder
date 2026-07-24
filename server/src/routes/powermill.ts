/**
 * PowerMill API 路由
 *
 * 暴露 PowerMill COM 操作的 HTTP 接口：
 *   GET  /api/powermill/status          - 获取当前项目状态
 *   GET  /api/powermill/toolpaths       - 枚举刀具路径
 *   GET  /api/powermill/tools           - 枚举刀具
 *   GET  /api/powermill/features        - 枚举特征
 *   GET  /api/powermill/ncprograms      - 枚举 NC 程序
 *   POST /api/powermill/screenshot       - 导出当前视图截图
 *   POST /api/powermill/execute          - 执行宏命令
 *   POST /api/powermill/polling/start    - 启动项目变化轮询
 *   POST /api/powermill/polling/stop     - 停止轮询
 *   GET  /api/powermill/polling/status   - 获取轮询状态
 *   GET  /api/powermill/events           - SSE 实时事件流
 */

import { FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import powerMillService from '../services/powermill.js';
import type { PMProjectChangeEvent } from '../services/powermill.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const UPLOAD_DIR = path.resolve(PROJECT_ROOT, process.env.MTF_UPLOAD_DIR || './uploads');

export async function powermillRoutes(fastify: FastifyInstance) {
  // 确保截图目录存在
  const screenshotDir = path.join(UPLOAD_DIR, 'screenshots');
  if (!fs.existsSync(screenshotDir)) {
    fs.mkdirSync(screenshotDir, { recursive: true });
  }

  /**
   * GET /api/powermill/status
   * 获取 PowerMill 当前项目状态
   */
  fastify.get('/api/powermill/status', async (_request, reply) => {
    try {
      const status = await powerMillService.getStatus();
      return reply.send(status);
    } catch (err) {
      return reply.status(500).send({
        success: false,
        error: `获取状态失败: ${(err as Error).message}`,
      });
    }
  });

  /**
   * GET /api/powermill/toolpaths
   * 枚举所有刀具路径
   */
  fastify.get('/api/powermill/toolpaths', async (_request, reply) => {
    try {
      const toolpaths = await powerMillService.getToolpaths();
      return reply.send({ success: true, toolpaths, count: toolpaths.length });
    } catch (err) {
      return reply.status(500).send({
        success: false,
        error: `获取刀具路径失败: ${(err as Error).message}`,
      });
    }
  });

  /**
   * GET /api/powermill/tools
   * 枚举所有刀具
   */
  fastify.get('/api/powermill/tools', async (_request, reply) => {
    try {
      const tools = await powerMillService.getTools();
      return reply.send({ success: true, tools, count: tools.length });
    } catch (err) {
      return reply.status(500).send({
        success: false,
        error: `获取刀具失败: ${(err as Error).message}`,
      });
    }
  });

  /**
   * GET /api/powermill/features
   * 枚举所有特征
   */
  fastify.get('/api/powermill/features', async (_request, reply) => {
    try {
      const features = await powerMillService.getFeatures();
      return reply.send({ success: true, features, count: features.length });
    } catch (err) {
      return reply.status(500).send({
        success: false,
        error: `获取特征失败: ${(err as Error).message}`,
      });
    }
  });

  /**
   * GET /api/powermill/ncprograms
   * 枚举所有 NC 程序
   */
  fastify.get('/api/powermill/ncprograms', async (_request, reply) => {
    try {
      const ncprograms = await powerMillService.getNCPrograms();
      return reply.send({ success: true, ncprograms, count: ncprograms.length });
    } catch (err) {
      return reply.status(500).send({
        success: false,
        error: `获取 NC 程序失败: ${(err as Error).message}`,
      });
    }
  });

  /**
   * POST /api/powermill/screenshot
   * 导出当前视图截图
   * Body: { filename?: string }  可选自定义文件名
   */
  fastify.post('/api/powermill/screenshot', async (request, reply) => {
    try {
      const body = request.body as { filename?: string } | null;
      const filename = body?.filename || `${randomUUID()}.png`;
      const outputPath = path.join(screenshotDir, filename);

      const result = await powerMillService.takeScreenshot(outputPath);

      if (result.success) {
        return reply.send({
          success: true,
          filename,
          url: `/uploads/screenshots/${filename}`,
          size: result.size,
        });
      } else {
        return reply.status(500).send(result);
      }
    } catch (err) {
      return reply.status(500).send({
        success: false,
        error: `截图失败: ${(err as Error).message}`,
      });
    }
  });

  /**
   * POST /api/powermill/execute
   * 执行任意 PowerMill 宏命令
   * Body: { command: string }
   */
  fastify.post('/api/powermill/execute', async (request, reply) => {
    try {
      const body = request.body as { command?: string };
      if (!body?.command) {
        return reply.status(400).send({ success: false, error: '必须提供 command 字段' });
      }

      const result = await powerMillService.executeCommand(body.command);
      return reply.send(result);
    } catch (err) {
      return reply.status(500).send({
        success: false,
        error: `执行命令失败: ${(err as Error).message}`,
      });
    }
  });

  /**
   * POST /api/powermill/polling/start
   * 启动项目变化轮询
   * Body: { interval?: number }  轮询间隔（毫秒），默认 5000
   */
  fastify.post('/api/powermill/polling/start', async (request, reply) => {
    try {
      const body = request.body as { interval?: number } | null;
      const interval = body?.interval || 5000;
      powerMillService.startPolling(interval);
      return reply.send({
        success: true,
        message: '轮询已启动',
        interval,
      });
    } catch (err) {
      return reply.status(500).send({
        success: false,
        error: `启动轮询失败: ${(err as Error).message}`,
      });
    }
  });

  /**
   * POST /api/powermill/polling/stop
   * 停止项目变化轮询
   */
  fastify.post('/api/powermill/polling/stop', async (_request, reply) => {
    powerMillService.stopPolling();
    return reply.send({ success: true, message: '轮询已停止' });
  });

  /**
   * GET /api/powermill/polling/status
   * 获取轮询状态和上次轮询结果
   */
  fastify.get('/api/powermill/polling/status', async (_request, reply) => {
    return reply.send({
      success: true,
      isPolling: powerMillService.isRunning,
      lastStatus: powerMillService.getLastStatus(),
    });
  });

  /**
   * GET /api/powermill/events
   * SSE (Server-Sent Events) 实时事件流
   * 当项目变化（切换、打开、关闭、刀具路径变化）时推送事件
   */
  fastify.get('/api/powermill/events', async (request, reply) => {
    // 设置 SSE 响应头
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    // 发送初始连接确认
    reply.raw.write('event: connected\ndata: {"status":"connected"}\n\n');

    // 监听项目变化事件
    const eventTypes = ['projectChanged', 'projectOpened', 'projectClosed', 'toolpathChanged'];
    const handlers: Array<(event: PMProjectChangeEvent) => void> = [];

    for (const type of eventTypes) {
      const handler = (event: PMProjectChangeEvent) => {
        reply.raw.write(`event: ${type}\ndata: ${JSON.stringify(event)}\n\n`);
      };
      powerMillService.on(type, handler);
      handlers.push(handler);
    }

    // 心跳，保持连接
    const heartbeat = setInterval(() => {
      reply.raw.write(': heartbeat\n\n');
    }, 30000);

    // 客户端断开时清理
    request.raw.on('close', () => {
      clearInterval(heartbeat);
      for (let i = 0; i < eventTypes.length; i++) {
        powerMillService.removeListener(eventTypes[i], handlers[i]);
      }
    });
  });
}
