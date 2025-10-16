# agent.py - 使用 Robyn 框架寫成的 API server 範例
# 此範例模擬截圖功能，並提供圖片 URL 給前端使用。
# 安裝 Robyn: pip install robyn
# 運行: python agent.py

from robyn import Robyn, Request, Response
import json
import cv2
import os
from datetime import datetime
import uuid  # 用於生成唯一檔案名稱

# 初始化 Robyn 應用
app = Robyn(__file__)

# 新增：從環境變數取得 NGINX 對外 base URL，預設 http://localhost:8080
NGINX_BASE_URL = os.environ.get("NGINX_BASE_URL", "http://localhost:8080")


# 設定 CORS（允許跨域請求，因為 VIA 可能從不同來源載入圖片）
@app.before_request
def cors_middleware(request: Request):
    if request.method == "OPTIONS":
        response = Response()
        response.headers["Access-Control-Allow-Origin"] = "*"
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
        response.headers["Access-Control-Allow-Headers"] = "Content-Type"
        return response
    # 其他請求不攔截，讓路由繼續執行
    return None

@app.post("/rtsp_snapshot")
async def rtsp_snapshot(request: Request):
    try:
        body = request.json() if request.body else {}
        rtsp_url = body.get("rtsp_url")
        if not rtsp_url:
            return Response(
                description=json.dumps({"error": "Missing rtsp_url", "status": "failed"}),
                status_code=400,
                headers={"Content-Type": "application/json"}
            )

        cap = cv2.VideoCapture(rtsp_url)
        ret, frame = cap.read()
        cap.release()
        if not ret:
            return Response(
                description=json.dumps({"error": "Failed to capture frame", "status": "failed"}),
                status_code=500,
                headers={"Content-Type": "application/json"}
            )

        filename = f"rtsp_{uuid.uuid4().hex}.jpg"
        save_path = os.path.join("via/via-2.x.y/img", filename)
        os.makedirs("img", exist_ok=True)
        cv2.imwrite(save_path, frame)

        server_url = "http://127.0.0.1:5000"
        image_url = f"{server_url}/img/{filename}"
        response_data = {
            "url": image_url,
            "filename": filename,
            "timestamp": datetime.now().isoformat(),
            "status": "success"
        }
        return Response(
            description=json.dumps(response_data),
            status_code=200,
            headers={"Content-Type": "application/json"}
        )

    except Exception as e:
        return Response(
            description=json.dumps({"error": str(e), "status": "failed"}),
            status_code=500,
            headers={"Content-Type": "application/json"}
        )

@app.post("/rtsp_snapshot_with_roi_url")
async def rtsp_snapshot_with_roi_url(request: Request):
    """
    接收 rtsp_url，截圖後存到 img/，並回傳圖片網址與 ROI 編輯頁網址
    """
    try:
        body = request.json() if request.body else {}
        rtsp_url = body.get("rtsp_url")
        if not rtsp_url:
            return Response(
                description=json.dumps({"error": "Missing rtsp_url", "status": "failed"}),
                status_code=400,
                headers={"Content-Type": "application/json"}
            )

        cap = cv2.VideoCapture(rtsp_url)
        ret, frame = cap.read()
        cap.release()
        if not ret:
            return Response(
                description=json.dumps({"error": "Failed to capture frame", "status": "failed"}),
                status_code=500,
                headers={"Content-Type": "application/json"}
            )

        filename = f"rtsp_{uuid.uuid4().hex}.jpg"
        save_path = os.path.join("img", filename)
        os.makedirs("img", exist_ok=True)
        cv2.imwrite(save_path, frame)

       # 用 NGINX 對外 base URL 組合圖片網址與 ROI 編輯頁網址
        img_url = f"{NGINX_BASE_URL}/img/{filename}"
        roi_edit_url = f"{NGINX_BASE_URL}/via/via-2.x.y/src/index.html?screenshot_url={img_url}"

        response_data = {
            "img_url": img_url,
            "roi_edit_url": roi_edit_url,
            "filename": filename,
            "timestamp": datetime.now().isoformat(),
            "status": "success"
        }
        return Response(
            description=json.dumps(response_data),
            status_code=200,
            headers={"Content-Type": "application/json"}
        )

    except Exception as e:
        return Response(
            description=json.dumps({"error": str(e), "status": "failed"}),
            status_code=500,
            headers={"Content-Type": "application/json"}
        )

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# # 提供圖片檔案的端點（GET /img/<filename>）
@app.get("/via/via-2.x.y/img/*filename")
async def serve_image(request: Request):
    print(f"DEBUG: BASE_DIR={BASE_DIR}", flush=True)
    image_path = os.path.join(BASE_DIR, "img", request.path_params["filename"])
    print(f"DEBUG: filename={repr(request.path_params['filename'])}", flush=True)
    print(f"DEBUG: image_path={image_path}", flush=True)
    print(f"DEBUG: os.path.exists(image_path)={os.path.exists(image_path)}", flush=True)
    if os.path.exists(image_path):
        with open(image_path, "rb") as f:
            image_data = f.read()
        return Response(status_code=200, headers={"Content-Type": "image/png"}, description=image_data)
    else:
        return Response(status_code=404, headers={}, description="Image not found")

@app.get("/healthcheck")
async def healthcheck(request: Request):
    print("DEBUG: /healthcheck 被呼叫", flush=True)
    return Response(status_code=200, headers={}, description="OK")

# 啟動伺服器
if __name__ == "__main__":
    print("啟動 Robyn API server...")
    print("截圖端點: POST http://127.0.0.1:5000/screenshot")
    print("圖片端點: GET http://127.0.0.1:5000/img/<filename>")
    app.start(host="0.0.0.0", port=5000)  # 監聽所有介面，方便內網訪問