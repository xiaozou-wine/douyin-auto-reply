/**
 * 抖音私信自动回复脚本（Playwright 浏览器版）
 *
 * 用 Playwright 控制 Chromium 浏览器，自动处理 protobuf 签名。
 * 在页面 JS 上下文中调用抖音 IM SDK，无需逆向签名算法。
 *
 * 功能：
 *   1. 定时轮询未读 → 自动回复
 *   2. 超时补发
 *   3. 当天无私信时主动发一条
 *   4. 磁盘清理
 *
 * 用法：
 *   cp .env.example .env    # 填入配置
 *   npx playwright install chromium  # 安装浏览器（首次）
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
// 轮询间隔（毫秒）
const POLL_INTERVAL_MS = 5 * 60 * 1000;

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

function log(msg: string) {
  const ts = new Date().toLocaleString('zh-CN', { hour12: false });
  const line = `[${ts}] ${msg}`;
  console.log(line);
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    const dateStr = new Date().toISOString().slice(0, 10);
    fs.appendFileSync(path.join(LOG_DIR, `monitor-${dateStr}.log`), line + '\n');
  } catch (err) {
    console.warn(`[日志写入失败] ${err}`);
  }
}

interface Config {
  watchFriends: string[];
  maxWaitHours: number;
  defaultReply: string;
  replyImagePath: string;
  proactiveTargetId: string;
  proactiveText: string;
  proactiveHour: number;
  proactiveImagePath: string;
  cleanupKeepDays: number;
}

function safeParseInt(val: string | undefined, fallback: number): number {
  if (!val) return fallback;
  const n = parseInt(val, 10);
  return Number.isNaN(n) ? fallback : n;
}

function getConfig(): Config {
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
    replyImagePath: process.env.MONITOR_REPLY_IMAGE_PATH || '',
    proactiveTargetId: process.env.MONITOR_PROACTIVE_TARGET_ID || '',
    proactiveText: process.env.MONITOR_PROACTIVE_TEXT || '今天过得怎么样？',
    proactiveHour: safeParseInt(process.env.MONITOR_PROACTIVE_HOUR, 20),
    proactiveImagePath: process.env.MONITOR_PROACTIVE_IMAGE_PATH || '',
    cleanupKeepDays: safeParseInt(process.env.MONITOR_CLEANUP_KEEP_DAYS, 7),
  };
}

// ─── 状态管理 ─────────────────────────────────────────────

interface MonitorState {
  today: string;
  sentToday: Record<string, boolean>;
  pendingReplies: Record<string, number>;
  receivedToday: boolean;
  proactiveSentToday: boolean;
  lastCheckTime: number;
}

function loadState(): MonitorState {
  const today = new Date().toISOString().slice(0, 10);
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    if (s.today !== today) {
      return { today, sentToday: {}, pendingReplies: {}, receivedToday: false, proactiveSentToday: false, lastCheckTime: 0 };
    }
    return {
      today,
      sentToday: s.sentToday || {},
      pendingReplies: s.pendingReplies || {},
      receivedToday: s.receivedToday ?? false,
      proactiveSentToday: s.proactiveSentToday ?? false,
      lastCheckTime: s.lastCheckTime || 0,
    };
  } catch {
    return { today, sentToday: {}, pendingReplies: {}, receivedToday: false, proactiveSentToday: false, lastCheckTime: 0 };
  }
}

function saveState(state: MonitorState) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ─── 磁盘清理 ─────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + 'MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + 'GB';
}

function getDiskUsage(): { total: number; used: number; available: number } | null {
  try {
    const output = execSync('df -B1 / | tail -1', { encoding: 'utf-8' });
    const parts = output.trim().split(/\s+/);
    if (parts.length >= 4) {
      return { total: parseInt(parts[1], 10), used: parseInt(parts[2], 10), available: parseInt(parts[3], 10) };
    }
  } catch { /* 非 Linux 忽略 */ }
  return null;
}

