# Build context is the solution root (the folder with the .sln). See docker-compose.yml.
FROM mcr.microsoft.com/dotnet/aspnet:9.0 AS base
USER $APP_UID
WORKDIR /app
EXPOSE 8080

FROM mcr.microsoft.com/dotnet/sdk:9.0 AS build
ARG BUILD_CONFIGURATION=Release
WORKDIR /src
# Copy only the csproj files first so the restore layer is cached.
# The web project references Application, so copy both.
COPY ["SteamEGSAggregator/SteamEGSAggregator.csproj", "SteamEGSAggregator/"]
COPY ["Application/SteamEGSAggregator.Application.csproj", "Application/"]
RUN dotnet restore "SteamEGSAggregator/SteamEGSAggregator.csproj"

COPY . .
WORKDIR "/src/SteamEGSAggregator"
RUN dotnet build "SteamEGSAggregator.csproj" -c $BUILD_CONFIGURATION -o /app/build

FROM build AS publish
ARG BUILD_CONFIGURATION=Release
RUN dotnet publish "SteamEGSAggregator.csproj" -c $BUILD_CONFIGURATION -o /app/publish /p:UseAppHost=false

FROM base AS final
WORKDIR /app
COPY --from=publish /app/publish .
ENTRYPOINT ["dotnet", "SteamEGSAggregator.dll"]
