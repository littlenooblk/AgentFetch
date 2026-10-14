FROM node:22-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json README.md docs_plan.md ./
COPY src ./src
RUN npm run build
ENV NODE_ENV=production
ENV AGENT_FETCH_SERVICE_HOST=0.0.0.0
ENV AGENT_FETCH_SERVICE_PORT=8788
EXPOSE 8788
CMD ["node", "dist/src/service/server.js"]
