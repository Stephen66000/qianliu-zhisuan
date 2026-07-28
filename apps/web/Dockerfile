# 仟流智算 web 镜像（W24）。
# 两阶段：node build（vite build 静态产物）→ nginx 提供静态服务。
# 架构无关。生产用 nginx 比 vite preview 更轻更稳。

# ---------- stage 1: build ----------
FROM node:22.17.1-alpine AS build
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
COPY tsconfig.base.json vitest.config.ts eslint.config.mjs ./
COPY packages/ packages/
COPY apps/web/ apps/web/
# web build 依赖 contracts 的类型；build contracts 产物
RUN pnpm --filter "@qianliu/contracts" --filter "@qianliu/domain" run build
RUN pnpm --filter "@qianliu/web" run build

# ---------- stage 2: runtime（nginx 静态服务）----------
FROM nginx:1.27-alpine AS runtime
# SPA：history fallback 到 index.html；/v1 /auth /health 反代到 control-api（由 compose 网络名解析）
RUN printf 'server {\n\
  listen 80;\n\
  root /usr/share/nginx/html;\n\
  index index.html;\n\
  location / { try_files $uri $uri/ /index.html; }\n\
}\n' > /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
