# Agent Evidence API — watchdog container
#
# The watchdog must outlive shell sessions: the two outages it exists to prevent
# (2026-09-22 and 2026-09-24..2026-10-18) both happened because the tunnel and
# its supervisor were session processes started with setsid/nohup, while the
# Docker-managed backend container survived untouched ("Up 3 weeks"). So the
# watchdog is a container with `--restart unless-stopped`, not a cron job.
#
# Why a custom image at all: the container's only real dependencies are the
# docker CLI (for the mounted socket), curl (for the deep health probe) and
# bash (scripts/watchdog.sh). It also needs a glibc userland, because the
# wrappers the watchdog calls — /root/Agents Projects/bin/{node,pnpm,wrangler} —
# exec the workspace's glibc-linked Node 24 build. That rules out alpine/musl,
# so this is Debian slim.
#
# The docker CLI is copied out of the official CLI image instead of apt-installing
# docker.io, which would drag the whole daemon in for one static binary.
FROM docker:27-cli AS dockercli

FROM node:24-slim

# curl for the deep health probe and the origin probe; ca-certificates so those
# HTTPS calls can verify the Worker's certificate.
RUN apt-get update \
 && apt-get install -y --no-install-recommends bash curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# The docker CLI (static Go binary) for the bind-mounted /var/run/docker.sock.
# It lives at /usr/bin/docker as well because the workspace wrapper
# /root/Agents Projects/bin/docker execs exactly that path, and that wrapper is
# what PATH resolves inside this container.
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
RUN ln -sf /usr/local/bin/docker /usr/bin/docker \
 && docker --version

# The repo is bind-mounted at its real absolute path (see README), so the loop
# script is read from the mount rather than baked in: editing it and restarting
# the container is enough, no rebuild. This WORKDIR is only a default for
# `docker exec` sessions.
WORKDIR /root/Agents Projects/agent-evidence-api

# PATH must lead with the workspace bin dir or wrangler/pnpm/node do not resolve
# (they are wrappers around the workspace install, not system packages).
# The ENV below covers the container's own processes; the profile.d snippet
# covers `docker exec ... bash -l` sessions, where /etc/profile would otherwise
# reset PATH to the image's own node and hide pnpm/wrangler entirely.
RUN printf 'export PATH=/root/Agents Projects/bin:$PATH\n' > /etc/profile.d/00-workspace-path.sh \
 && chmod 644 /etc/profile.d/00-workspace-path.sh
ENV PATH=/root/Agents Projects/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    HOME=/root \
    XDG_CONFIG_HOME=/root/Agents Projects/.config \
    WATCHDOG_INTERVAL=60

# Long-running loop by default. It never exits on its own; `--once` is available
# for a single cycle, and `docker logs aee-watchdog` shows the deploy output too.
CMD ["bash", "/root/Agents Projects/agent-evidence-api/scripts/watchdog.sh"]
