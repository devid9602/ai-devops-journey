FROM node:26-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json ./
COPY src ./src
# Run as the unprivileged user shipped in the image; the task also mounts the root filesystem read-only.
USER node
EXPOSE 8080
CMD ["node", "src/server.js"]
