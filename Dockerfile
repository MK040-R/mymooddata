FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY moodbot moodbot
ENV DB_PATH=/data/mood.db
VOLUME /data
CMD ["python", "-m", "moodbot"]
