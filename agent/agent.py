# agent.py - 使用 Robyn 框架寫成的 API server 範例
# 此範例模擬截圖功能，並提供圖片 URL 給前端使用。
# 安裝 Robyn: pip install robyn
# 運行: python agent.py

from robyn import Robyn, Request, Response
import json
import ruamel.yaml
import cv2
import av
import os
import mimetypes
from datetime import datetime
from dotenv import load_dotenv
import uuid  # 用於生成唯一檔案名稱

load_dotenv()

# 初始化 Robyn 應用
app = Robyn(__file__)

# 新增：從環境變數取得 NGINX 對外 base URL，預設 http://localhost:8080
NGINX_BASE_URL = os.environ.get("NGINX_BASE_URL", "http://localhost:8080")


def add_cors_headers(response):
    print("[API] add_cors_headers 被調用", flush=True)
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type"
    return response

# 設定 CORS（允許跨域請求，因為 VIA 可能從不同來源載入圖片）
@app.before_request
def cors_middleware(request: Request):
    print("[API] cors_middleware 被調用", flush=True)
    if request.method == "OPTIONS":
        return Response(
        status_code=200,
        headers={
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type"
        },
        description=""
    )

BASE_DIR = os.path.dirname(__file__)

class FlowStyleList(list):
    pass

def represent_flow_style_list(dumper, data):
    return dumper.represent_sequence('tag:yaml.org,2002:seq', data, flow_style=True)

# 註冊 FlowStyleList 的 representer
ruamel.yaml.representer.RoundTripRepresenter.add_representer(
    FlowStyleList, represent_flow_style_list
)

@app.options("/api/update_roi_config/:config_name/:scenario")
async def options_rtsp_snapshot_with_roi_url(request: Request):
    print("[API] OPTIONS /rtsp_snapshot_with_roi_url 被調用", flush=True)
    response = Response(
        status_code=200,
        headers={
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type"
        },
        description=""
    )
    return response


@app.post("/api/update_roi_config/:config_name/:scenario")
async def update_roi_config(request: Request):
    print("[API] /api/update_roi_config 被調用", flush=True)
    try:
        body = request.json() if request.body else {}
        stream_id = body.get("stream_id") or body.get("rtsp_url") or "default"
        roi_config = body.get("roi_config") or body
        if not roi_config:
            return add_cors_headers(Response(
                description=json.dumps({"error": "Missing roi_config", "status": "failed"}),
                status_code=400,
                headers={"Content-Type": "application/json"}
            ))
        print(f"DEBUG: 接收到的 ROI config: {roi_config}", flush=True)


        # 從 URL 路徑取得 config 名稱
        config_name = request.path_params.get("config_name", "")
        scenario = request.path_params.get("scenario", "")
        print(f"DEBUG: 要更新的 config: {config_name}", flush=True)
        
        # 解析 ROI config
        area_id = []
        edge_num = []
        region_polygon = []
        for k, v in roi_config.items():
            try:
                region_data = json.loads(v)
                for region in region_data.get("regions", []):
                    attrs = region.get("region_attributes", {})
                    shape = region.get("shape_attributes", {})
                    if "area_id" in attrs:
                        area_id.append(attrs["area_id"])
                    if "edge_num" in attrs:
                        edge_list = [int(x) for x in attrs["edge_num"].split(",") if x.strip().isdigit()]
                        edge_num.append(edge_list)
                    if "all_points_x" in shape and "all_points_y" in shape:
                        polygon = []
                        for x, y in zip(shape["all_points_x"], shape["all_points_y"]):
                            polygon.extend([x, y])
                        region_polygon.append(polygon)
            except Exception as e:
                print(f"解析 ROI config 失敗: {e}", flush=True)

        # 強制格式正確並用 FlowStyleList
        area_id = FlowStyleList(area_id)
        edge_num = FlowStyleList(edge_num)
        region_polygon = FlowStyleList(region_polygon)

        roi_data = {
            "entered_flag_ttl": 300,  # TTL 秒數，預設5分鐘
            "area_id": area_id,
            "edge_num": edge_num,
            "region_polygon": region_polygon
        }
        print(f"DEBUG: 整理後的 ROI 資料: {roi_data}", flush=True)

        # === 用 ruamel.yaml 保留格式與順序 ===
        # 動態組合 YAML 路徑（根據 config_name）
        yaml_path = os.path.join(BASE_DIR, "roi_configs", f"{config_name}.yml")
        
        if not os.path.exists(yaml_path):
            return add_cors_headers(Response(
                description=json.dumps({"error": f"Config file not found: {config_name}.yml", "status": "failed"}),
                status_code=404,
                headers={"Content-Type": "application/json"}
            ))
        
        yaml = ruamel.yaml.YAML()
        yaml.indent(mapping=2, sequence=4, offset=2)

        with open(yaml_path, "r", encoding="utf-8") as f:
            data = yaml.load(f)

        # 更新 1F-frontstore 區塊
        if "Region" not in data:
            data["Region"] = {}
        if "scenario" not in data["Region"]:
            data["Region"]["scenario"] = {}
        data["Region"]["scenario"][scenario] = roi_data

        with open(yaml_path, "w", encoding="utf-8") as f:
            yaml.dump(data, f)

        print(f"DEBUG: TEST.yml 已更新 1F-frontstore 區塊", flush=True)
        return add_cors_headers(Response(
            description=json.dumps({"status": "success", "yaml_path": yaml_path}),
            status_code=200,
            headers={"Content-Type": "application/json"}
        ))

    except Exception as e:
        import traceback
        print(traceback.format_exc(), flush=True)
        return add_cors_headers(Response(
            description=json.dumps({"error": str(e), "status": "failed"}),
            status_code=500,
            headers={"Content-Type": "application/json"}
        ))

