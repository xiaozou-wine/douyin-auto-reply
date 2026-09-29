FROM mcr.microsoft.com/playwright:v1.61.1-jammy

LABEL description="抖音单好友续火花自动发图服务"

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.0.0 --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

RUN mkdir -p /app/runtime/browser-profile /app/runtime/screenshots /app/images

VOLUME ["/app/runtime", "/app/images"]

CMD ["node", "dist/src/index.js"]
