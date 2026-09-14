# 仟流智算 control-api 镜像（W24）。
# 单阶段 tsx 方案（与开发一致），架构无关。control-api 依赖 argon2（native，onlyBuiltDependencies 已白名单）。

FROM node:22.17.1-alpine
RUN corepack enable && corepack prepare pnpm@11.11.0 --activate
WORKDIR /app

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

COPY tsconfig.base.json ./
COPY VERSION ./
COPY packages/ packages/
COPY apps/control-api/ apps/control-api/

ENV NODE_ENV=production
EXPOSE 8788
CMD ["node", "--import", "tsx", "apps/control-api/src/main.ts"]
