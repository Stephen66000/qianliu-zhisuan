# 仟流智算 gateway 镜像（W24）。
# 本 monorepo 的 packages build 为 --noEmit（只类型检查），运行时统一用 tsx 直跑 TS
#（与开发一致：node --import tsx src/main.ts）。故采用单阶段：装全量依赖 + 拷源码 + tsx 运行。
# 架构无关（arm64/x86_64）。依据：工程规则 §2、§5（Secret 不入镜像）。

FROM node:22.17.1-alpine
RUN corepack enable && corepack prepare pnpm@11.11.0 --activate
WORKDIR /app

# 先拷 workspace 清单，利用层缓存
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/gateway/package.json apps/gateway/
COPY apps/control-api/package.json apps/control-api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
COPY packages/domain/package.json packages/domain/
COPY packages/config/package.json packages/config/
COPY packages/testing/package.json packages/testing/
COPY packages/observability/package.json packages/observability/
COPY packages/provider-adapters/package.json packages/provider-adapters/
COPY packages/database/package.json packages/database/
RUN pnpm install --frozen-lockfile

# 拷源码（packages + 本服务）
COPY tsconfig.base.json ./
COPY packages/ packages/
COPY apps/gateway/ apps/gateway/

ENV NODE_ENV=production
EXPOSE 8787
# tsx 直跑 TS（与 pnpm start 一致）
CMD ["node", "--import", "tsx", "apps/gateway/src/main.ts"]
