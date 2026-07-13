# --- Build stage: full deps + TypeScript compile ---
FROM node:22-alpine AS build

WORKDIR /app

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile

COPY . .
RUN yarn build

# --- Production stage: prod deps only, non-root ---
FROM node:22-alpine AS production

WORKDIR /app
ENV NODE_ENV=production

COPY package.json yarn.lock ./
# --ignore-scripts skips the husky "prepare" hook (no .git in the image)
RUN yarn install --frozen-lockfile --production --ignore-scripts && yarn cache clean

COPY --from=build /app/dist ./dist

USER node

EXPOSE 5000

CMD ["node", "dist/index.js"]
