FROM node:22-alpine

WORKDIR /app

# Copy dependency files
COPY package.json yarn.lock ./

# Install all dependencies
RUN yarn install --frozen-lockfile

# Copy project files
COPY . .

# Build the application
RUN yarn build

# Expose app port
EXPOSE 5175

# Start the app
CMD ["node", "dist/index.js"]