function cleanupDisk(keepDays: number) {
  const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
  let cleaned = 0;
  if (fs.existsSync(LOG_DIR)) {
    for (const f of fs.readdirSync(LOG_DIR)) {
      const match = f.match(/monitor-(\d{4}-\d{2}-\d{2})\.log/);
      if (!match) continue;
      if (new Date(match[1]).getTime() < cutoff) {
        try { fs.unlinkSync(path.join(LOG_DIR, f)); cleaned++; log(`  🗑 清理: ${f}`); }
        catch (err) { log(`  ⚠ 清理失败 ${f}: ${err}`); }
      }
    }
  }
  try {
    const stats = getDiskUsage();
    if (stats) {
      const pct = Math.round((stats.used / stats.total) * 100);
      log(`  💾 磁盘: ${pct}% (${formatBytes(stats.available)} 可用)`);
      if (pct > 90) log(`  ⚠ 磁盘使用率 ${pct}%`);
    }
  } catch {}
  if (cleaned > 0) log(`  ✨ 清理 ${cleaned} 个文件`);
}

// ─── Cookie 解析 ──────────────────────────────────────────

/**
 * 将原始 cookie 字符串解析为 Playwright 需要的 cookie 数组格式
 */
function parseCookies(rawCookie: string): Array<{
  name: string; value: string; domain: string; path: string;
}> {
  const cookies: Array<{ name: string; value: string; domain: string; path: string }> = [];
  for (const part of rawCookie.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!name) continue;
    cookies.push({
      name,
      value,
      domain: '.douyin.com',
      path: '/',
    });
  }
  return cookies;
}

// ─── 浏览器自动化 ─────────────────────────────────────────

async function launchBrowser() {
  // 动态导入 playwright（避免未安装时报错）
  let chromium: any;
  try {
    const pw = await import('playwright');
    chromium = pw.chromium;
  } catch {
    // 回退到 playwright-core（如果只装了 core）
    try {
      const pw = await import('playwright-core');
      chromium = pw.chromium;
    } catch {
      console.error('❌ 请先安装 playwright: npm install playwright 或 npx playwright install chromium');
      process.exit(1);
    }
  }

  log('🚀 启动浏览器...');
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-background-networking',
      '--single-process',          // 省内存
      '--js-flags=--max-old-space-size=128',  // 限制 JS 堆
    ],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'zh-CN',
  });

  // 设置 cookie
  const rawCookie = process.env.DOUYIN_COOKIE || '';
  if (!rawCookie) {
    console.error('❌ 请在 .env 中设置 DOUYIN_COOKIE');
    process.exit(1);
  }
  await context.addCookies(parseCookies(rawCookie));

  const page = await context.newPage();

  // 拦截不必要的资源以节省带宽和内存
  await page.route('**/*.{png,jpg,jpeg,gif,webp,svg,mp3,mp4,woff,woff2,ttf}', route => route.abort());
  await page.route('**/analytics*', route => route.abort());
  await page.route('**/log*', route => route.abort());

  // IM 数据存储
  const imData = { unreadCount: 0, conversations: [] as any[] };

  // 加载抖音私信页面（触发 IM SDK 初始化）
  log('📡 加载抖音私信页面...');

  // 等待 IM API 响应的 Promise
  const imReady = new Promise<void>((resolve) => {
    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) { resolved = true; resolve(); }
    }, 30000);

    page.on('response', async (response: any) => {
      const url = response.url();
      try {
        if (url.includes('unread_count') || url.includes('unread/count')) {
          const body = await response.json().catch(() => null);
          if (body) {
            imData.unreadCount = body.inbox_type ?? body.unread_count ?? body.total_unread ?? 0;
            log(`  📬 捕获未读数: ${imData.unreadCount}`);
            if (!resolved) { resolved = true; clearTimeout(timeout); resolve(); }
          }
        }
        if (url.includes('conversation') && url.includes('list')) {
          const body = await response.json().catch(() => null);
          if (body) {
            imData.conversations = body.conversation_list ?? body.data?.conversation_list ?? [];
            log(`  📋 捕获会话数: ${imData.conversations.length}`);
          }
        }
      } catch {}
    });
  });

  await page.goto('https://www.douyin.com/message', { waitUntil: 'domcontentloaded', timeout: 60000 });
  log('✓ 私信页面加载完成');

  // 等待 IM API 数据返回
  await imReady;

  return { browser, context, page, imData };
}

