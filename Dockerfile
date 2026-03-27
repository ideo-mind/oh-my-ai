FROM oven/bun:latest as builder

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .

RUN bun build index.ts --compile --outfile godai

FROM debian:bookworm-slim AS production

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/godai ./
COPY --from=builder /app/public ./public/
COPY --from=builder /app/config.toml ./

EXPOSE 8990
ENV PORT=8990
ENV NODE_ENV=production
ENV CONFIG_FILE=/config/config.toml

CMD ["./godai"]
