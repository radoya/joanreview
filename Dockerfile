FROM apify/actor-node-playwright:20

# Copy package.json and package-lock.json (if available)
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the source files
COPY . .

# Set the command to run your actor
CMD ["npm", "start"]
