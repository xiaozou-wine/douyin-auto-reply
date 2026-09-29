# 抖音续火花自动发图服务

单账号、单好友、每天最多一次的抖音自动发图服务。

**本仓库有两套互不相关的实现。生产环境跑的是 A，不是 B。**

| | 位置 | 语言 | 状态 |
|---|---|---|---|
| **A. 生产系统** | VPS `/root/douyin-spark` | Python + Java JAR | **正在运行** |
| B. 本地方案 | 本仓库 `src/`、`tests/`、`dist/` | TypeScript + Playwright | 未部署，实验性 |

⚠️ 改生产行为请以 A 为准。B 的代码结构、配置项、调用链与 A 完全不同，
照着 B 改会修错系统（详见 `memory/auto-reply-code-architecture.md`）。

---

# A. 生产系统（VPS）

## 架构

```
root cron
  ├─ 21:30  check_sessionid.py         凭据巡检 + 失效邮件告警
  └─ 22:00  daily_run.py               当天发送
              └─ core/tasks.py::runTasks()
                   ├─ utils/config.py          解析 .env
                   └─ skills/send_image.py     当前激活的 skill
                        └─ core/web_api.py::DouyinPmCliClient
                             └─ res/kol_dy_msg-1.0.4-SNAPSHOT-private-message-cli.jar
```

发送窗口 **22:00–22:30**（在窗口内随机延迟，不越界）。当日已有成功记录则跳过。
窗口由 `.env` 的 `SEND_WINDOW_START` / `SEND_WINDOW_END` 控制，**改 cron 时要同步改**。

## 运行环境

- VPS `root@<VPS_HOST>`，Ubuntu 22.04，约 1C1G
- 唯一生产目录 `/root/douyin-spark`
- Python 用 `/root/douyin-spark/.venv/bin/python3`，Java 用 OpenJDK 17
- 日志：`logs/cron.log`（永久追加，无 logrotate）

## 凭据

`.env` 中两个键，**必须来自同一次登录会话**：

| 键 | 说明 |
|---|---|
| `SESSIONID_<user_id>` | 32 位字符串。授权接口唯一认的凭据 |
| `COOKIES_<user_id>` | 完整 cookie 头。必须含 `ms_token`、`s_v_web_id`、`UIFID` |

**有效期 60 天，硬期限，无法自动续期。** 2026-09-22 实测确认：授权接口不回
`Set-Cookie`，被动浏览 605 个请求零续期信号，旧会话的 `last_update_utc`
与 `creation_utc` 完全相同。

到期后 JAR 报 `获取上传授权失败: 用户未登录`。更换流程见
`memory/sessionid-refresh-workflow.md`（六步，约 5 分钟）。

`ms_token` **不是 cookie**，它在 localStorage 的 `xmst` 键里。只导出 cookie
会漏掉它，`utils/config.py` 会静默跳过账号（`accounts: 0`），而空账号会被判为
"成功"——比失败更危险。用 `runtime/dy-push-env.mjs` 生成 payload 可避免此坑，
它会强制校验这三个字段。

`.env` 权限必须为 `600`，且含邮件授权码，任何 `.env.bak.*` 都不得外发。

## 告警

`check_sessionid.py` 每天 21:30 巡检（比发送早半小时，收到告警当天还来得及补救）。

| 结果 | 条件 | 动作 | 退出码 |
|---|---|---|---|
| valid | 返回 `access_key_id` + `session_token` | 静默 | 0 |
| invalid | `status_code=8` 或 `用户未登录` | 发邮件 | 1 |
| unknown | 网络错误 / 非 JSON / 未预期响应 | 只记日志 | 0 |

`unknown` 不告警，避免接口抖动每天轰炸邮箱。同日只发一封。

### 发送失败告警（2026-09-29 新增）

`check_sessionid.py` 只覆盖"凭据在发送前就已失效"。真正的发送结果它管不到——
9/20–9/24 连续 5 天 `unknown-after-dispatch` 就是静默失败的实例。

`daily_run.py` 现在在**任务结束时判断当天是否确认发送成功**，未确认就发邮件。
覆盖全部非成功出口：

| status | 触发条件 |
|---|---|
| `unknown-after-dispatch` | 已派发但结果未知，或当天已有未确认记录被阻止重试 |
| `failed-before-dispatch` | 消息未派发（凭据失效、上传授权失败、无目标） |
| `window-missed` | 进程启动时已过 22:30 窗口，压根没发送 |
| `state-file-corrupt` | `.send_state.json` 不可读，安全停止，未发送 |
| `state-write-failed` | 消息已发出但状态落盘失败（磁盘满），有重复发送风险 |