/**
 * 通过页面 JS 上下文获取未读数
 * 抖音页面加载后会初始化 IM SDK，我们可以调用页面内的函数
 */
async function getUnreadCountViaPage(page: any): Promise<number> {
  try {
    // 方法1: 从页面 DOM 读取未读角标
    const count = await page.evaluate(() => {
      // 尝试从 IM 侧边栏/消息图标上读取未读数
      const badge = document.querySelector('[class*="unread"]')?.textContent
        || document.querySelector('[class*="badge"]')?.textContent
        || document.querySelector('[data-e2e="message-count"]')?.textContent;
      if (badge) return parseInt(badge, 10) || 0;

      // 尝试从全局状态读取
      const w = window as any;
      if (w.__IM_STORE__?.unreadCount) return w.__IM_STORE__.unreadCount;
      if (w.__NEXT_DATA__?.props?.pageProps?.unreadCount) return w.__NEXT_DATA__.props.pageProps.unreadCount;
      return -1; // 无法获取
    });
    return count;
  } catch {
    return -1;
  }
}

/**
 * 通过页面发送消息（利用页面内 IM 功能）
 * 这是最后的降级方案 — 如果其他方式都失败，模拟用户操作
 */
async function sendMsgViaPage(page: any, conversationId: string, text: string): Promise<boolean> {
  try {
    // 尝试通过页面 JS 上下文调用发送接口
    const result = await page.evaluate(async (args: { convId: string; text: string }) => {
      const w = window as any;
      // 尝试直接调用页面内的 IM SDK 发送方法
      if (w.__IM_SDK__?.sendMessage) {
        return await w.__IM_SDK__.sendMessage(args.convId, args.text);
      }
      // 尝试 fetch 调用（页面上下文内有完整的签名机制）
      try {
        const resp = await fetch('/aweme/v1/web/im/send/message?device_platform=webapp&aid=6383', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            conversation_id: args.convId,
            content: JSON.stringify({ text: args.text }),
            message_type: 1,
          }),
        });
        return await resp.json();
      } catch (e: any) {
        return { error: e.message };
      }
    }, { convId: conversationId, text });

    if (result?.status_code === 0 || result?.status_code === 200) {
      return true;
    }
    log(`  ❌ 发送失败: ${JSON.stringify(result).slice(0, 200)}`);
    return false;
  } catch (err) {
    log(`  ❌ 发送出错: ${err}`);
    return false;
  }
}

// ─── 主流程 ───────────────────────────────────────────────

