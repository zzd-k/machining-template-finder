/**
 * PowerMill COM 自动化服务
 *
 * 通过 child_process 调用 PowerShell 脚本，间接操作 PowerMill COM 接口。
 * 提供：状态读取、刀具路径/刀具/特征枚举、截图导出、宏命令执行、项目变化轮询。
 *
 * 参考舅舅 pm_connector.py 的核心逻辑（ROT 连接、状态读取、命令执行），
 * 改用 PowerShell + Node.js child_process 架构，避免 native 编译依赖。
 */

import { execFile } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import { EventEmitter } from 'events';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.resolve(__dirname, '..', 'scripts', 'powermill.ps1');

// ---------- 类型定义 ----------

export interface PMStatus {
  success: boolean;
  projectName: string;
  projectPath: string;
  units: string;
  activeToolpath: string;
  activeTool: string;
  activeBoundary: string;
  activeNCProgram: string;
  toolpathCount: number;
  toolCount: number;
  timestamp: string;
  error?: string;
}

export interface PMToolpath {
  name: string;
  tool: string;
  status: string;
  strategy: string;
  feedRate: string;
  spindleSpeed: string;
}

export interface PMTool {
  name: string;
  type: string;
  diameter: string;
  length: string;
  toolNumber: string;
}

export interface PMNCProgram {
  name: string;
  toolpath: string;
  status: string;
}

export interface PMExecuteResult {
  success: boolean;
  output: string;
  command: string;
  error?: string;
}

export interface PMScreenshotResult {
  success: boolean;
  path: string;
  size: number;
  modified: string;
  error?: string;
}

/** 项目变化事件 */
export interface PMProjectChangeEvent {
  type: 'projectChanged' | 'projectOpened' | 'projectClosed' | 'toolpathChanged';
  oldProjectName: string;
  newProjectName: string;
  oldToolpath: string;
  newToolpath: string;
  timestamp: string;
}

// ---------- 内部执行函数 ----------

interface PMRawResult {
  success: boolean;
  error?: string;
  [key: string]: unknown;
}

/**
 * 调用 PowerShell 脚本执行 PowerMill 操作
 */
function runPowerShellScript(
  action: string,
  options: { command?: string; outputPath?: string } = {},
  timeout = 30000
): Promise<PMRawResult> {
  return new Promise((resolve, reject) => {
    const args = [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', SCRIPT_PATH,
      '-Action', action,
    ];

    if (options.command) {
      args.push('-Command', options.command);
    }
    if (options.outputPath) {
      args.push('-OutputPath', options.outputPath);
    }

    execFile(
      'powershell.exe',
      args,
      {
        timeout,
        maxBuffer: 10 * 1024 * 1024,  // 10MB（截图等操作可能输出较大）
        windowsHide: true,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        if (error) {
          // 超时或进程错误
          reject(new Error(`PowerShell 执行失败: ${error.message}`));
          return;
        }

        // PowerShell 可能输出 BOM 或额外换行，取最后一行 JSON
        const lines = stdout.trim().split('\n').filter(l => l.trim().startsWith('{'));
        const jsonLine = lines[lines.length - 1] || stdout.trim();

        try {
          const result = JSON.parse(jsonLine);
          resolve(result as PMRawResult);
        } catch {
          // JSON 解析失败，返回原始输出
          resolve({
            success: false,
            error: `无法解析 PowerShell 输出: ${jsonLine.substring(0, 200)}`,
          });
        }
      }
    );
  });
}

// ---------- PowerMill 服务类 ----------

/**
 * PowerMill 服务（单例）
 *
 * 封装所有 PowerMill COM 操作，提供：
 * - getStatus()       读取当前项目状态
 * - getToolpaths()    枚举刀具路径
 * - getTools()        枚举刀具
 * - getFeatures()     枚举特征
 * - getNCPrograms()   枚举 NC 程序
 * - takeScreenshot()  导出视图截图
 * - executeCommand()  执行任意宏命令
 * - startPolling()    启动项目变化轮询
 * - stopPolling()     停止轮询
 * - on()              监听项目变化事件
 */
class PowerMillService extends EventEmitter {
  private lastStatus: PMStatus | null = null;
  private pollingTimer: NodeJS.Timeout | null = null;
  private isPolling = false;

  /**
   * 读取 PowerMill 当前状态
   */
  async getStatus(): Promise<PMStatus> {
    const result = await runPowerShellScript('status');

    if (!result.success) {
      return {
        success: false,
        projectName: '',
        projectPath: '',
        units: '',
        activeToolpath: '',
        activeTool: '',
        activeBoundary: '',
        activeNCProgram: '',
        toolpathCount: 0,
        toolCount: 0,
        timestamp: new Date().toISOString(),
        error: result.error || '未知错误',
      };
    }

    const status: PMStatus = {
      success: true,
      projectName: (result.projectName as string) || '',
      projectPath: (result.projectPath as string) || '',
      units: (result.units as string) || '',
      activeToolpath: (result.activeToolpath as string) || '',
      activeTool: (result.activeTool as string) || '',
      activeBoundary: (result.activeBoundary as string) || '',
      activeNCProgram: (result.activeNCProgram as string) || '',
      toolpathCount: (result.toolpathCount as number) || 0,
      toolCount: (result.toolCount as number) || 0,
      timestamp: (result.timestamp as string) || new Date().toISOString(),
    };

    return status;
  }

