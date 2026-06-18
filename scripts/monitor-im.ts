/**
 * 抖音私信监听脚本（完整版）
 *
 * 直接用 cookie 调抖音 IM API，不需要浏览器常驻。
 * Linux / Windows 均可运行。
 *
 * 功能：
 *   1. 每 5 分钟轮询未读 → 自动回复
 *   2. 超过指定时间未回复 → 补发
 *   3. 当天无私信时，在指定时间主动发一条
 *   4. 定时清理过期数据和日志
 *
 * 用法：
 *   cp .env.example .env  # 填入配置
 *   npx tsx scripts/monitor-im.ts
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const LOG_DIR = path.join(ROOT, 'logs');
const STATE_FILE = path.join(DATA_DIR, 'monitor-state.json');

// 请求超时（毫秒）
const REQUEST_TIMEOUT_MS = 30_000;

// ─── 工具函数 ─────────────────────────────────────────────

function loadEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    process.env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
}

/** 日志：同时输出到控制台和日志文件 */
function log(msg: string) {
  const ts = new Date().toLocaleString('zh-CN', { hour12: false });
  const line = `[${ts}] ${msg}`;
  console.log(line);

  // 写入日志文件（按天分割）
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    const dateStr = new Date().toISOString().slice(0, 10);
    fs.appendFileSync(path.join(LOG_DIR, `monitor-${dateStr}.log`), line + '\n');
  } catch (err) {
    // 日志写入失败时输出警告到控制台，方便排查磁盘满等问题
    console.warn(`[日志写入失败] ${err}`);
  }
}

interface Config {
  watchFriends: string[];
  maxWaitHours: number;
  defaultReply: string;
  /** 自动回复图片路径（本地文件），留空则用文本回复 */
  replyImagePath: string;
  proactiveTargetId: string;
  proactiveText: string;
  proactiveHour: number;
  /** 主动发信图片路径（本地文件），留空则用文本 */
  proactiveImagePath: string;
  cleanupKeepDays: number;
}

/** 安全解析整数，NaN 时返回默认值 */
function safeParseInt(val: string | undefined, fallback: number): number {
  if (!val) return fallback;
  const n = parseInt(val, 10);
  return Number.isNaN(n) ? fallback : n;
}

function getConfig(): Config {
  // 安全解析 JSON，防止用户输入非法格式导致进程崩溃
  let watchFriends: string[] = [];
  try {
    watchFriends = JSON.parse(process.env.MONITOR_WATCH_FRIENDS || '[]') as string[];
  } catch (err) {
    console.warn(`⚠ MONITOR_WATCH_FRIENDS 格式错误，使用空数组: ${err}`);
  }

  return {
    watchFriends,
    maxWaitHours: safeParseInt(process.env.MONITOR_MAX_WAIT_HOURS, 23),
    defaultReply: process.env.MONITOR_DEFAULT_REPLY || '收到，稍后回复你~',
    // 自动回复图片（优先于文本）
    replyImagePath: process.env.MONITOR_REPLY_IMAGE_PATH || '',
    // 主动发信配置
    proactiveTargetId: process.env.MONITOR_PROACTIVE_TARGET_ID || '',
    proactiveText: process.env.MONITOR_PROACTIVE_TEXT || '今天过得怎么样？',
    proactiveHour: safeParseInt(process.env.MONITOR_PROACTIVE_HOUR, 20),
    // 主动发信图片（优先于文本）
    proactiveImagePath: process.env.MONITOR_PROACTIVE_IMAGE_PATH || '',
    // 磁盘清理：保留天数
    cleanupKeepDays: safeParseInt(process.env.MONITOR_CLEANUP_KEEP_DAYS, 7),
  };
}

// ─── 状态管理 ─────────────────────────────────────────────

interface MonitorState {
  today: string;
  /** 当天回复过的会话 { convId: true } */
  sentToday: Record<string, boolean>;
  /** 等待回复的会话 { convId: 首次发现未读的时间戳(毫秒) } */
  pendingReplies: Record<string, number>;
  /** 当天是否收到过任何私信 */
  receivedToday: boolean;
  /** 当天是否已执行主动发信 */
  proactiveSentToday: boolean;
  lastCheckTime: number;
}

