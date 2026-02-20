# syntax=docker/dockerfile:1.7

FROM node:20-bookworm-slim AS base
WORKDIR /app

# -------- Dependencies for build (dev + prod) --------
FROM base AS deps
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci

# -------- Build --------
FROM deps AS builder
COPY tsconfig*.json nest-cli.json ./
COPY src ./src
RUN npm run build

# -------- Production dependencies only --------
FROM base AS prod-deps
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev && npm cache clean --force

# -------- Runtime --------
FROM node:20-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package*.json ./

# Drop root privileges
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "const http=require('http');const req=http.request({host:'127.0.0.1',port:process.env.PORT||3000,path:'/api/auth/profile',timeout:2000},res=>process.exit(res.statusCode<500?0:1));req.on('error',()=>process.exit(1));req.end();"

CMD ["node", "dist/src/main.js"]
