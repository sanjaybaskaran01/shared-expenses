FROM oven/bun:1.3.10-alpine@sha256:32f1fcccb1523960b254c4f80973bee1a910d60be000a45c20c9129a1efcffee AS build
WORKDIR /app
COPY package.json bun.lock tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/package.json
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
RUN bun install --frozen-lockfile --production
COPY packages/protocol packages/protocol
COPY apps/server/src apps/server/src
COPY apps/server/migrations apps/server/migrations
COPY apps/server/tsconfig.json apps/server/tsconfig.json
RUN bun build apps/server/src/index.ts --outdir apps/server/dist --target bun

FROM oven/bun:1.3.10-alpine@sha256:32f1fcccb1523960b254c4f80973bee1a910d60be000a45c20c9129a1efcffee
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATABASE_PATH=/data/expenses.sqlite ATTACHMENTS_PATH=/data/attachments
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/server/migrations ./apps/server/migrations
COPY --from=build /app/apps/server/package.json ./apps/server/package.json
COPY --from=build /app/packages/protocol/package.json ./packages/protocol/package.json
RUN mkdir -p /data && chown -R bun:bun /data /app
VOLUME ["/data"]
EXPOSE 3000
USER bun
CMD ["bun", "apps/server/dist/index.js"]
