FROM node:20-slim

LABEL maintainer="SkyalyticWing"
LABEL description="SkyalyticWing AI Agent Platform"

# L-I3 fix: 将 GUI/系统工具按需拆分。基础层仅安装必需工具（git/curl/python3/ffmpeg），
# xdotool/scrot/libnotify-bin/imagemagick 等 GUI 工具仅在需要桌面自动化的场景才安装，
# 减小默认镜像攻击面。如需桌面自动化，使用单独的 profile 或 build arg 启用。
# C-D6 fix 已加 USER app，进一步限制权限。
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl python3 python3-pip ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# 可选：通过 build arg 启用 GUI 工具（默认不安装以减小攻击面）。
# 使用方式：docker build --build-arg ENABLE_GUI_TOOLS=1 -t skyalyticwing-web .
ARG ENABLE_GUI_TOOLS=0
RUN if [ "$ENABLE_GUI_TOOLS" = "1" ]; then \
      apt-get update && apt-get install -y --no-install-recommends \
        xdotool scrot libnotify-bin imagemagick \
      && rm -rf /var/lib/apt/lists/*; \
    fi

WORKDIR /app

COPY package*.json ./
# M-I4 fix: 移除 `|| npm install` 静默回退，仅使用 npm ci。
# 之前 `npm ci --only=production || npm install --production` 在 lockfile 不同步时
# 静默回退到 npm install，掩盖 lockfile 不一致问题并可能安装非预期版本。
# 若 lockfile 缺失或不同步，应让构建失败而非静默回退。
RUN npm ci --only=production

COPY . .

RUN mkdir -p /app/data /app/workspace /app/skills /app/logs

# C-D6 fix: 创建非 root 用户运行容器进程，避免以 root 启动。
RUN groupadd -r app && useradd -r -g app -m -d /home/app app \
    && chown -R app:app /app
USER app

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/app/data
ENV WORKSPACE_DIR=/app/workspace
ENV SKILLS_DIR=/app/skills

EXPOSE 3000

VOLUME ["/app/data", "/app/workspace", "/app/skills", "/app/logs"]

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD curl -f http://localhost:3000/api/health || exit 1

CMD ["node", "start.cjs"]