只有 `confirmed` 不发邮件。同日只发一封，由 `.send_state.json` 的 `last_alert_date` 去重；
邮件发送失败则不记这个日期，下次运行还会重试告警（避免告警通道故障被静默吞掉）。

凭据失效那天会收到**两封**邮件：21:30 的预警和 22:00 后的失败确认。两封内容不同，
前者是"今晚会失败"，后者是"确实没发成功"。

发送窗口从 **22:00 到 22:30**，因此最迟 22:30 后不久就能收到结果通知（无论成功与否，
成功只写日志不发邮件）。

### 发送窗口配置

窗口**不再硬编码**，从 `.env` 读取：

```env
SEND_WINDOW_START=22:00
SEND_WINDOW_END=22:30
```

两者都缺省时用上面这组默认值。`END` 不晚于 `START` 视为跨午夜窗口（如
`23:45`–`00:15`）。`START` 和 cron 触发时刻**必须落在同一天**，且间隔不超过
6 小时，否则脚本判定配置对不上，发 `window-misconfigured` 告警并停止发送——
不会傻等到下一个窗口。

⚠️ **改 cron 必须同步改这里。** cron 触发时刻（`crontab`）与窗口起点是两处
独立配置，代码不会自动跟随。触发时刻晚于窗口终点会导致每天都发
`window-missed` 告警但永远不发送。

邮件配置在 `.env` 的 `ALERT_EMAIL_*`（QQ 邮箱 SMTP），由 `utils/alert_mail.py::send_mail()`
统一发送。⚠️ `check_sessionid.py::send_alert()` 也读同一组配置，两处实现尚未合并。

## 运维命令

```bash
cd /root/douyin-spark

# 凭据是否有效（只读探测，不发消息）
NEW_SESSIONID="$(grep '^SESSIONID_<user_id>=' .env | cut -d= -f2-)" \
  .venv/bin/python3 verify_sessionid.py

# 手工跑一次巡检
.venv/bin/python3 check_sessionid.py

# 测试告警通道（发一封 [测试] 邮件，不改状态）
.venv/bin/python3 check_sessionid.py --test

# 巡检历史与当前状态
cat logs/session-check.log
cat .session_check_state.json

# 发送记录
grep -E "Task outcome|发送完成|发送未确认" logs/cron.log | tail -20
```

## 故障排查

**发送失败，日志出现 `用户未登录`** → sessionid 失效，按
`memory/sessionid-refresh-workflow.md` 更换。

**发送失败，日志出现 `unknown-after-dispatch`** → 已派发但结果未确认。
当日状态被标记 unknown 并阻止重试，避免重复发送。检查 `cron.log` 中的
`JAR_NONZERO_EXIT` 原始 dump（base64 + text + hex）看 JAR 真实输出。

**状态文件损坏** → `daily_run.py` 会抛 `StateFileError` 并安全停止，不会发送。
手工检查 `.send_state.json`。

**没收到告警但确实断了** → 检查 `logs/session-check.log` 是否有记录，
以及 SMTP 授权码是否被回收。

## 已知限制

- **凭据 60 天硬期限**，自动化续期经实验未能实现（详见 memory）
- 消息来源检测当前关闭，不做实时回复，只在晚间窗口发送
- 失败无自动重试，每天一次机会（失败会发邮件告警）
- 多账号/多目标未支持，状态是整批一个布尔标记
- 生产 active path 未纳入 Git，重建服务器无法还原当前行为

---

# B. 本地 TypeScript 方案（未部署）

早期用 Playwright 直接操作网页的实现，**当前未在生产运行**，保留作为替代方案研究。

## 能力

- 复用 `runtime/browser-profile/` 的网页登录态
- 按 `TARGET_FRIEND_NAME` 定位好友
- 当天好友先发消息时立即发送，否则在兜底时间窗内随机
- 发送后写 `runtime/state.json` 防重复
- 失败输出结构化日志并截图到 `runtime/screenshots/`

## 不做什么

- 不做多账号、多好友、批量群发
- 不做 AI 回复或文字回复
- 不绕过验证码、登录校验或平台风控

## 本地运行

```bash
pnpm install
pnpm playwright:install
cp .env.example .env
```

`.env`：

```env
TARGET_FRIEND_NAME=好友昵称
IMAGE_PATH=images/spark.jpg
HEADLESS=false
```

放入图片到 `images/spark.jpg`，然后 `pnpm dev`。

