# FirstLight Compose — full app image (Tier-1 single-node cloud deploy).
# Layers the Next.js server on top of the proven toolchain base, so one
# container serves the UI AND runs the pipeline. Single-node by design: jobs
# are serialized by an in-process lock (do not horizontally scale this image;
# that's Tier 2 — a worker fleet + queue + object storage).
#
#   docker build -f deploy/Dockerfile -t firstlight-app .
#   (see deploy/README.md for compose + ingress)
#
# NOTE: this tree's npm lockfile is currently broken (`npm ci` fails). Until
# it's repaired, the Node deps must be installed with `npm install --no-audit
# --no-fund --force` in the build, or a known-good node_modules baked in a
# prior good install. The build below uses --force; harden the lockfile before
# relying on this for reproducible prod builds.
FROM firstlight-toolchain AS base

# Node.js 20 (Next 16 needs 18.18+/20+).
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app/software/prompt-to-pcb-ui
# deps first for layer caching (see the lockfile caveat above)
COPY software/prompt-to-pcb-ui/package.json software/prompt-to-pcb-ui/package-lock.json* ./
RUN npm install --no-audit --no-fund --force

# app + the pipeline scripts it shells out to (repo layout preserved so the
# route's relative ../../ spawns resolve identically to the Mac)
COPY software/prompt-to-pcb-ui ./
COPY hardware /app/hardware
COPY tools /app/tools
RUN npm run build

# Linux toolchain env (inherited from base) + app runtime.
ENV NODE_ENV=production \
    PORT=4500 \
    FL_TERMINAL=0
# Metered LLM keys + AUTH_SECRET come from the runtime env / compose, never baked.

EXPOSE 4500
CMD ["npm", "run", "start"]
