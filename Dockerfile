FROM node:22-alpine
RUN apk add --no-cache openssl

EXPOSE 3000

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json* ./

RUN npm ci --omit=dev && npm cache clean --force

COPY . .

RUN npm run build

# Node runs as the main process (exec), so a deploy's SIGTERM reaches it and
# chats in flight can finish (npm doesn't pass the signal on).
CMD ["sh", "-c", "npm run setup && exec node server.mjs"]