@app.options("/api/rtsp_snapshot_with_roi_url")
async def options_rtsp_snapshot_with_roi_url(request: Request):
    print("[API] OPTIONS /rtsp_snapshot_with_roi_url 被調用", flush=True)
    response = Response(
        status_code=200,
        headers={
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type"
        },
        description=""
    )
    return response

@app.post("/api/rtsp_snapshot_with_roi_url")
async def rtsp_snapshot_with_roi_url(request: Request):
    """
    接收 rtsp_url，截圖後存到 img/，並回傳圖片網址與 ROI 編輯頁網址
    """
    print("[API] /rtsp_snapshot_with_roi_url 被調用", flush=True)
    try:
        body = request.json() if request.body else {}
        rtsp_url = body.get("rtsp_url")
        roi_config_name = body.get("roi_config_name")
        scenario = body.get("scenario")

        if not rtsp_url:
            return add_cors_headers(Response(
                description=json.dumps({"error": "Missing rtsp_url", "status": "failed"}),
                status_code=400,
                headers={"Content-Type": "application/json"}
            ))
            
        if not roi_config_name:
            return add_cors_headers(Response(
                description=json.dumps({"error": "Missing roi-config-name", "status": "failed"}),
                status_code=400,
                headers={"Content-Type": "application/json"}
            ))
            
        if not scenario:
            return add_cors_headers(Response(
                description=json.dumps({"error": "Missing scenario", "status": "failed"}),
                status_code=400,
                headers={"Content-Type": "application/json"}
            ))

        container = av.open(rtsp_url, options={"rtsp_transport": "tcp"})
        video_stream = container.streams.video[0]
        warmup_frames = 70  # 丟棄前10幀
        max_attempts = 120
        frame = None
        skipped = 0

        # 丟棄 warmup幀，直接抓關鍵幀
        for packet in container.demux(video_stream):
            for av_frame in packet.decode():
                skipped += 1
                if skipped >= warmup_frames:
                    break
            if skipped > warmup_frames:
                break
        # 取得關鍵幀
        for i, packet in enumerate(container.demux(video_stream)):
            if i >= max_attempts:
                break
            for av_frame in packet.decode():
                if av_frame.key_frame:  # 判斷是否為關鍵幀
                    frame = av_frame.to_ndarray(format='bgr24')
                    # 檢查畫面是否全黑或全灰
                    if frame.sum() == 0 or frame.mean() < 5:
                        continue  # 無效畫面，繼續找下一個關鍵幀
                    break
            if frame is not None:
                break
        
        container.close()
        
        if frame is None:
            return add_cors_headers(Response(
                description=json.dumps({"error": "Failed to capture keyframe", "status": "failed"}),
                status_code=500,
                headers={"Content-Type": "application/json"}
            ))

        filename = f"rtsp_{uuid.uuid4().hex}.jpg"
        save_path = os.path.join("img", filename)
        os.makedirs("img", exist_ok=True)
        cv2.imwrite(save_path, frame)

       # 用 NGINX 對外 base URL 組合圖片網址與 ROI 編輯頁網址
        img_url = f"{NGINX_BASE_URL}/img/{filename}"

        # 構建 ROI 編輯頁 URL，加入 roi_config_name 和 scenario 參數
        roi_edit_url = f"{NGINX_BASE_URL}/via/?screenshot_url={img_url}"
        if roi_config_name:
            roi_edit_url += f"&roi_config_name={roi_config_name}"
        if scenario:
            roi_edit_url += f"&scenario={scenario}"

        response_data = {
            "img_url": img_url,
            "roi_edit_url": roi_edit_url,
            "filename": filename,
            "timestamp": datetime.now().isoformat(),
            "status": "success"
        }
        return add_cors_headers(Response(
            description=json.dumps(response_data),
            status_code=200,
            headers={"Content-Type": "application/json"}
        ))

    except Exception as e:
        return add_cors_headers(Response(
            description=json.dumps({"error": str(e), "status": "failed"}),
            status_code=500,
            headers={"Content-Type": "application/json"}
        ))

