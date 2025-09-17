FROM apify/actor-node:20

# Copy package manifests and install production deps
COPY package*.json ./
RUN npm --quiet set progress=false \
    && npm install --omit=dev --omit=optional \
    && (npm list --omit=dev --all || true)

# Copy source
COPY . ./

# Start the actor
CMD npm start --silent
