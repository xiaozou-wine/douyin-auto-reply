import fs from 'node:fs';
import path from 'node:path';
import { runtimePath } from './paths.js';

/**
 * 生成失败截图路径，并清理文件名中的特殊字符，避免跨平台路径问题。
 */
export function screenshotPath(name: string, now = new Date()): string {
  const safeName = name.replace(/[^a-zA-Z0-9._-]+/g, '-');
  const timestamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const dir = runtimePath('screenshots');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${timestamp}-${safeName}.png`);
}
