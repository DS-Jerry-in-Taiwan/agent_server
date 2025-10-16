FROM python:3.12-slim

WORKDIR /home/ubuntu/agent_server

COPY . .

# 安裝 OpenCV 依賴
RUN apt-get update && apt-get install -y libgl1 libglib2.0-0 && \
    pip install --no-cache-dir robyn opencv-python && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

EXPOSE 5000

CMD ["python", "agent.py"]