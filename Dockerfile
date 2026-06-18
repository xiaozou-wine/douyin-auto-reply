FROM node:20-alpine

LABEL description="抖音私信自动回复 + 主动发信 + 磁盘清理"

WORKDIR /app

# 安装 pnpm
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate

# 先复制依赖文件，利用 Docker 缓存层
COPY package.json ./
# pnpm-lock.yaml 存在时使用 --frozen-lockfile，否则直接 install
RUN pnpm install --frozen-lockfile 2>/dev/null || pnpm install

# 复制项目文件
COPY scripts/ ./scripts/

# 创建数据和日志目录
RUN mkdir -p /app/data /app/logs

# 健康检查
HEALTHCHECK --interval=60s --timeout=5s --retries=3 \
  CMD pgrep -f "tsx scripts/monitor-im" > /dev/null || exit 1

VOLUME ["/app/data", "/app/logs"]

CMD ["npx", "tsx", "scripts/monitor-im.ts"]
