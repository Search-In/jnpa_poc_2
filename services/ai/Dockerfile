# AI services (Python/FastAPI + scikit-learn). One image; AI_MODEL selects which
# model to serve (dwell-predictor|gate-queue-forecaster|rake-tat-forecaster|
# event-anomaly-detector). The model trains on import (seeded synthetic data) and
# writes metrics.json.
FROM python:3.12-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1 PYTHONPATH=/app/services/ai
RUN pip install --no-cache-dir fastapi "uvicorn[standard]" "pydantic>=2.9" numpy scikit-learn
COPY services/ai /app/services/ai
EXPOSE 8200
# launch.py loads the hyphenated model dir by file path and serves its `app`.
CMD ["python", "/app/services/ai/launch.py"]
