FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY server.py config.json ./
COPY static ./static
ENV LIQ_HOST=0.0.0.0 LIQ_PORT=8787 LIQ_STATE_FILE=/data/state.json PYTHONUNBUFFERED=1
VOLUME ["/data"]
EXPOSE 8787
CMD ["python", "server.py"]
