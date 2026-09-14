FROM node:22-alpine AS frontend
WORKDIR /build
COPY package.json package-lock.json* ./
RUN npm ci
COPY frontend ./frontend
COPY tsconfig.json vite.config.ts ./
RUN npm run build

FROM python:3.12-slim AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
RUN useradd --create-home --uid 10001 aonote
COPY pyproject.toml LICENSE THIRD_PARTY_NOTICES.md ./
COPY backend ./backend
COPY --from=frontend /build/backend/aonote/static ./backend/aonote/static
RUN python -m pip install --no-cache-dir --upgrade "pip>=26.1.2" "setuptools>=83"
RUN python -m pip install --no-cache-dir .
RUN mkdir -p /data && chown -R aonote:aonote /data /app
USER aonote
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/readyz', timeout=3)"]
CMD ["uvicorn", "aonote.main:app", "--host", "0.0.0.0", "--port", "8000", "--no-access-log"]
