FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS web
WORKDIR /src/apps/web
COPY apps/web/package*.json ./
RUN npm ci --no-audit --no-fund
COPY apps/web/tsconfig.json apps/web/build.mjs ./
COPY apps/web/src/ src/
RUN npm run build

FROM --platform=$BUILDPLATFORM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
COPY global.json ./
COPY apps/api/*.csproj apps/api/packages.lock.json apps/api/
RUN dotnet restore apps/api/InterviewPrep.Api.csproj --locked-mode
COPY apps/api/*.cs apps/api/appsettings.json apps/api/
COPY apps/api/Prompts/ apps/api/Prompts/
COPY apps/api/wwwroot/index.html apps/api/wwwroot/
COPY --from=web /src/apps/api/wwwroot/assets/ apps/api/wwwroot/assets/
ARG SOURCE_REVISION
RUN dotnet publish apps/api/InterviewPrep.Api.csproj -c Release --no-restore -p:UseAppHost=false -p:SourceRevisionId="$SOURCE_REVISION" -o /out && mkdir /empty-data

FROM mcr.microsoft.com/dotnet/aspnet:10.0
WORKDIR /app
COPY --from=build /out/ ./
ENV INTERVIEW_PREP_PORT=5187 INTERVIEW_PREP_PRIVATE_CONTAINER=1 INTERVIEW_PREP_DATA=/var/lib/interview-prep
COPY --from=build --chown=app:app /empty-data/ /var/lib/interview-prep/
USER app
EXPOSE 5187
ENTRYPOINT ["dotnet", "InterviewPrep.Api.dll"]