function loadState(): MonitorState {
  // 在整个进程生命周期内固定今天的日期，避免轮询过程中日期翻转导致状态错乱
  const today = new Date().toISOString().slice(0, 10);
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    // 日期翻转 → 重置当日状态
    if (s.today !== today) {
      return {
        today,
        sentToday: {},
        pendingReplies: {},
        receivedToday: false,
        proactiveSentToday: false,
        lastCheckTime: 0,
      };
    }
    // 兼容旧版状态文件（缺少新字段）
    return {
      today,
      sentToday: s.sentToday || {},
      pendingReplies: s.pendingReplies || {},
      receivedToday: s.receivedToday ?? false,
      proactiveSentToday: s.proactiveSentToday ?? false,
      lastCheckTime: s.lastCheckTime || 0,
    };
  } catch {
    return {
      today,
      sentToday: {},
      pendingReplies: {},
      receivedToday: false,
      proactiveSentToday: false,
      lastCheckTime: 0,
    };
  }
}

function saveState(state: MonitorState) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ─── HTTP 请求 ────────────────────────────────────────────

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

function getCookie(): string {
  const c = process.env.DOUYIN_COOKIE;
  if (!c) {
    console.error('❌ 请在 .env 中设置 DOUYIN_COOKIE');
    console.error('   浏览器 F12 → Network → 任意请求 → Headers → Cookie');
    process.exit(1);
  }
  return c;
}

/** API 错误响应结构 */
interface ApiResponse {
  status_code?: number;
  status_msg?: string;
  error_code?: number;
  [key: string]: any;
}

/** 检查 API 响应是否为业务错误（如 cookie 过期） */
function checkApiBusinessError(data: ApiResponse | null, url: string): boolean {
  if (!data) return false;
  // 常见的 cookie 过期/token 无效错误码
  if (data.status_code !== undefined && data.status_code !== 0 && data.status_code !== 200) {
    log(`  ⚠ API 业务错误 [${url}]: status_code=${data.status_code}, msg=${data.status_msg || 'N/A'}`);
    // 20003, 20004 等通常表示 cookie/token 问题
    if (data.status_code === 20003 || data.status_code === 20004 || data.error_code === 10002) {
      log(`  ❌ Cookie 可能已过期，请更新 DOUYIN_COOKIE`);
    }
    return true;
  }
  return false;
}

/** GET 请求，返回 JSON 或 null */
async function apiGet(url: string): Promise<ApiResponse | null> {
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, 'Cookie': getCookie(), 'Referer': 'https://www.douyin.com/' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!r.ok) { log(`  ⚠ HTTP ${r.status} for GET ${url}`); return null; }
    const data: ApiResponse = await r.json().catch(() => null);
    checkApiBusinessError(data, url);
    return data;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      log(`  ⚠ 请求超时 GET: ${url}`);
    } else {
      log(`  ⚠ 网络错误 GET: ${err}`);
    }
    return null;
  }
}

/** POST JSON */
async function apiPost(url: string, body: any): Promise<ApiResponse | null> {
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': UA,
        'Cookie': getCookie(),
        'Referer': 'https://www.douyin.com/',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!r.ok) { log(`  ⚠ HTTP ${r.status} for POST ${url}`); return null; }
    const data: ApiResponse = await r.json().catch(() => null);
    checkApiBusinessError(data, url);
    return data;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      log(`  ⚠ 请求超时 POST: ${url}`);
    } else {
      log(`  ⚠ 网络错误 POST: ${err}`);
    }
    return null;
  }
}

// ─── API 调用 ──────────────────────────────────────────────

/** 获取未读消息总数 */
async function getUnreadCount(): Promise<number> {
  const url = 'https://www.douyin.com/aweme/v1/web/im/unread/count?device_platform=webapp&aid=6383';
  const d = await apiGet(url);
  if (!d) return -1;
  return d.unread_count ?? d.total_unread ?? 0;
}

/** 会话对象结构 */
interface Conversation {
  conversation_id?: string;
  id?: string;
  user?: { nickname?: string };
  name?: string;
  unread_count?: number;
}

/** 获取会话列表 */
async function getConversations(): Promise<Conversation[]> {
  const url = 'https://www.douyin.com/aweme/v1/web/im/conversation/list?device_platform=webapp&aid=6383&count=20';
  const d = await apiGet(url);
  if (!d) return [];
  return d.conversation_list ?? d.data?.conversation_list ?? [];
}

