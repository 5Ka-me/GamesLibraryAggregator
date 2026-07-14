# Monorepo-aware build: the web app depends on the @app/shared workspace
# package, so the build context must be the REPO ROOT (see docker-compose.yml:
#   context: ..  /  dockerfile: steam-egs-aggregator/Dockerfile).

# --- Build the React app (CRA) ---
FROM node:20-alpine AS build
WORKDIR /repo

# Install dependencies for the web app + shared package only. The Electron
# launcher's package.json is copied just so npm can resolve the workspace list
# (its deps — electron etc. — are NOT installed thanks to the -w filters).
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY steam-egs-aggregator/package.json steam-egs-aggregator/
COPY steam-egs-launcher/package.json steam-egs-launcher/
RUN npm ci -w packages/shared -w steam-egs-aggregator --no-audit --no-fund

# Sources: shared first (compiled to dist), then the web app.
COPY packages/shared packages/shared
COPY steam-egs-aggregator steam-egs-aggregator

# The backend address is baked into the bundle at build time (CRA reads REACT_APP_* during build).
ARG REACT_APP_API_URL=http://localhost:8080
ENV REACT_APP_API_URL=$REACT_APP_API_URL

RUN npm run build -w packages/shared && npm run build -w steam-egs-aggregator

# --- Serve static files via nginx ---
FROM nginx:alpine AS final
COPY steam-egs-aggregator/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/steam-egs-aggregator/build /usr/share/nginx/html
EXPOSE 80
