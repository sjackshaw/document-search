FROM node:22-slim

WORKDIR /repo/services/etl-webcrawl

COPY services/etl-webcrawl/package*.json ./
RUN npm install --omit=dev

# Ensure the transformers local cache dir is writable by node user
RUN mkdir -p /repo/services/etl-webcrawl/node_modules/@xenova/transformers/.cache && \
    chown -R node:node /repo/services/etl-webcrawl/node_modules/@xenova/transformers/.cache

COPY --chown=node:node services/etl-webcrawl/ ./
COPY --chown=node:node lib/ /repo/lib/

RUN mkdir -p /home/node/.cache/huggingface/hub && chown -R node:node /home/node/.cache

USER node

ENV NODE_PATH=/repo/services/etl-webcrawl/node_modules

CMD ["node", "--max-old-space-size=8192", "--expose-gc", "vectorize.js"]