/** 发送文本私信 */
async function sendTextMsg(conversationId: string, text: string): Promise<boolean> {
  const url = 'https://www.douyin.com/aweme/v1/web/im/send/message?device_platform=webapp&aid=6383';
  const d = await apiPost(url, {
    conversation_id: conversationId,
    content: JSON.stringify({ text }),
    message_type: 1,
  });
  if (!d) return false;
  const ok = d.status_code === 0 || d.status_code === 200;
  if (!ok) log(`  ❌ 发送失败: ${JSON.stringify(d).slice(0, 200)}`);
  return ok;
}

// ─── 图片上传与发送 ──────────────────────────────────────

/** 缓存已上传的图片 key，避免重复上传 */
let cachedImageKey: { uri: string; url: string } | null = null;
let cachedImagePath = '';
let cachedImageMtime = 0;

/**
 * 上传本地图片到抖音 IM
 * 抖音 IM 图片上传接口：POST /aweme/v1/web/im/image/upload/
 */
async function uploadImage(imagePath: string): Promise<{ uri: string; url: string } | null> {
  // 有缓存且文件未变更（路径 + 修改时间） → 直接返回
  if (cachedImageKey && cachedImagePath === imagePath) {
    try {
      const mtime = fs.statSync(imagePath).mtimeMs;
      if (mtime === cachedImageMtime) {
        log(`  📷 使用缓存的图片 key`);
        return cachedImageKey;
      }
    } catch { /* stat 失败则重新上传 */ }
  }

  if (!fs.existsSync(imagePath)) {
    log(`  ❌ 图片文件不存在: ${imagePath}`);
    return null;
  }

  // 检查文件大小，防止大文件撑爆内存（Docker 限制 128M）
  const stat = fs.statSync(imagePath);
  const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB
  if (stat.size > MAX_IMAGE_SIZE) {
    log(`  ❌ 图片过大: ${formatBytes(stat.size)}，限制 ${formatBytes(MAX_IMAGE_SIZE)}`);
    return null;
  }

  const imageBuffer = fs.readFileSync(imagePath);
  const fileName = path.basename(imagePath);

  // 根据扩展名确定 MIME 类型
  const ext = path.extname(imagePath).toLowerCase();
  const mimeMap: Record<string, string> = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.png': 'image/png', '.gif': 'image/gif',
    '.webp': 'image/webp',
  };
  const mimeType = mimeMap[ext] || 'image/jpeg';

  const formData = new FormData();
  formData.append('file', new Blob([imageBuffer], { type: mimeType }), fileName);

  log(`  📤 上传图片: ${fileName} (${formatBytes(imageBuffer.length)})`);

  try {
    const r = await fetch(
      'https://www.douyin.com/aweme/v1/web/im/image/upload/?device_platform=webapp&aid=6383',
      {
        method: 'POST',
        headers: {
          'User-Agent': UA,
          'Cookie': getCookie(),
          'Referer': 'https://www.douyin.com/',
        },
        body: formData,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
    if (!r.ok) { log(`  ⚠ 图片上传 HTTP ${r.status}`); return null; }
    const result = await r.json().catch(() => null) as ApiResponse;
    if (!result) { log('  ❌ 图片上传返回空'); return null; }

    // 尝试从不同响应格式提取 uri + url
    const data = result.data || result;
    const uri = data.uri || data.image_uri || '';
    const url = data.url || data.download_url || data.image_url || '';

    if (!uri || !url) {
      log(`  ❌ 图片上传返回异常: ${JSON.stringify(result).slice(0, 300)}`);
      return null;
    }

    cachedImageKey = { uri, url };
    cachedImagePath = imagePath;
    cachedImageMtime = stat.mtimeMs;
    log(`  ✓ 图片上传成功`);
    return cachedImageKey;
  } catch (err) {
    log(`  ❌ 图片上传出错: ${err}`);
    return null;
  }
}

/** 发送图片私信 */
async function sendImageMsg(conversationId: string, image: { uri: string; url: string }): Promise<boolean> {
  const url = 'https://www.douyin.com/aweme/v1/web/im/send/message?device_platform=webapp&aid=6383';
  const content = {
    text: '',
    image: {
      uri: image.uri,
      url: image.url,
      image_type: 'origin',
    },
  };
  const d = await apiPost(url, {
    conversation_id: conversationId,
    content: JSON.stringify(content),
    message_type: 2,
  });
  if (!d) return false;
  const ok = d.status_code === 0 || d.status_code === 200;
  if (!ok) log(`  ❌ 图片发送失败: ${JSON.stringify(d).slice(0, 200)}`);
  return ok;
}

/**
 * 统一发送入口：优先图片，图片不可用/失败时回退到文本
 */
async function sendMsg(
  conversationId: string,
  text: string,
  imagePath?: string,
): Promise<boolean> {
  // 有图片配置 → 尝试发图片
  if (imagePath) {
    const img = await uploadImage(imagePath);
    if (img) {
      const ok = await sendImageMsg(conversationId, img);
      if (ok) return true;
      log('  ⚠ 图片发送失败，回退到文本');
    } else {
      log('  ⚠ 图片上传失败，回退到文本');
    }
  }
  // 无图片或图片失败 → 发文本
  return sendTextMsg(conversationId, text);
}

// ─── 磁盘清理 ─────────────────────────────────────────────

/**
 * 清理过期的日志文件
 * - 删除超过 keepDays 天的日志文件
 * - 磁盘使用率超过 90% 时发出警告
 */
function cleanupDisk(keepDays: number) {
  const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
  let cleaned = 0;

  // 清理过期日志
  if (fs.existsSync(LOG_DIR)) {
    for (const f of fs.readdirSync(LOG_DIR)) {
      // 日志文件名格式: monitor-2026-06-18.log
      const match = f.match(/monitor-(\d{4}-\d{2}-\d{2})\.log/);
      if (!match) continue;
      const fileDate = new Date(match[1]).getTime();
      if (fileDate < cutoff) {
        try {
          fs.unlinkSync(path.join(LOG_DIR, f));
          cleaned++;
          log(`  🗑 清理过期日志: ${f}`);
        } catch (err) {
          log(`  ⚠ 清理日志失败 ${f}: ${err}`);
        }
      }
    }
  }

  // 检查磁盘使用情况，超过阈值时警告
  try {
    const stats = getDiskUsage();
    if (stats) {
      const usedPercent = Math.round((stats.used / stats.total) * 100);
      log(`  💾 磁盘使用: ${usedPercent}% (${formatBytes(stats.available)} 可用)`);
      if (usedPercent > 90) {
        log(`  ⚠ 磁盘使用率 ${usedPercent}%，建议手动清理`);
      }
    }
  } catch { /* 获取磁盘信息失败不阻塞 */ }

  if (cleaned > 0) {
    log(`  ✨ 清理完成，删除 ${cleaned} 个过期文件`);
  }
}

/** 获取磁盘使用情况（优先使用 Node.js 原生 API，回退到 df 命令） */
function getDiskUsage(): { total: number; used: number; available: number } | null {
  // Node.js 18+ 支持 fs.statfsSync，跨平台且无需子进程
  if (typeof (fs as any).statfsSync === 'function') {
    try {
      const stats = (fs as any).statfsSync(ROOT);
      const total = stats.blocks * stats.bsize;
      const available = stats.bavail * stats.bsize;
      const used = total - (stats.bfree * stats.bsize);
      return { total, used, available };
    } catch { /* 回退到 df */ }
  }

  // 回退：Linux df 命令（仅用于旧版 Node.js）
  try {
    const output = execSync('df -B1 / | tail -1', { encoding: 'utf-8' });
    const parts = output.trim().split(/\s+/);
    if (parts.length >= 4) {
      return {
        total: parseInt(parts[1], 10),
        used: parseInt(parts[2], 10),
        available: parseInt(parts[3], 10),
      };
    }
  } catch { /* 非 Linux 环境忽略 */ }
  return null;
}

/** 字节格式化 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + 'MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + 'GB';
}

// ─── 主流程 ───────────────────────────────────────────────

// 优雅退出：收到信号后完成当前轮询再退出
let running = true;

function setupGracefulShutdown() {
  const shutdown = (signal: string) => {
    log(`📩 收到 ${signal}，完成当前轮询后退出...`);
    running = false;
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

async function main() {
  loadEnv();
  setupGracefulShutdown();

  log('🔊 私信监听启动（完整版）');
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  const config = getConfig();
  log(config.watchFriends.length > 0
    ? `📌 监控好友: ${config.watchFriends.join(', ')}`
    : '📌 监控所有好友');
  log(`⏰ 超过 ${config.maxWaitHours}:00 未收到消息则补发`);

  if (config.proactiveTargetId) {
    log(`📤 主动发信: 目标 ${config.proactiveTargetId}，每天 ${config.proactiveHour}:00 前无消息则发送`);
  }
  log(`🗑 磁盘清理: 保留 ${config.cleanupKeepDays} 天日志`);

  // 启动时执行一次清理
  cleanupDisk(config.cleanupKeepDays);

  while (running) {
    try {
      const cfg = getConfig();
      const state = loadState();
      const now = new Date();
      const hours = now.getHours() + now.getMinutes() / 60;

      log('--- 检查 ---');

      // 1. 查未读数
      const unread = await getUnreadCount();
      if (unread < 0) {
        log('⚠ 请求失败，cookie 可能过期');
      } else if (unread > 0) {
        log(`📬 未读: ${unread}`);
        state.receivedToday = true; // 标记今天收到过消息

        // 2. 拉会话列表
        const convs = await getConversations();
        log(`📋 会话数: ${convs.length}`);

        // 3. 逐个处理
        for (const c of convs) {
          const id = c.conversation_id || c.id || '';
          const name = c.user?.nickname || c.name || id;
          const count = c.unread_count || 0;
          if (count <= 0) continue;
          if (cfg.watchFriends.length > 0 && !cfg.watchFriends.includes(name)) continue;
          if (state.sentToday[id]) { log(`  ${name}: 今日已回复`); continue; }

          log(`💬 ${name}: ${count} 条未读`);
          const ok = await sendMsg(id, cfg.defaultReply, cfg.replyImagePath);
          if (ok) {
            log(`  ✓ 已回复`);
            state.sentToday[id] = true;
            // 已回复，从待补发列表中移除
            delete state.pendingReplies[id];
          } else {
            // 发送失败，记录为待补发（如果尚未记录则记录首次发现时间）
            if (!state.pendingReplies[id]) {
              state.pendingReplies[id] = Date.now();
              log(`  ⏳ 已加入待补发队列`);
            }
          }
        }
      } else {
        log('📭 无未读');
      }

      // 4. 超时补发：对 pendingReplies 中等待超时的会话进行补发
      for (const [id, firstSeen] of Object.entries(state.pendingReplies)) {
        const hoursWaiting = (Date.now() - firstSeen) / (1000 * 60 * 60);
        if (hoursWaiting >= cfg.maxWaitHours) {
          log(`⏰ ${id} 等待 ${hoursWaiting.toFixed(1)}h 超时，补发...`);
          const ok = await sendMsg(id, cfg.defaultReply, cfg.replyImagePath);
          if (ok) {
            state.sentToday[id] = true;
            delete state.pendingReplies[id];
            log('  ✓ 补发成功');
          }
        }
      }

      // 5. 主动发信：当天无任何私信 + 到达指定时间 + 尚未发过
      if (
        cfg.proactiveTargetId &&
        !state.receivedToday &&
        !state.proactiveSentToday &&
        hours >= cfg.proactiveHour
      ) {
        log(`📤 当天无私信，主动发送给 ${cfg.proactiveTargetId}...`);
        const ok = await sendMsg(cfg.proactiveTargetId, cfg.proactiveText, cfg.proactiveImagePath);
        if (ok) {
          state.proactiveSentToday = true;
          log('  ✓ 主动发信成功');
        } else {
          log('  ❌ 主动发信失败');
        }
      }

      // 6. 每天凌晨 3 点执行一次磁盘清理
      if (now.getHours() === 3 && now.getMinutes() < 6) {
        cleanupDisk(cfg.cleanupKeepDays);
      }

      state.lastCheckTime = Date.now();
      saveState(state);
      log(`✅ 完成，5 分钟后再检查`);

    } catch (err) {
      log(`❌ 出错: ${err}`);
    }

    // 分段 sleep，每秒检查一次退出信号，避免 kill 时等待 5 分钟
    for (let i = 0; i < 300 && running; i++) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  log('👋 监听已停止');
  process.exit(0);
}

main();
