# AG-UI-native AgentCore Runtime (issue #176). See server.ts for the protocol
# contract this container must satisfy (port 8080, /invocations, /ping).
#
# Runtime contract (see docs.aws.amazon.com/bedrock-agentcore .../runtime-agui):
#   - MUST be linux/arm64
#   - MUST listen on 0.0.0.0:8080
#   - MUST expose `GET /ping` (health) and `POST /invocations` (AG-UI SSE)
FROM --platform=linux/arm64 public.ecr.aws/docker/library/node:22-bookworm-slim

WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install
COPY server.ts memory.ts ./
RUN npm run build

EXPOSE 8080
CMD ["node", "dist/server.js"]
