FROM oven/bun:1.3.10-alpine AS build
WORKDIR /app
COPY package.json bun.lock tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/package.json
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
RUN bun install --frozen-lockfile --production
COPY packages/protocol packages/protocol
COPY apps/server apps/server
RUN bun build apps/server/src/index.ts --outdir apps/server/dist --target bun

FROM oven/bun:1.3.10-alpine
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATABASE_PATH=/data/expenses.sqlite ATTACHMENTS_PATH=/data/attachments
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/server/migrations ./apps/server/migrations
COPY --from=build /app/apps/server/package.json ./apps/server/package.json
COPY --from=build /app/packages/protocol/package.json ./packages/protocol/package.json
VOLUME ["/data"]
EXPOSE 3000
CMD ["bun", "apps/server/dist/index.js"]