  /**
   * 枚举所有刀具路径
   */
  async getToolpaths(): Promise<PMToolpath[]> {
    const result = await runPowerShellScript('toolpaths');
    if (!result.success) return [];
    return (result.toolpaths as PMToolpath[]) || [];
  }

  /**
   * 枚举所有刀具
   */
  async getTools(): Promise<PMTool[]> {
    const result = await runPowerShellScript('tools');
    if (!result.success) return [];
    return (result.tools as PMTool[]) || [];
  }

  /**
   * 枚举所有特征
   */
  async getFeatures(): Promise<string[]> {
    const result = await runPowerShellScript('features');
    if (!result.success) return [];
    const features = (result.features as Array<{ name: string }>) || [];
    return features.map(f => f.name);
  }

  /**
   * 枚举所有 NC 程序
   */
  async getNCPrograms(): Promise<PMNCProgram[]> {
    const result = await runPowerShellScript('ncprograms');
    if (!result.success) return [];
    return (result.ncprograms as PMNCProgram[]) || [];
  }

  /**
   * 导出当前视图截图
   * @param outputPath 截图保存路径（如 /uploads/screenshots/xxx.png）
   */
  async takeScreenshot(outputPath: string): Promise<PMScreenshotResult> {
    const result = await runPowerShellScript('screenshot', { outputPath }, 60000);
    return {
      success: result.success,
      path: (result.path as string) || '',
      size: (result.size as number) || 0,
      modified: (result.modified as string) || '',
      error: result.error,
    };
  }

  /**
   * 执行任意 PowerMill 宏命令
   * @param command 宏命令（如 "PRINT VALUE PROJECTPATH"）
   */
  async executeCommand(command: string): Promise<PMExecuteResult> {
    const result = await runPowerShellScript('execute', { command });
    return {
      success: result.success,
      output: (result.output as string) || '',
      command,
      error: result.error,
    };
  }

  // ---------- 项目变化轮询 ----------

  /**
   * 启动项目变化轮询
   * @param intervalMs 轮询间隔（默认 5 秒）
   */
  startPolling(intervalMs = 5000): void {
    if (this.pollingTimer) {
      console.log('[PowerMill] 轮询已在运行');
      return;
    }

    console.log(`[PowerMill] 启动轮询，间隔 ${intervalMs}ms`);
    this.isPolling = true;

    // 立即执行一次
    this.poll();

    // 定时轮询
    this.pollingTimer = setInterval(() => this.poll(), intervalMs);
  }

  /**
   * 停止轮询
   */
  stopPolling(): void {
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
      this.isPolling = false;
      console.log('[PowerMill] 轮询已停止');
    }
  }

  /**
   * 执行一次轮询检查
   */
  private async poll(): Promise<void> {
    try {
      const currentStatus = await this.getStatus();

      if (!currentStatus.success) {
        // PowerMill 未连接
        if (this.lastStatus?.success) {
          // 之前连接正常，现在断开了
          this.emit('projectClosed', {
            type: 'projectClosed',
            oldProjectName: this.lastStatus.projectName,
            newProjectName: '',
            oldToolpath: this.lastStatus.activeToolpath,
            newToolpath: '',
            timestamp: new Date().toISOString(),
          } as PMProjectChangeEvent);
        }
        this.lastStatus = currentStatus;
        return;
      }

      if (!this.lastStatus?.success) {
        // 之前未连接，现在连接成功了
        this.emit('projectOpened', {
          type: 'projectOpened',
          oldProjectName: '',
          newProjectName: currentStatus.projectName,
          oldToolpath: '',
          newToolpath: currentStatus.activeToolpath,
          timestamp: new Date().toISOString(),
        } as PMProjectChangeEvent);
      } else if (this.lastStatus.projectName !== currentStatus.projectName) {
        // 项目名变化（切换了项目）
        this.emit('projectChanged', {
          type: 'projectChanged',
          oldProjectName: this.lastStatus.projectName,
          newProjectName: currentStatus.projectName,
          oldToolpath: this.lastStatus.activeToolpath,
          newToolpath: currentStatus.activeToolpath,
          timestamp: new Date().toISOString(),
        } as PMProjectChangeEvent);
      } else if (this.lastStatus.activeToolpath !== currentStatus.activeToolpath) {
        // 同一项目内，激活的刀具路径变化
        this.emit('toolpathChanged', {
          type: 'toolpathChanged',
          oldProjectName: this.lastStatus.projectName,
          newProjectName: currentStatus.projectName,
          oldToolpath: this.lastStatus.activeToolpath,
          newToolpath: currentStatus.activeToolpath,
          timestamp: new Date().toISOString(),
        } as PMProjectChangeEvent);
      }

      this.lastStatus = currentStatus;
    } catch (err) {
      console.error('[PowerMill] 轮询出错:', err);
    }
  }

  /**
   * 获取上次轮询的状态（不触发新的 COM 调用）
   */
  getLastStatus(): PMStatus | null {
    return this.lastStatus;
  }

  /**
   * 是否正在轮询
   */
  get isRunning(): boolean {
    return this.isPolling;
  }
}

// 导出单例
const powerMillService = new PowerMillService();
export default powerMillService;
