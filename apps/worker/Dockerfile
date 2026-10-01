# 仟流智算 worker 镜像（W24）。
# 单阶段 tsx 方案，架构无关。运行保障 Worker 为唯一常驻调度责任方。

FROM node:22.17.1-alpine
RUN if ! apk add --no-cache font-wqy-zenhei font-dejavu fontconfig; then \
      sed -i 's/dl-cdn.alpinelinux.org/mirrors.aliyun.com/g' /etc/apk/repositories && \
      apk add --no-cache font-wqy-zenhei font-dejavu fontconfig; \
    fi && fc-cache -fv
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
ARG NPM_REGISTRY=https://registry.npmjs.org
RUN pnpm config set --location=project registry "${NPM_REGISTRY}" && pnpm install --frozen-lockfile
# pnpm may omit a failed optional native download while reporting install success.
# This module is required by the Worker, so prove it can render before exporting an image.
RUN node -e "const {createCanvas}=require('./apps/worker/node_modules/@napi-rs/canvas'); createCanvas(1,1).toBuffer('image/png')"

COPY tsconfig.base.json ./
COPY packages/ packages/
COPY apps/worker/ apps/worker/

ARG SOURCE_REVISION=unknown
LABEL org.opencontainers.image.revision=$SOURCE_REVISION \
      org.opencontainers.image.source="https://github.com/Stephen66000/qianliu-zhisuan"

ENV NODE_ENV=production
CMD ["node", "--import", "tsx", "apps/worker/src/main.ts", "runtime-assurance-scheduler"]
