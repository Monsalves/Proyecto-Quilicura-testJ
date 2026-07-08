FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json ./
COPY index.html ./
COPY src ./src
COPY config ./config
COPY data ./data

RUN mkdir -p /app/data/backups

ENV HOST=0.0.0.0
ENV PORT=4310
ENV QUILICURA_RUNTIME_PATH=/app/config/operational.json
ENV QUILICURA_DB_PATH=/app/data/quilicura.sqlite

EXPOSE 4310

CMD ["node", "src/backend/server.mjs", "--serve-frontend", "--port", "4310"]
