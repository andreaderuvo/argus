# Argus in a container, for Windows-through-WSL and for anyone who would rather not install
# Python. Built from this directory: there is no build step, so the image is the source plus
# five wheels.
#
#   docker build -t argus .
#
# Read `docker-compose.yml` before running it. The short version: this container is a way to
# get the *runtime*, not a sandbox. Argus's whole job is to attach to the tmux sessions and
# read the files of the machine it runs on, so it has to be given that machine — the host's
# PID namespace, the host's tmux socket, and your home at the same path it has on the host.
# A hermetically sealed Argus would be an Argus attached to an empty container.
FROM python:3.13-slim

# tmux as a *client*, talking to the host's server over the mounted socket. procps for the
# process lookups that say which agent is in a pane and what folder it is in.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tmux procps \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/argus

# Only the runtime block — everything under `# Tests` belongs to people working on Argus.
COPY requirements.txt ./
RUN sed '/^# Tests/,$d' requirements.txt > /tmp/runtime.txt \
 && pip install --no-cache-dir -r /tmp/runtime.txt \
 && rm /tmp/runtime.txt

COPY app ./app
COPY static ./static
COPY tools ./tools

EXPOSE 8090

# 0.0.0.0 because the only thing that can reach it is what the port mapping allows, and a
# container that listens on its own loopback is a container nothing can talk to.
ENTRYPOINT ["python", "-m", "app.main", "--listen", "0.0.0.0:8090"]
