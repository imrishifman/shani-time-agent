FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm install --no-save typescript@5 && npx tsc -p tsconfig.json && npm uninstall --no-save typescript
VOLUME ["/app/data"]
EXPOSE 3000
CMD ["node", "dist/index.js"]