BASE_DIR = os.path.dirname(__file__)

# # 提供圖片檔案的端點（GET /img/<filename>）
@app.get("/img/*filename")
async def serve_image(request: Request):
    print(f"DEBUG: BASE_DIR={BASE_DIR}", flush=True)
    image_path = os.path.join(BASE_DIR, "img", request.path_params["filename"])
    print(f"DEBUG: filename={repr(request.path_params['filename'])}", flush=True)
    print(f"DEBUG: image_path={image_path}", flush=True)
    print(f"DEBUG: os.path.exists(image_path)={os.path.exists(image_path)}", flush=True)
    if os.path.exists(image_path):
        with open(image_path, "rb") as f:
            image_data = f.read()
        return add_cors_headers(Response(status_code=200, headers={"Content-Type": "image/jpg"}, description=image_data))
    else:
        return add_cors_headers(Response(status_code=404, headers={}, description="Image not found"))


BASE_DIR = os.path.dirname(__file__)
VIA_DIR = os.path.join(BASE_DIR, "via", "via-2.x.y", "src")  # 放置 index.html 與靜態資源的資料夾

@app.get("/via")
async def serve_via_index(request: Request):
    index_path = os.path.join(VIA_DIR, "index.html")
    print(f"DEBUG: serve_via_index 被呼叫，index_path={index_path}", flush=True)
    if not os.path.isfile(index_path):
        return Response(status_code=404, headers={"Content-Type":"text/plain"}, description="ROI 編輯器不存在")
    with open(index_path, "r", encoding="utf-8") as f:
        html = f.read()
    return Response(status_code=200, headers={"Content-Type":"text/html; charset=utf-8"}, description=html)

@app.get("/via/*path")
async def serve_via_asset(request: Request):
    path = request.path_params["path"]
    # 安全合併路徑並防止 path traversal
    candidate = os.path.normpath(os.path.join(VIA_DIR, path))
    print(f"DEBUG: serve_via_asset 被呼叫，path={path}, candidate={candidate}", flush=True)
    if not candidate.startswith(os.path.abspath(VIA_DIR)):
        return Response(status_code=403, headers={"Content-Type":"text/plain"}, description="Forbidden")
    if not os.path.isfile(candidate):
        return Response(status_code=404, headers={"Content-Type":"text/plain"}, description="Not found")
    ctype = mimetypes.guess_type(candidate)[0] or "application/octet-stream"
    # 以二進位讀取（若 Robyn Response description 支援 bytes）
    with open(candidate, "rb") as f:
        data = f.read()
    return Response(status_code=200, headers={"Content-Type": ctype}, description=data)

@app.get("/api/healthcheck")
async def healthcheck(request: Request):
    print("DEBUG: /healthcheck 被呼叫", flush=True)
    return add_cors_headers(Response(status_code=200, headers={}, description="OK"))

# 啟動伺服器
if __name__ == "__main__":
    print("啟動 Robyn API server...")
    print("截圖端點: POST http://127.0.0.1:5000/screenshot")
    print("圖片端點: GET http://127.0.0.1:5000/img/<filename>")
    app.start(host="0.0.0.0", port=5000)  # 監聽所有介面，方便內網訪問