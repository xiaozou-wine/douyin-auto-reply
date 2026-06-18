# CLAUDE.md

抖音私信监听助手 — 用 cookie 直接调抖音 API，自动回复 + 主动发信 + 磁盘清理。

## 快速开始

```bash
# 1. 配置
cp .env.example .env    # 填入 DOUYIN_COOKIE 和其他配置

# 2a. Docker 部署（推荐，Linux）
docker compose up -d

# 2b. 本地运行（开发调试）
pnpm install
pnpm monitor:im
```

## 部署方式

```bash
# Docker（适合内存充裕的机器）
docker compose up -d

# systemd（适合小 VPS，无 Docker 开销）
sudo bash deploy/deploy.sh
```

## 结构

```
scripts/monitor-im.ts    # 主脚本（轮询 + 回复 + 主动发信 + 清理）
proto/                   # Protobuf 定义（Request/Response/Live）
data/monitor-state.json  # 运行状态（自动生成）
logs/monitor-YYYY-MM-DD.log  # 按天分割的日志文件
Dockerfile               # Docker 镜像
docker-compose.yml       # 编排配置（限 128M 内存）
.env.example             # 配置模板
```

## 功能说明

| 功能 | 触发条件 | 配置项 |
|------|---------|--------|
| 自动回复 | 每 5 分钟轮询，有未读消息 | `MONITOR_DEFAULT_REPLY` |
| 超时补发 | 超过 MAX_WAIT_HOURS 未回复 | `MONITOR_MAX_WAIT_HOURS` |
| 主动发信 | 当天无私信 + 超过 PROACTIVE_HOUR | `MONITOR_PROACTIVE_TARGET_ID` |
| 磁盘清理 | 每天凌晨 3 点，清理过期日志 | `MONITOR_CLEANUP_KEEP_DAYS` |
