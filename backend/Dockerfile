FROM python:3.13-slim@sha256:8d9d0b8bcf6506481eae4907c18f5e3e7902e629f5f6d684f9e7c32e85e3ddf0

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONUTF8=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    ORBITDUO_DB_PATH=/data/runs.sqlite3 \
    OMP_NUM_THREADS=1 \
    OPENBLAS_NUM_THREADS=1

WORKDIR /app
COPY participant_package/requirements.txt participant_package/requirements.txt
COPY backend/requirements.txt backend/requirements.txt
RUN python -m pip install --no-cache-dir -r backend/requirements.txt \
    && python -m pip check \
    && groupadd --gid 10001 orbitduo \
    && useradd --uid 10001 --gid orbitduo --no-create-home --home-dir /app orbitduo \
    && mkdir /data \
    && chown orbitduo:orbitduo /data

COPY backend/ backend/
COPY participant_package/ participant_package/
USER 10001:10001
EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=3s --start-period=45s --retries=6 \
    CMD python -c "import json,urllib.request; r=json.load(urllib.request.urlopen('http://127.0.0.1:8000/api/v1/health',timeout=2)); assert r['status']=='ok'"
CMD ["python", "-m", "uvicorn", "backend.app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--timeout-graceful-shutdown", "300"]
