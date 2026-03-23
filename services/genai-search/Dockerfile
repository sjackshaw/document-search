FROM node:22-slim

WORKDIR /repo/services/genai-search

COPY services/genai-search/package*.json ./
RUN npm install --omit=dev

# Ensure the transformers local cache dir is writable by node user
RUN mkdir -p /repo/services/genai-search/node_modules/@xenova/transformers/.cache && \
    chown -R node:node /repo/services/genai-search/node_modules/@xenova/transformers/.cache

COPY --chown=node:node services/genai-search/ ./
COPY --chown=node:node lib/ /repo/lib/

RUN mkdir -p /home/node/.cache/huggingface/hub && chown -R node:node /home/node/.cache

USER node

ENV NODE_PATH=/repo/services/genai-search/node_modules

EXPOSE 3001

CMD ["node", "src/index.js"]
