# AG-UI-native AgentCore Runtime (issue #176). See server.ts for the protocol
# contract this container must satisfy (port 8080, /invocations, /ping).
#
# Runtime contract (see docs.aws.amazon.com/bedrock-agentcore .../runtime-agui):
#   - MUST be linux/arm64
#   - MUST listen on 0.0.0.0:8080
#   - MUST expose `GET /ping` (health) and `POST /invocations` (AG-UI SSE)
FROM --platform=linux/arm64 public.ecr.aws/docker/library/node:22-bookworm-slim

WORKDIR /app
# Pin the dependency tree to the committed lockfile with `npm ci` (issue #556):
# a fresh floating-range `npm install` here resolves caret-ranged transitive
# @aws-sdk/* deps against the live registry, so a single AWS SDK release-cadence
# hiccup (a version briefly missing → ETARGET) aborts the build and rolls back
# every deploy repo-wide. `npm ci` against package-lock.json is reproducible.
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY server.ts memory.ts ./
RUN npm run build

EXPOSE 8080
CMD ["node", "dist/server.js"]
