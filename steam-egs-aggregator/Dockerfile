# --- Build the React app (CRA) ---
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
# npm install (not ci) — tolerant of minor lock-file drift across npm versions.
RUN npm install --no-audit --no-fund
COPY . .
# The backend address is baked into the bundle at build time (CRA reads REACT_APP_* during build).
ARG REACT_APP_API_URL=http://localhost:8080
ENV REACT_APP_API_URL=$REACT_APP_API_URL
RUN npm run build

# --- Serve static files via nginx ---
FROM nginx:alpine AS final
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/build /usr/share/nginx/html
EXPOSE 80
