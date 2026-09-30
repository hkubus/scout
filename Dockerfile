FROM node:22-bookworm-slim AS build

WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false

RUN groupadd --system scout \
  && useradd --system --gid scout --home-dir /app --no-create-home scout \
  && mkdir -p /app/data \
  && chown -R scout:scout /app

COPY --from=build /app/package.json /app/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
  && npm cache clean --force

COPY --from=build --chown=scout:scout /app/dist ./dist
COPY --from=build --chown=scout:scout /app/dist-server ./dist-server
COPY --from=build --chown=scout:scout /app/migrations ./migrations
COPY --from=build --chown=scout:scout /app/scripts/hash-password.mjs ./scripts/hash-password.mjs

RUN chown -R scout:scout /app

USER scout
EXPOSE 3001
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD node -e "fetch('http://127.0.0.1:3001/api/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist-server/index.js"]
