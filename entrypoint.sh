#!/bin/bash
set -e

MARKER_FILE="/home/agent/.container_initialized"
HOME_DIR="/home/agent"
SKEL_DIR="/etc/skel.agent"

if [ ! -f "$MARKER_FILE" ] || [ ! -f "$HOME_DIR/.bashrc" ]; then
    echo "Initializing home directory..."
    if [ -d "$SKEL_DIR" ] && [ "$(ls -A $SKEL_DIR 2>/dev/null)" ]; then
        cp -a "$SKEL_DIR/." "$HOME_DIR/"
    fi

    if [ ! -f "$HOME_DIR/.bashrc" ]; then
        cat > "$HOME_DIR/.bashrc" <<'BASHRC'
case $- in *i*) ;; *) return;; esac
HISTCONTROL=ignoreboth
shopt -s histappend
HISTSIZE=1000
HISTFILESIZE=2000
shopt -s checkwinsize
PS1='\[\033[01;32m\]\u@\h\[\033[00m\]:\[\033[01;34m\]\w\[\033[00m\]\$ '
if [ -x /usr/bin/dircolors ]; then
    test -r ~/.dircolors && eval "$(dircolors -b ~/.dircolors)" || eval "$(dircolors -b)"
    alias ls='ls --color=auto'
    alias grep='grep --color=auto'
fi
alias ll='ls -alF'
alias la='ls -A'
[ -d /home/linuxbrew/.linuxbrew ] && eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"
[ -d "$HOME/.bun" ] && export BUN_INSTALL="$HOME/.bun" && export PATH="$BUN_INSTALL/bin:$PATH"
BASHRC
    fi

    if [ ! -f "$HOME_DIR/.profile" ]; then
        cat > "$HOME_DIR/.profile" <<'PROFILE'
[ -n "$BASH_VERSION" ] && [ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc"
[ -d "$HOME/bin" ] && PATH="$HOME/bin:$PATH"
PROFILE
    fi

    # Ensure pi config directories exist
    mkdir -p "$HOME_DIR/.pi/agent/skills" \
             "$HOME_DIR/.pi/agent/sessions" \
             "$HOME_DIR/.pi/agent/extensions" \
             "$HOME_DIR/.pi/agent/prompts" \
             "$HOME_DIR/.pi/agent/themes"

    # Symlink persistent config from /config if mounted
    for item in .gitconfig .pi; do
        target="/config/$item"
        link="$HOME_DIR/$item"
        if [ -e "$target" ] || [ -d "$target" ]; then
            rm -rf "$link" 2>/dev/null || true
            ln -sf "$target" "$link"
        fi
    done

    chown -R agent:agent "$HOME_DIR"
    echo "$(id -u agent):$(id -g agent)" > "$MARKER_FILE"
fi

# Ensure workspace has AGENTS.md (system prompt for pi)
if [ -d "/workspace" ] && [ ! -f "/workspace/AGENTS.md" ]; then
    if [ -f "$HOME_DIR/workspace-skel/AGENTS.md" ]; then
        cp "$HOME_DIR/workspace-skel/AGENTS.md" /workspace/AGENTS.md
        chown agent:agent /workspace/AGENTS.md
    fi
fi

# Ensure workspace has project-level skills
if [ -d "/workspace" ] && [ ! -d "/workspace/.pi/skills" ]; then
    if [ -d "$HOME_DIR/workspace-skel/.pi/skills" ]; then
        mkdir -p /workspace/.pi
        cp -a "$HOME_DIR/workspace-skel/.pi/skills" /workspace/.pi/skills
        chown -R agent:agent /workspace/.pi
    fi
fi

echo "=== PiClaw - Pi Coding Agent Sandbox ==="
echo "Container idle. Attach with: docker exec -u agent -it <name> bash"
echo "Run 'pi' for interactive mode, or start piclaw for WhatsApp integration."
exec tail -f /dev/null