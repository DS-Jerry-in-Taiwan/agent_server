FROM python:3.12-slim AS base

# 安裝 OpenCV 依賴 + pip 使用清華源
RUN apt-get update && apt-get install -y libgl1 libglib2.0-0 && \
    pip install --no-cache-dir -i https://pypi.tuna.tsinghua.edu.cn/simple ruamel.yaml av robyn opencv-python && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

FROM base AS agent

WORKDIR /home/ubuntu/agent_server

COPY . .

EXPOSE 5000

CMD ["python", "agent.py"]