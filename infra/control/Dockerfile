FROM node:22-bookworm-slim
WORKDIR /control
COPY scripts/check-release.mjs scripts/
COPY infra/control/*.mjs infra/control/
USER node
ENTRYPOINT ["node","/control/infra/control/controller.mjs"]
