(function () {
  'use strict';

  // ---- 全域註冊表（僅存放引用，不存放狀態邏輯） ----
  const registry = (function () {
    if (!window.__WebRTCPlayerRegistry) {
      window.__WebRTCPlayerRegistry = { counter: 0, instances: new Map(), globalEventsReady: false };
    }
    return window.__WebRTCPlayerRegistry;
  })();

  // === 新增：安全根容器解析與延遲啟動（修正 document.currentScript 為 null 問題） ===
  let root = null;
  const MAX_ROOT_ATTEMPTS = 30;
  let rootAttempt = 0;

  function resolveRoot() {
    // 1. 嘗試 currentScript 鄰近
    const scriptEl = document.currentScript;
    if (scriptEl) {
      let candidate = scriptEl.previousElementSibling;
      if (candidate && candidate.classList && candidate.classList.contains('webrtc-player-root')) {
        return candidate;
      }
      candidate = scriptEl.closest && scriptEl.closest('.webrtc-player-root');
      if (candidate) return candidate;
    }
    // 2. 尋找尚未初始化的容器
    const list = Array.from(document.querySelectorAll('.webrtc-player-root'))
      .filter(el => !el.__webrtcInstance);
    if (list.length) return list[0];
    return null;
  }

  function boot() {
    root = resolveRoot();
    if (!root) {
      if (rootAttempt++ < MAX_ROOT_ATTEMPTS) {
        setTimeout(boot, 150);
      } else {
        console.error("[webrtc] 無法找到根容器，放棄初始化");
      }
      return;
    }
    if (root.__webrtcInstance) {
      console.warn("[webrtc] 此容器已存在實例，跳過");
      return;
    }

    // ---- Player 狀態枚舉 ----
    const PlayerState = Object.freeze({
      IDLE: 'idle', CONNECTING: 'connecting', CONNECTED: 'connected',
      STOPPING: 'stopping', ERROR: 'error'
    });

    // ---- 建立實例 ----
    function createInstance(root) {
      const id = ++registry.counter;
      const prefix = `[webrtc#${id}]`;
      root.dataset.webrtcId = id;

      // 元素參照
      const elements = {
        root,
        video: root.querySelector('[data-role="video"]'),
        status: root.querySelector('[data-role="status"]'),
        rtspSpan: root.querySelector('[data-role="rtsp-url"]'),
        whepSpan: root.querySelector('[data-role="whep-url"]'),
        apiBaseUrlSpan: root.querySelector('[data-role="api-base-url"]'),
        apiBaseUrlSpan1: root.querySelector('[data-role="api-base-url-1"]'),
        serviceNameSpan: root.querySelector('[data-role="service-name"]')
      };

      // 實例狀態
      const state = {
        id,
        pc: null,
        stream: null,
        whep: { controller: null, resourceUrl: null },
        timers: { connection: null, stats: null, retry: null, frame: null, visibility: null },
        retry: { attempt: 0, max: 5, base: 2000, maxDelay: 30000, lastReason: "" },
        opInProgress: false,
        current: PlayerState.IDLE,
        stopRequested: false,
        disposed: false
      };

      // ---- 參數 ----
      const HIDDEN_STOP_DELAY = 15000; // 分頁隱藏 15 秒後才停

      // ---- 工具 ----
      const log = (...args) => console.log(prefix, ...args);
      const warn = (...args) => console.warn(prefix, ...args);
      const err = (...args) => console.error(prefix, ...args);

      function getEndpoint() {
        return (elements.whepSpan?.textContent || "").trim();
      }

      function setState(next, label) {
        if (state.disposed) return;
        log(`狀態: ${state.current} -> ${next}`, label || "");
        state.current = next;
        if (label && elements.status) elements.status.textContent = label;
      }

      function clearTimer(name) {
        const t = state.timers[name];
        if (!t) return;
        (name === 'stats') ? clearInterval(t) : clearTimeout(t);
        state.timers[name] = null;
      }
      function clearAllTimers() {
        Object.keys(state.timers).forEach(clearTimer);
      }

      function resetRetry() {
        clearTimer('retry');
        if (state.retry.attempt > 0) log("重置重試計數");
        state.retry.attempt = 0;
        state.retry.lastReason = "";
      }

      function scheduleRetry(reason = "未知") {
        if (state.disposed) return;
        if (document.hidden) {
          log("頁面隱藏，延後重試", reason);
          state.retry.lastReason = reason;
          return;
        }
        if (![PlayerState.ERROR, PlayerState.IDLE].includes(state.current)) return;
        if (state.retry.attempt >= state.retry.max) {
          warn("達到最大重試次數");
          elements.status && (elements.status.textContent = `失敗 (${state.retry.attempt})`);
          return;
        }
        state.retry.attempt++;
        state.retry.lastReason = reason;
        let delay = state.retry.base * Math.pow(2, state.retry.attempt - 1);
        delay = Math.min(delay, state.retry.maxDelay);
        delay = Math.round(delay * (0.5 + Math.random() * 0.5));
        log(`排程第 ${state.retry.attempt} 次重試，${delay}ms (${reason})`);
        if (elements.status) {
          const short = reason.length > 18 ? reason.slice(0, 17) + '…' : reason;
          elements.status.textContent = `重試 ${state.retry.attempt} / ${state.retry.max} (${(delay / 1000).toFixed(1)}s) ${short}`;
          elements.status.title = reason;
        }
        clearTimer('retry');
        state.timers.retry = setTimeout(() => {
          if (state.current === PlayerState.IDLE || state.current === PlayerState.ERROR) {
            start();
          }
        }, delay);
      }

      // ---- WebRTC ----
      async function start() {
        if (state.disposed) return;
        if (state.opInProgress) { log("操作進行中，忽略 start"); return; }
        if (![PlayerState.IDLE, PlayerState.ERROR].includes(state.current)) {
          log("當前狀態不允許 start", state.current); return;
        }
        if (state.current === PlayerState.ERROR) {
          setState(PlayerState.IDLE, "重新嘗試...");
        }
        const endpoint = getEndpoint();
        if (!endpoint) {
          setState(PlayerState.ERROR, "端點空");
          scheduleRetry("端點空");
          return;
        }

        state.opInProgress = true;
        setState(PlayerState.CONNECTING, "連線中...");
        log("開始連線:", endpoint);

        // 清理但保留 retry 計數
        cleanup({ preserveRetry: true });

        try {
          state.pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
          attachPeerHandlers();

          state.pc.addTransceiver("video", { direction: "recvonly" });
          state.pc.addTransceiver("audio", { direction: "recvonly" });

          const offer = await state.pc.createOffer();
          await state.pc.setLocalDescription(offer);
          await waitIceComplete();

          state.whep.controller = new AbortController();
          const timeout = setTimeout(() => {
            try { state.whep.controller.abort(); } catch (_) { }
          }, 15000);

            const res = await fetch(endpoint, {
              method: "POST",
              headers: { "Content-Type": "application/sdp", "Accept": "application/sdp" },
              body: state.pc.localDescription.sdp,
              signal: state.whep.controller.signal
            });
            clearTimeout(timeout);

          if (!res.ok) {
            const txt = await res.text().catch(() => "");
            throw new Error(`WHEP 失敗 ${res.status} ${txt}`);
          }

          state.whep.resourceUrl = res.headers.get('location') || res.headers.get('Location');
          if (state.whep.resourceUrl) log("WHEP 資源:", state.whep.resourceUrl);

          const answerSdp = await res.text();
          await state.pc.setRemoteDescription({ type: "answer", sdp: answerSdp });

          // 連線超時監控
          clearTimer('connection');
          state.timers.connection = setTimeout(() => {
            if (state.current === PlayerState.CONNECTING) {
              handleError("連線超時");
            }
          }, 15000);

          // stats stub
          startStats();
        } catch (e) {
          err("連線錯誤:", e);
          let msg = e.name === 'AbortError' ? "請求中止/逾時" : (e.message || "連線錯誤");
          handleError(msg);
        } finally {
          state.opInProgress = false;
          state.whep.controller = null;
        }
      }

      function attachPeerHandlers() {
        if (!state.pc) return;
        state.pc.onconnectionstatechange = () => {
          log("Peer connectionState:", state.pc.connectionState);
          switch (state.pc.connectionState) {
            case "connected":
              if (state.current !== PlayerState.CONNECTED) {
                setState(PlayerState.CONNECTED, "播放中");
                clearTimer('connection');
                resetRetry();
                startFrameMonitor();
              }
              break;
            case "failed":
            case "disconnected":
              if (state.current === PlayerState.CONNECTED) {
                handleError("連線中斷");
              }
              break;
            case "closed":
              if (![PlayerState.STOPPING].includes(state.current)) {
                setState(PlayerState.IDLE, "已關閉");
              }
              break;
          }
        };
        state.pc.oniceconnectionstatechange = () => {
          log("ICE:", state.pc.iceConnectionState);
          if (state.current === PlayerState.CONNECTED &&
            ["failed", "disconnected"].includes(state.pc.iceConnectionState)) {
            handleError("ICE 錯誤");
          }
        };
        state.pc.onicecandidateerror = ev => err("ICE candidate error", ev);

        state.pc.ontrack = ev => {
          log("收到軌道:", ev.track.kind, ev.track.id);
          if (!state.stream) {
            state.stream = ev.streams?.[0] || new MediaStream([ev.track]);
            elements.video.srcObject = state.stream;
            attachVideoEvents();
          }
        };
      }

      function waitIceComplete() {
        return new Promise((resolve, reject) => {
          if (!state.pc) return reject(new Error("PC 已關閉"));
          if (state.pc.iceGatheringState === "complete") return resolve();
          const to = setTimeout(() => reject(new Error("ICE 收集超時")), 15000);
          state.pc.onicegatheringstatechange = () => {
            if (state.pc && state.pc.iceGatheringState === "complete") {
              clearTimeout(to);
              resolve();
            }
          };
        });
      }

      function handleError(message) {
        if (state.disposed) return;
        if (state.current === PlayerState.STOPPING) {
          log("STOPPING 狀態忽略錯誤:", message);
          return;
        }
        clearTimer('connection');
        setState(PlayerState.ERROR, message);
        scheduleRetry(message);
      }

      function startStats() {
        if (state.timers.stats || state.disposed) return;
        state.timers.stats = setInterval(async () => {
          if (!state.pc) return;
          try {
            // 可插入 getStats 分析
          } catch (_) { }
        }, 5000);
      }

      function startFrameMonitor() {
        clearTimer('frame');
        // stub，可擴充：檢查幀停滯自動重啟
      }

      function attachVideoEvents() {
        const v = elements.video;
        if (!v || v.__webrtcBound) return;
        v.__webrtcBound = true;
        ["loadstart", "loadedmetadata", "loadeddata", "canplay", "playing", "pause", "ended",
          "stalled", "waiting", "resize", "error"].forEach(ev => {
            v.addEventListener(ev, (e) => {
              if (ev === 'error') {
                err("video error", v.error);
              } else {
                log("video event:", ev);
              }
            }, { passive: true });
          });
      }

      function stop() {
        if (state.disposed) return;
        if (state.opInProgress) { log("操作中，延後 stop"); return; }
        if ([PlayerState.IDLE, PlayerState.STOPPING].includes(state.current)) return;
        state.stopRequested = true;
        setState(PlayerState.STOPPING, "停止中...");
        cleanup();
        setState(PlayerState.IDLE, "已停止");
      }

      function restart() {
        log("restart");
        resetRetry();
        stop();
        setTimeout(() => start(), 60);
      }

      function cleanup(opts = {}) {
        const { preserveRetry = false } = opts;
        clearAllTimers();

        if (state.pc) {
          try { state.pc.ontrack = state.pc.onconnectionstatechange = null; } catch (_) { }
          try { state.pc.close(); } catch (_) { }
          state.pc = null;
        }

        if (state.stream) {
          try { state.stream.getTracks().forEach(t => t.stop()); } catch (_) { }
          state.stream = null;
        }

        if (elements.video) {
          elements.video.srcObject = null;
        }

        if (state.whep.resourceUrl) {
          try {
            fetch(state.whep.resourceUrl, { method: 'DELETE', keepalive: true }).catch(() => { });
            log("WHEP DELETE:", state.whep.resourceUrl);
          } catch (_) { }
        }
        state.whep.resourceUrl = null;
        state.whep.controller = null;
        state.stopRequested = false;

        if (!preserveRetry) resetRetry();
      }

      function safeStop(reason = "unknown") {
        if (state.disposed) return;
        log("safeStop:", reason);
        stop();
      }

      function dispose(reason = "dispose") {
        if (state.disposed) return;
        log("釋放實例:", reason);
        state.disposed = true;
        cleanup();
        clearAllTimers();
        // 解除 RefreshEvent 訂閱
        if (api._refreshSub && typeof api._refreshSub.unsubscribe === 'function') {
          try { api._refreshSub.unsubscribe(); } catch (_) { }
          api._refreshSub = null;
        }
        registry.instances.delete(state.id);
        delete root.__webrtcInstance;
        if (observer) { try { observer.disconnect(); } catch (_) { } }
      }

      // 分頁可見性/頁面生命週期
      function onVisibilityChange() {
        if (document.hidden) {
          clearTimer('visibility');
          state.timers.visibility = setTimeout(() => {
            safeStop("hidden-timeout");
          }, HIDDEN_STOP_DELAY);
        } else {
          clearTimer('visibility');
          if (!state.opInProgress &&
            (state.current === PlayerState.IDLE || state.current === PlayerState.ERROR)) {
            resetRetry();
            start();
          }
        }
      }

      function onPageHide() {
        // 不主動停，用 visibility 的延遲策略處理
      }

      function onPageShow() {
        clearTimer('visibility');
        if (!state.opInProgress &&
          (state.current === PlayerState.IDLE || state.current === PlayerState.ERROR)) {
          resetRetry();
          start();
        }
      }

      // MutationObserver：容器被移除即自動釋放
      const observer = new MutationObserver(() => {
        if (!document.body.contains(root)) {
          dispose("root-removed");
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });

      // 對外公開
      const api = {
        id,
        start,
        stop,
        restart,
        dispose,
        safeStop,
        get state() { return state.current; },
        root
      };
      root.__webrtcInstance = api;

      // ---- ROI 按鈕精簡功能 ----
      function addRoiControlsModeCSimple(elements, state, api, opts = {}) {
        const root = elements.root;
        if (!root) return;
        const cfg = Object.assign({
          getStreamId: (forceType = 'auto') => {
            if (forceType === 'rtsp') {
              // 只取 RTSP
              return elements.rtspSpan && elements.rtspSpan.textContent && elements.rtspSpan.textContent.trim() || null;
            }
            // 預設/auto：只取 whep
            return elements.whepSpan && elements.whepSpan.textContent && elements.whepSpan.textContent.trim() || null;
          }
        }, opts);

        root.style.position = root.style.position || 'relative';
        const ctrl = document.createElement('div');
        ctrl.className = 'webrtc-roi-controls';
        Object.assign(ctrl.style, { position: 'absolute', right: '8px', bottom: '8px', zIndex: 9999, display: 'flex', gap: '6px' });
        root.appendChild(ctrl);

        const roiBtn = document.createElement('button');
        roiBtn.type = 'button';
        roiBtn.textContent = 'ROI編輯器';
        roiBtn.setAttribute('aria-label', '打開 ROI 編輯器');
        ctrl.appendChild(roiBtn);

        const restartBtn = document.createElement('button');
        restartBtn.type = 'button';
        restartBtn.textContent = '重啟服務';
        restartBtn.setAttribute('aria-label', '重啟後端服務');
        ctrl.appendChild(restartBtn);

        restartBtn.addEventListener('click', async () => {
          const serviceName = elements.serviceNameSpan?.textContent?.trim();
          const apiBaseUrl1 = elements.apiBaseUrlSpan1?.textContent?.trim() || "http://localhost:8080";
          if (!serviceName) {
            elements.status && (elements.status.textContent = '找不到服務名稱');
            return;
          }
          restartBtn.disabled = true;
          elements.status && (elements.status.textContent = '正在重啟服務...');
          try {
            const endpoint1 = `${apiBaseUrl1}/containers/${encodeURIComponent(serviceName)}/restart`;
            const res = await fetch(endpoint1, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ timeout: 10 })
            });
            const result = await res.json();
            if (res.ok && result.success !== false) {
              elements.status && (elements.status.textContent = '服務已重啟');
            } else {
              throw new Error(result.message || '重啟失敗');
            }
          } catch (e) {
            elements.status && (elements.status.textContent = `重啟失敗: ${e.message || e}`);
          } finally {
            restartBtn.disabled = false;
          }
        });

        roiBtn.addEventListener('click', async () => {
          // 強制只取 RTSP url
          const streamId = cfg.getStreamId('rtsp');
          if (!streamId) {
            elements.status && (elements.status.textContent = '找不到 stream 位置（請確認設定）');
            return;
          }

          roiBtn.disabled = true;
          elements.status && (elements.status.textContent = '正在建立 ROI 編輯頁...');

          let win;
          try {
            win = window.open('', '_blank');
            if (win) {
            win.document.write('<title>載入中...</title><h2 style="font-family:sans-serif">載入中...</h2>');
            win.document.close();
            }
          } catch (e) {
            win = null;
          }

          try {
            const payload = { rtsp_url: streamId, ts: Date.now() };
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 20000);
            const res = await fetch(cfg.endpoint, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
              signal: controller.signal
            });
            clearTimeout(timeout);

            // 新增：直接顯示回傳內容
            let respText = await res.text();
            console.log('API raw response:', respText);

            if (res.status === 200) {
              let j = null;
              try {
                j = JSON.parse(respText);
              } catch (e) {
                elements.status && (elements.status.textContent = '回傳內容不是合法 JSON');
                if (win) win.close();
                roiBtn.disabled = false;
                return;
              }
              const roiEditUrl = j && j.roi_edit_url ? j.roi_edit_url : null;
              if (roiEditUrl) {
                console.log('Ready to open ROI Edit URL:', roiEditUrl);
                if (win) win.location.href = roiEditUrl;
                else {
                  const a = document.createElement('a');
                  a.href = roiEditUrl; a.target = '_blank'; a.textContent = 'Open ROI Editor';
                  ctrl.appendChild(a);
                }
                elements.status && (elements.status.textContent = '已打開 ROI 編輯頁');
              } else {
                elements.status && (elements.status.textContent = '回應缺少 roi_edit_url');
                if (win) win.close();
              }
            } else {
              const txt = await res.text().catch(() => null);
              elements.status && (elements.status.textContent = `任務失敗: ${res.status} ${txt || ''}`);
              if (win) win.close();
            }
          } catch (e) {
            elements.status && (elements.status.textContent = `請求失敗: ${e.message || e}`);
            if (win) win.close();
          } finally {
            roiBtn.disabled = false;
          }
        });

        api.sendRoiEdit = async () => {
          roiBtn.click();
        };
      }

      // 初始
      setState(PlayerState.IDLE, "自動連線中...");
      start();

      // 掛載 ROI 按鈕
      const apiBaseUrl = elements.apiBaseUrlSpan?.textContent.trim() || "http://localhost:8080";
      try {
        addRoiControlsModeCSimple(elements, state, api, {
          endpoint: `${apiBaseUrl}/api/rtsp_snapshot_with_roi_url`
        });
        log("按鈕已安裝");
      } catch (e) {
        warn("無法安裝按鈕", e);
      }

      return {
        api,
        dispatch: {
          visibility: onVisibilityChange,
          pagehide: onPageHide,
          pageshow: onPageShow,
          beforeunload: () => dispose("beforeunload")
        }
      };
    }

    // ---- 建立實例 ----
    const { api, dispatch } = createInstance(root);
    registry.instances.set(api.id, { api, dispatch });

    // 調整：使用 context.grafana.eventBus 監聽 RefreshEvent
    (function () {
      const bus = window.context?.grafana?.eventBus;
      const RefreshEventCtor = window.RefreshEvent;
      if (bus && typeof bus.getStream === 'function' && RefreshEventCtor) {
        try {
          api._refreshSub?.unsubscribe?.();
          api._refreshSub = bus.getStream(RefreshEventCtor).subscribe(() => {
            console.log("[webrtc] 收到 RefreshEvent (context.grafana.eventBus)，重新啟動串流");
            api.restart && api.restart();
          });
          console.log("[webrtc] 已掛載 RefreshEvent 監聽 (context.grafana.eventBus)");
        } catch (e) {
          console.warn("[webrtc] RefreshEvent 訂閱失敗", e);
        }
      } else {
        console.log("[webrtc] 未找到 context.grafana.eventBus 或 RefreshEvent，略過刷新監聽");
      }
    })();

    // ---- 全域事件（只註冊一次） ----
    if (!registry.globalEventsReady) {
      const globalLog = (...a) => console.log("[webrtc#global]", ...a);

      document.addEventListener("visibilitychange", () => {
        registry.instances.forEach(inst => inst.dispatch.visibility());
      }, { passive: true });

      window.addEventListener("pagehide", () => {
        registry.instances.forEach(inst => inst.dispatch.pagehide());
      }, { passive: true });

      window.addEventListener("pageshow", () => {
        registry.instances.forEach(inst => inst.dispatch.pageshow());
      }, { passive: true });

      window.addEventListener("beforeunload", () => {
        registry.instances.forEach(inst => {
          try { inst.dispatch.beforeunload(); } catch (_) { }
        });
      });

      globalLog("全域生命週期事件已安裝");
      registry.globalEventsReady = true;
    }

    // 對外釋放
    root.__dispose = () => api.dispose("manual-dispose");
  }

  // === 啟動 ===
  boot();

})();