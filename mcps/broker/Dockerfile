# Build context is the repository root: docker build -f mcps/broker/Dockerfile .
FROM python:3.13-slim AS build
COPY --from=ghcr.io/astral-sh/uv:0.11.32 /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/app/.venv
WORKDIR /build
COPY mcps/broker/pyproject.toml mcps/broker/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY mcps/broker/src ./src
RUN uv sync --frozen --no-dev --no-editable

FROM python:3.13-slim AS runner
RUN useradd --system --uid 10001 --no-create-home broker
WORKDIR /app
COPY --from=build /app/.venv /app/.venv
ENV PATH=/app/.venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=3000
USER broker
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import os,sys,urllib.request; u='http://127.0.0.1:%s%s/healthz' % (os.environ.get('PORT','3000'), os.environ.get('BASE_PATH','')); sys.exit(0 if urllib.request.urlopen(u, timeout=4).status == 200 else 1)"
CMD ["python", "-m", "broker"]
