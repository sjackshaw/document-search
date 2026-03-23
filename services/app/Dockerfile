FROM node:22-slim

WORKDIR /repo/services/app

COPY services/app/package*.json ./
RUN npm install --omit=dev

# Ensure the transformers local cache dir is writable by node user
RUN mkdir -p /repo/services/app/node_modules/@xenova/transformers/.cache && \
    chown -R node:node /repo/services/app/node_modules/@xenova/transformers/.cache

COPY --chown=node:node services/app/ ./
COPY --chown=node:node lib/ /repo/lib/

RUN mkdir -p /home/node/.cache/huggingface/hub && chown -R node:node /home/node/.cache

USER node

ENV NODE_PATH=/repo/services/app/node_modules

EXPOSE 3000

CMD ["node", "src/index.js"]