首次登录查看 `runtime/login.png`，扫码后自动进入私信页。

## Docker

```bash
cp .env.example .env
mkdir -p images runtime
docker compose up -d --build
docker compose logs -f
```

## 手动验证

1. 设 `HEADLESS=false`
2. 登录抖音网页版
3. 确认能进入目标好友聊天
4. 把 `FALLBACK_AFTER` / `FALLBACK_BEFORE` 临时改到当前时间附近
5. 观察只发送一次
6. 重启服务，确认 `runtime/state.json` 已标记 sent 后不重复发送

---

# 目录说明

```
remediation/douyin-spark/        生产文件本地镜像（唯一权威副本）
  ├── check_sessionid.py         巡检告警脚本（VPS 同步）
  ├── verify_sessionid.py        只读凭据验证
  ├── update_sessionid.py        原子替换 SESSIONID_
  ├── daily_run.py               生产发送入口镜像（含失败告警与窗口配置）
  ├── requirements.txt
  ├── core/ utils/ skills/ tests/  生产模块镜像

memory/                          跨会话知识（见 MEMORY.md 索引）

runtime/                         运维脚本（.mjs 已纳入版本控制）
  ├── refresh-credentials.mjs    凭据更换主流程（四道门禁 + 自动回滚）
  ├── dy-freeze-export.mjs       冻结导出，避免导出中途 sessionid 轮换
  ├── dy-cdp-export.mjs          从浏览器导出凭据（含 ms_token）
  ├── dy-push-env.mjs            构建 .env payload 并校验必需字段
  ├── dy-ls-read.mjs             读 localStorage 的 ms_token
  ├── dy-login-check.mjs         检查浏览器登录态
  └── dy-renew-probe.mjs         续期机制探测（结论：不续期）

src/ tests/ dist/                本地 TypeScript 方案（B）
vps-production-backup-…-private/ 私密恢复包，已被 .gitignore 排除
```

⚠️ **根目录的 `daily_run.py` 已于 2026-09-29 删除。** 它是历史遗留的重复副本：
根目录没有 `core/`、`utils/`，它连 import 都过不了（旧版 186 行 vs 生产版 375 行），
且长期与生产不同步。**生产代码以 `remediation/douyin-spark/` 为准。**

根目录另三个遗留文件状态如下，均无凭据：

| 文件 | 状态 |
|---|---|
| `custom_text.py` / `send_image.py` | 与 `remediation/douyin-spark/skills/` 下同名文件**逐字节相同**，属纯重复 |
| `test_api.py` | **remediation 中不存在**，是独有内容。带真实网络副作用（探测 imapi），README 一直强调它"不是测试"。`task_plan.md` 明确列入"不运行"清单 |

⚠️ **`runtime/` 只跟踪 `*.mjs`。** 登录态（`storage-state.json`）、状态文件
（`state.json`）、截图（`login.png`、`screenshots/`）与 `probe/` 全部被排除。
`.mjs` 是凭据更换流程的依赖，必须留在版本控制里。

⚠️ **`vps-production-backup-…-private/` 含真实生产凭据**（`SESSIONID`、
`COOKIES`、与 VPS 当前值一致的活 `uifid`），已被 `.gitignore` 排除，**永不提交**。
它同时是 B 方案凭据刷新的模板来源（`src/credentials/paths.ts` 硬编码引用）。

⚠️ **`images/` 下只提交 `.gitkeep`。** 实际发送的图片是你和好友之间的私密内容，
多半还是第三方素材，不该出现在公开仓库。本地放 `images/spark.jpg` 即可，
`.gitignore` 会挡住它。测试不依赖该文件——`tests/config.test.ts` 自己造临时
`spark.jpg`，其余引用都只是路径字符串。

`.env.example` 是 B 方案的模板（`TARGET_FRIEND_NAME` 等），
**不包含生产所需的 `SESSIONID_` / `COOKIES_` / `ALERT_EMAIL_*`**。

## 相关文档

- `MEMORY.md` — memory 索引
- `memory/auto-reply-service-status.md` — VPS 与 cron 当前状态
- `memory/auto-reply-code-architecture.md` — 生产调用链与本地/生产映射
- `memory/auto-reply-known-issues.md` — 已确认的正确性、安全与可靠性问题
- `memory/sessionid-refresh-workflow.md` — 凭据更换六步流程
- `memory/sessionid-alert.md` — 告警机制与验证记录
- `memory/no-test-msg-to-spark-target.md` — 验证纪律：不得向真实目标发测试消息
