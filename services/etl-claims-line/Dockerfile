FROM node:22
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

# Ensure the transformers local cache dir is writable by node user
RUN mkdir -p /app/node_modules/@xenova/transformers/.cache && \
    chown -R node:node /app/node_modules/@xenova/transformers/.cache

COPY --chown=node:node . .
RUN mkdir -p /app/data && chown node:node /app/data
RUN mkdir -p /home/node/.cache/huggingface/hub && chown -R node:node /home/node/.cache
USER node
CMD ["node", "vectorize.js"]
