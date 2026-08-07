# Claude Code hosted in AgentCore Runtime.
#
# AgentCore Runtime executes each session in a Firecracker microVM (no Docker
# daemon, no privileged mode), so we run the Claude Code CLI *directly* here
# rather than emulating the GitHub Action with `act` (which needs
# Docker-in-Docker). This is the approach AWS documents in "Hosting Coding
# Agents on Amazon Bedrock AgentCore" and gives customers a clean migration off
# the anthropics/claude-code-action GitHub runner: it's the same Claude Code on
# Bedrock, minus the Actions-runner layer.
#
# Runtime contract (see docs.aws.amazon.com/bedrock-agentcore .../runtime-http-protocol-contract):
#   - MUST be linux/arm64
#   - MUST listen on 0.0.0.0:8080
#   - MUST expose `GET /ping` (health) and `POST /invocations` (work)
FROM --platform=linux/arm64 public.ecr.aws/docker/library/node:22-bookworm-slim

# git + gh (repo work), plus certs/curl for gh's apt repo and Bedrock calls,
# plus unzip to extract the AWS CLI v2 bundle below.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        git curl ca-certificates gnupg unzip \
    && mkdir -p -m 755 /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        | gpg --dearmor -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# AWS CLI v2 (aarch64 — this image is linux/arm64). `apt-get install awscli`
# would pull the old, unsupported v1, so install the official bundle instead.
RUN curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip" -o /tmp/awscliv2.zip \
    && unzip -q /tmp/awscliv2.zip -d /tmp \
    && /tmp/aws/install \
    && rm -rf /tmp/awscliv2.zip /tmp/aws

# Claude Code CLI (global). Pinning avoids surprise CLI-flag changes between
# deploys; bump deliberately.
RUN npm install -g @anthropic-ai/claude-code@latest

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js memory.js browser-mcp.js detect-awaiting-input.js active-run.js ./

# The harness overrides ENTRYPOINT/CMD when this image backs a *harness*, but
# for a Runtime the CMD is honored — start the invocation server.
EXPOSE 8080
CMD ["node", "server.js"]
