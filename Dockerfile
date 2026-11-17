# syntax=docker/dockerfile:1
FROM node:24-alpine

ENV NODE_ENV=production
WORKDIR /app

# Dependencies first so the layer survives source-only changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY db ./db
COPY public ./public
COPY scripts ./scripts

# The API reads no files outside those directories, and never binds a privileged port.
USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=4s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
