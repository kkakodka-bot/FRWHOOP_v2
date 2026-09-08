FROM node:22-bookworm-slim

WORKDIR /app

COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev

COPY backend/ ./
COPY supabase/migrations ./migrations

RUN mkdir -p /app/data/live /app/data/memory /app/data/sessions /app/data/documents \
  && chown -R node:node /app

ENV NODE_ENV=production
ENV FRWHOOP_RUNTIME=production
ENV FRWHOOP_MIGRATIONS_DIR=/app/migrations
EXPOSE 8080

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "index.js"]
