# Connectors (Python/FastAPI). One image; the CONNECTOR env selects which app to
# serve (ulip|icegate|tos|fois|eseal|shipline). Runs in sim mode by default.
FROM python:3.12-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1 PYTHONPATH=/app/services/connectors
RUN pip install --no-cache-dir fastapi "uvicorn[standard]" "pydantic>=2.9" httpx
COPY services/connectors /app/services/connectors
COPY config /app/config
EXPOSE 8100
# CONNECTOR selects the module; defaults to ulip.
CMD ["sh", "-c", "uvicorn ${CONNECTOR:-ulip}.connector:app --host 0.0.0.0 --port 8100"]
