FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

########################################################
# SYSTEM DEPENDENCIES
########################################################

RUN apt-get update && apt-get install -y \
    curl \
    ca-certificates \
    git \
    gnupg \
    build-essential \
    python3 \
    sudo \
    && rm -rf /var/lib/apt/lists/*

########################################################
# UBUNTU USER
########################################################

RUN mkdir -p /etc/ssh/sshd_config.d && \
    printf '%s\n' 'PasswordAuthentication no' 'ChallengeResponseAuthentication no' 'UsePAM no' \
    > /etc/ssh/sshd_config.d/disable_password_auth.conf

RUN id -u ubuntu >/dev/null 2>&1 || useradd -m -s /bin/bash ubuntu
RUN groupadd -f docker && usermod -aG docker ubuntu
RUN usermod -aG sudo ubuntu
RUN echo "ubuntu ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/ubuntu
RUN echo "ubuntu:ubuntu" | chpasswd

RUN printf '%s\n' \
    'export NVM_DIR="/home/ubuntu/.nvm"' \
    '[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"' \
    '[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"' \
    | tee /etc/profile.d/nvm.sh >> /home/ubuntu/.bashrc

########################################################
# DOCKER INSTALLATION
########################################################

RUN install -m 0755 -d /etc/apt/keyrings && \
    curl --retry 3 --retry-delay 5 -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --batch --dearmor -o /etc/apt/keyrings/docker.gpg && \
    chmod a+r /etc/apt/keyrings/docker.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
    $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null && \
    apt-get update && \
    apt-get install -y \
    docker-ce=5:28.5.2-1~ubuntu.24.04~noble \
    docker-ce-cli=5:28.5.2-1~ubuntu.24.04~noble \
    containerd.io \
    docker-buildx-plugin \
    docker-compose-plugin \
    && rm -rf /var/lib/apt/lists/*

RUN apt-get update && apt-get install -y \
    fuse-overlayfs \
    iptables \
    && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /etc/docker && \
    printf '%s\n' '{' \
    '  "storage-driver": "fuse-overlayfs"' \
    '}' > /etc/docker/daemon.json
RUN update-alternatives --set iptables /usr/sbin/iptables-legacy && \
    update-alternatives --set ip6tables /usr/sbin/ip6tables-legacy

########################################################
# NVM + COREPACK
########################################################

ENV NVM_DIR=/home/ubuntu/.nvm

RUN mkdir -p $NVM_DIR && \
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash && \
    . "$NVM_DIR/nvm.sh" && \
    nvm install 24 && \
    corepack enable

RUN chown -R ubuntu:ubuntu $NVM_DIR

########################################################
# AGENTFILES
########################################################

ADD --keep-git-dir=true \
  https://github.com/martindzejky/agentfiles.git#master \
  /home/ubuntu/.agentfiles

RUN mkdir -p /home/ubuntu/.cursor && \
    cd /home/ubuntu/.agentfiles && \
    git submodule update --init --recursive && \
    HOME=/home/ubuntu ./install

RUN chown -R ubuntu:ubuntu /home/ubuntu

# Workaround: expose ~/.cursor at the filesystem root so Cursor's upward walk finds it
RUN ln -s /home/ubuntu/.cursor /.cursor

########################################################
# SET USER
########################################################

USER ubuntu
WORKDIR /home/ubuntu
