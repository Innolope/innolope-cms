FROM node:22-alpine AS base
RUN corepack enable

FROM base AS deps
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/types/package.json ./packages/types/
COPY packages/db/package.json ./packages/db/
COPY packages/config/package.json ./packages/config/
COPY packages/sdk/package.json ./packages/sdk/
COPY packages/mcp-server/package.json ./packages/mcp-server/
COPY apps/api/package.json ./apps/api/
RUN pnpm install --frozen-lockfile

FROM base AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/types/node_modules ./packages/types/node_modules
COPY --from=deps /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=deps /app/packages/config/node_modules ./packages/config/node_modules
COPY --from=deps /app/packages/sdk/node_modules ./packages/sdk/node_modules
COPY --from=deps /app/packages/mcp-server/node_modules ./packages/mcp-server/node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY . .
RUN pnpm --filter @innolope/types build && \
    pnpm --filter @innolope/db build && \
    pnpm --filter @innolope/config build && \
    pnpm --filter @innolope/sdk build && \
    pnpm --filter @innolope/mcp-server build && \
    pnpm --filter @innolope/api build

FROM base AS runner
WORKDIR /app
COPY --from=build /app/packages/types/dist ./packages/types/dist
COPY --from=build /app/packages/types/package.json ./packages/types/
COPY --from=build /app/packages/db/dist ./packages/db/dist
COPY --from=build /app/packages/db/package.json ./packages/db/
COPY --from=build /app/packages/config/dist ./packages/config/dist
COPY --from=build /app/packages/config/package.json ./packages/config/
COPY --from=build /app/packages/sdk/dist ./packages/sdk/dist
COPY --from=build /app/packages/sdk/package.json ./packages/sdk/
COPY --from=build /app/packages/mcp-server/dist ./packages/mcp-server/dist
COPY --from=build /app/packages/mcp-server/package.json ./packages/mcp-server/
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/package.json ./apps/api/
COPY --from=build /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

ENV NODE_ENV=production
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
	CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||3001)+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/api/dist/index.js"]
