# syntax=docker/dockerfile:1.7
# Satu Dockerfile untuk seluruh monorepo, dengan target:
#   --target server  -> API + worker (Node.js)
#   --target admin   -> panel admin (nginx, sekaligus reverse proxy ke API)

ARG NODE_IMAGE=node:22-bookworm-slim
ARG NGINX_IMAGE=nginx:1.27-alpine

# ---------------------------------------------------------------- build
FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/question-ui/package.json packages/question-ui/
COPY apps/server/package.json apps/server/
COPY apps/admin/package.json apps/admin/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY tsconfig.base.json ./
COPY packages packages
COPY apps apps
RUN pnpm --filter @cbt/shared build \
 && pnpm --filter @cbt/server build \
 && pnpm --filter @cbt/admin build

# ---------------------------------------------------------------- server (API + worker)
FROM ${NODE_IMAGE} AS server
ENV NODE_ENV=production PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/question-ui/package.json packages/question-ui/
COPY apps/server/package.json apps/server/
COPY apps/admin/package.json apps/admin/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --prod --filter @cbt/server...
COPY --from=build /repo/packages/shared/dist packages/shared/dist
COPY --from=build /repo/apps/server/dist apps/server/dist
COPY apps/server/drizzle apps/server/drizzle
WORKDIR /app/apps/server
USER node
EXPOSE 3000
# Default: API. Worker memakai command `node dist/worker.js` (lihat docker-compose.yml).
CMD ["node", "dist/index.js"]

# ---------------------------------------------------------------- admin (nginx)
FROM ${NGINX_IMAGE} AS admin
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/admin/dist /usr/share/nginx/html
EXPOSE 80