async function main() {
  log('🔊 抖音私信监听启动（Playwright 版）');
  loadEnv();

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  const config = getConfig();
  log(config.watchFriends.length > 0
    ? `📌 监控好友: ${config.watchFriends.join(', ')}`
    : '📌 监控所有好友');
  log(`⏰ 超过 ${config.maxWaitHours}:00 补发`);
  if (config.proactiveTargetId) {
    log(`📤 主动发信: ${config.proactiveTargetId} @ ${config.proactiveHour}:00`);
  }
  log(`🗑 磁盘清理: ${config.cleanupKeepDays} 天`);

  cleanupDisk(config.cleanupKeepDays);

  // 启动浏览器
  const { browser, page, imData } = await launchBrowser();

  // 主循环
  while (true) {
    try {
      const cfg = getConfig();
      const state = loadState();
      const now = new Date();
      const hours = now.getHours() + now.getMinutes() / 60;

      log('--- 检查 ---');

      // 刷新私信页面触发新的 API 请求
      imData.unreadCount = 0;
      imData.conversations = [];

      const refreshDone = new Promise<void>((resolve) => {
        let resolved = false;
        const timeout = setTimeout(() => { if (!resolved) { resolved = true; resolve(); } }, 15000);

        const handler = async (response: any) => {
          const url = response.url();
          try {
            if (url.includes('unread_count') || url.includes('unread/count')) {
              const body = await response.json().catch(() => null);
              if (body) {
                imData.unreadCount = body.inbox_type ?? body.unread_count ?? body.total_unread ?? 0;
                log(`  📬 未读: ${imData.unreadCount}`);
              }
            }
            if (url.includes('conversation') && url.includes('list')) {
              const body = await response.json().catch(() => null);
              if (body) {
                imData.conversations = body.conversation_list ?? body.data?.conversation_list ?? [];
                log(`  📋 会话: ${imData.conversations.length}`);
              }
            }
            if (imData.unreadCount >= 0 && imData.conversations.length >= 0) {
              if (!resolved) { resolved = true; clearTimeout(timeout); page.off('response', handler); resolve(); }
            }
          } catch {}
        };
        page.on('response', handler);
      });

      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await refreshDone;

      const unread = imData.unreadCount;
      if (unread < 0) {
        log('⚠ 无法获取未读数，cookie 可能过期');
      } else if (unread > 0) {
        log(`📬 未读: ${unread}`);
        state.receivedToday = true;

        // 处理会话
        for (const c of imData.conversations) {
          const id = c.conversation_id || c.id || '';
          const name = c.user?.nickname || c.name || id;
          const count = c.unread_count || 0;
          if (count <= 0) continue;
          if (cfg.watchFriends.length > 0 && !cfg.watchFriends.includes(name)) continue;
          if (state.sentToday[id]) { log(`  ${name}: 今日已回复`); continue; }

          log(`💬 ${name}: ${count} 条未读`);
          const ok = await sendMsgViaPage(page, id, cfg.defaultReply);
          if (ok) {
            log(`  ✓ 已回复`);
            state.sentToday[id] = true;
            delete state.pendingReplies[id];
          } else {
            // 记录待补发
            if (!state.pendingReplies[id]) state.pendingReplies[id] = Date.now();
          }
        }
      } else {
        log('📭 无未读');
      }

      // 超时补发
      if (hours >= cfg.maxWaitHours) {
        for (const [id, firstSeen] of Object.entries(state.pendingReplies)) {
          const hoursWaiting = (Date.now() - firstSeen) / 3600000;
          log(`⏰ ${id} 等待 ${hoursWaiting.toFixed(1)}h 超时，补发...`);
          const ok = await sendMsgViaPage(page, id, cfg.defaultReply);
          if (ok) {
            state.sentToday[id] = true;
            delete state.pendingReplies[id];
            log('  ✓ 补发成功');
          }
        }
      }

      // 主动发信
      if (cfg.proactiveTargetId && !state.receivedToday && !state.proactiveSentToday && hours >= cfg.proactiveHour) {
        log(`📤 主动发送给 ${cfg.proactiveTargetId}...`);
        const ok = await sendMsgViaPage(page, cfg.proactiveTargetId, cfg.proactiveText);
        if (ok) { state.proactiveSentToday = true; log('  ✓ 已发送'); }
      }

      // 凌晨 3 点清理
      if (now.getHours() === 3 && now.getMinutes() < 6) {
        cleanupDisk(cfg.cleanupKeepDays);
      }

      state.lastCheckTime = Date.now();
      saveState(state);
      log(`✅ 完成，${POLL_INTERVAL_MS / 60000} 分钟后再检查`);

    } catch (err) {
      log(`❌ 出错: ${err}`);
    }

    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
}

main().catch(err => {
  console.error('❌ 启动失败:', err);
  process.exit(1);
});
