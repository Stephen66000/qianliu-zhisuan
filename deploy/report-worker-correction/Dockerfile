# Existing deployed dependencies are reused only after lockfile hash verification.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/ packages/
COPY apps/worker/ apps/worker/
ARG SOURCE_REVISION
LABEL org.opencontainers.image.revision=$SOURCE_REVISION
