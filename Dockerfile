# PiClaw - Minimal Pi Coding Agent Sandbox
FROM debian:bookworm-slim

# Environment variables
ENV DEBIAN_FRONTEND=noninteractive \
    TERM=xterm-256color \
    LANG=en_US.UTF-8 \
    LANGUAGE=en_US:en \
    LC_ALL=en_US.UTF-8 \
    HOME=/home/agent

WORKDIR /tmp

# Layer 1: System packages (minimal set for bun/brew/pi)
RUN apt-get update && \
    apt-get install -y --no-install-recommends locales tzdata && \
    sed -i '/en_US.UTF-8/s/^# //g' /etc/locale.gen && \
    locale-gen en_US.UTF-8 && \
    update-locale LANG=en_US.UTF-8 && \
    apt-get upgrade -y && \
    apt-get install -y --no-install-recommends \
    ca-certificates curl wget unzip \
    bash-completion sudo less man \
    git vim tmux htop tree ripgrep jq \
    net-tools iproute2 dnsutils \
    rsync file strace \
    build-essential cmake make pkg-config \
    procps psmisc && \
    apt-get autoremove -y && apt-get clean && rm -rf /var/lib/apt/lists/*

# Layer 2: Create user
RUN useradd -m -s /bin/bash -G sudo agent && \
    echo 'agent:agent' | chpasswd && \
    echo 'agent ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers && \
    mkdir -p /etc/skel.agent

# Layer 3: Entrypoint with home directory initialization
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Layer 4: Install Homebrew, Bun, and Pi Coding Agent as agent
USER agent
WORKDIR /home/agent
RUN /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" && \
    echo 'eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"' >> ~/.bashrc && \
    eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)" && \
    brew update && \
    brew install lazygit && \
    curl -fsSL https://bun.sh/install | bash && \
    export BUN_INSTALL="$HOME/.bun" && export PATH="$BUN_INSTALL/bin:$PATH" && \
    bun add -g @mariozechner/pi-coding-agent && \
    PI_CLI="$(readlink -f $BUN_INSTALL/bin/pi)" && \
    rm "$BUN_INSTALL/bin/pi" && \
    printf '#!/usr/bin/env bash\nexec bun "%s" "$@"\n' "$PI_CLI" > "$BUN_INSTALL/bin/pi" && \
    chmod +x "$BUN_INSTALL/bin/pi"

# Set up pi config directories and global AGENTS.md
RUN mkdir -p ~/.pi/agent/skills ~/.pi/agent/sessions \
             ~/.pi/agent/extensions ~/.pi/agent/prompts ~/.pi/agent/themes

# Ship workspace skeleton (includes .pi/skills/ and AGENTS.md)
COPY --chown=agent:agent skel/ /home/agent/workspace-skel/

# Ship piclaw global skills (IPC: schedule, send-message)
COPY --chown=agent:agent piclaw/skills/ /home/agent/.pi/agent/skills/

# Ship piclaw orchestrator and install as global binary
COPY --chown=agent:agent piclaw/ /home/agent/piclaw/
RUN export BUN_INSTALL="$HOME/.bun" && export PATH="$BUN_INSTALL/bin:$PATH" && \
    cd /home/agent/piclaw && bun install --frozen-lockfile 2>/dev/null || bun install && \
    bun link

# Layer 5: Save skeleton
USER root
RUN cp -a /home/agent/. /etc/skel.agent/ && \
    echo "Skeleton: $(find /etc/skel.agent -type f | wc -l) files"

ENTRYPOINT ["/entrypoint.sh"]
