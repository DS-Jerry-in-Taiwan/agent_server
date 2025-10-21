// ==========================================
// 🔧 配置區
// ==========================================
const CONFIG = {
    apiBaseUrl: 'http://10.12.147.11:8000',
    refreshInterval: 5000,
    containerList: [
        'insightminer-flowcollector',
        'pedestrianinsight-prod-v2.6.2'
    ],
    endpoints: {
        getContainers: '/containers?all=true',
        getStatus: '/containers/{name}/status',
        start: '/containers/{name}/start',
        stop: '/containers/{name}/stop',
        restart: '/containers/{name}/restart'
    },
    requestConfig: {
        stop: { method: 'POST', body: { timeout: 10 } },
        start: { method: 'POST', body: {} },
        restart: { method: 'POST', body: { timeout: 10 } }
    },
    dataParser: {
        extractContainers: (response) => {
            return Array.isArray(response) ? response : (response.containers || []);
        },
        extractName: (container) => {
            return container.name || container.Names?.[0]?.replace(/^\//, '') || 'unknown';
        },
        extractStatus: (container) => {
            const status = container.status || container.State;
            if (typeof status === 'string') {
                const statusLower = status.toLowerCase();
                if (statusLower.includes('running') || statusLower === 'up') {
                    return 'running';
                }
                return 'stopped';
            }
            if (typeof status === 'object' && status.running !== undefined) {
                return status.running ? 'running' : 'stopped';
            }
            return 'stopped';
        }
    }
};

// ==========================================
// 🎯 核心改進：使用 IIFE 創建獨立作用域
// ==========================================
(function () {
    // 獲取當前 panel 的根容器
    const panelRoot = context.element;

    // 在當前 panel 內查找元素（使用 class 而非 id）
    const servicesGrid = panelRoot.querySelector('.services-grid');

    // 先註解掉api自動更新開關UI, 但功能依然存在
    // const autoRefreshToggle = panelRoot.querySelector('.auto-refresh-toggle');
    // const lastUpdateSpan = panelRoot.querySelector('.last-update');

    // 每個 panel 有自己的狀態變數
    let autoRefreshTimer = null;
    let isAutoRefreshEnabled = true;
    let isContentVisible = true;
    let services = [];

    // ==========================================
    // 🛠️ 工具函數
    // ==========================================

    // 🔥 新增：清理容器名稱，使其可以安全地用作 CSS class
    function sanitizeForClass(name) {
        // 將所有非字母數字和連字符的字符替換為連字符
        // 例如: "v2.6.2" -> "v2-6-2"
        return name.replace(/[^a-zA-Z0-9-]/g, '-');
    }

    function buildUrl(endpoint, containerName = null) {
        let url = CONFIG.apiBaseUrl + endpoint;
        if (containerName) {
            url = url.replace('{name}', encodeURIComponent(containerName));
        }
        return url;
    }

    async function apiRequest(endpoint, containerName = null, config = {}) {
        const url = buildUrl(endpoint, containerName);
        const options = {
            method: config.method || 'GET',
            headers: {
                'Content-Type': 'application/json',
                ...config.headers
            }
        };

        if (config.body && Object.keys(config.body).length > 0) {
            options.body = JSON.stringify(config.body);
        }

        const response = await fetch(url, options);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        return await response.json();
    }

    // ==========================================
    // 📡 API 調用函數
    // ==========================================
    async function loadServices() {
        try {
            if (CONFIG.autoDetect) {
                await loadServicesAuto();
            } else {
                await loadServicesManual();
            }
            renderServices();
            updateLastRefreshTime();
        } catch (error) {
            console.error('❌ 載入容器失敗:', error);
        }
    }

    async function loadServicesAuto() {
        const data = await apiRequest(CONFIG.endpoints.getContainers);
        const containers = CONFIG.dataParser.extractContainers(data);
        services = containers.map(container => ({
            name: CONFIG.dataParser.extractName(container),
            status: CONFIG.dataParser.extractStatus(container)
        }));
    }

    async function loadServicesManual() {
        if (!CONFIG.containerList || CONFIG.containerList.length === 0) {
            console.warn('⚠️ containerList 為空');
            services = [];
            return;
        }

        const statusPromises = CONFIG.containerList.map(async (containerName) => {
            try {
                const data = await apiRequest(CONFIG.endpoints.getStatus, containerName);
                if (data.success && data.status) {
                    return {
                        name: containerName,
                        status: CONFIG.dataParser.extractStatus(data.status)
                    };
                }
                return {
                    name: containerName,
                    status: CONFIG.dataParser.extractStatus(data)
                };
            } catch (error) {
                console.warn(`⚠️ 無法獲取容器 "${containerName}" 的狀態:`, error.message);
                return {
                    name: containerName,
                    status: 'stopped'
                };
            }
        });

        services = await Promise.all(statusPromises);
    }

    function updateLastRefreshTime() {
        const now = new Date();
        const timeString = now.toLocaleTimeString('zh-TW');
        // 先註解掉api自動更新開關UI, 但功能依然存在
        // lastUpdateSpan.textContent = `最後更新: ${timeString}`;
    }

    function startAutoRefresh() {
        if (autoRefreshTimer) {
            clearInterval(autoRefreshTimer);
        }
        if (isContentVisible && isAutoRefreshEnabled) {
            autoRefreshTimer = setInterval(() => {
                loadServices();
            }, CONFIG.refreshInterval);
            console.log('✅ 自動更新已啟動');
        }
    }

    function stopAutoRefresh() {
        if (autoRefreshTimer) {
            clearInterval(autoRefreshTimer);
            autoRefreshTimer = null;
            console.log('⏸️ 自動更新已停止');
        }
    }

    function toggleAutoRefresh() {
        isAutoRefreshEnabled = autoRefreshToggle.checked;
        if (isAutoRefreshEnabled) {
            startAutoRefresh();
        } else {
            stopAutoRefresh();
        }
    }

    function setupVisibilityObserver() {
        const container = panelRoot.querySelector('.container');
        const observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    isContentVisible = true;
                    if (isAutoRefreshEnabled) {
                        console.log('👀 頁面內容可見，恢復自動更新');
                        loadServices();
                        startAutoRefresh();
                    }
                } else {
                    isContentVisible = false;
                    stopAutoRefresh();
                    console.log('📴 頁面內容不可見，停止更新');
                }
            });
        }, {
            threshold: 0.1
        });

        observer.observe(container);
    }

    function renderServices() {
        servicesGrid.innerHTML = services.map(service => {
            // 🔥 使用清理後的名稱作為 class
            const safeName = sanitizeForClass(service.name);
            return `
                <div class="service-card">
                    <div class="service-header">
                        <div class="service-name">${service.name}</div>
                        <div class="status ${service.status} status-${safeName}">
                            ${service.status === 'running' ? '運行中' : '已停止'}
                        </div>
                    </div>
                    <div class="controls">
                        <button class="btn btn-start" data-service="${service.name}" data-action="start"
                                ${service.status === 'running' ? 'disabled' : ''}>
                            啟動
                        </button>
                        <button class="btn btn-stop" data-service="${service.name}" data-action="stop"
                                ${service.status === 'stopped' ? 'disabled' : ''}>
                            停止
                        </button>
                        <button class="btn btn-restart" data-service="${service.name}" data-action="restart"
                                ${service.status === 'stopped' ? 'disabled' : ''}>
                            重啟
                        </button>
                    </div>
                    <div class="message message-${safeName}"></div>
                </div>
            `;
        }).join('');

        // 🎯 關鍵改進：使用事件委派，在當前 panel 內處理點擊
        servicesGrid.querySelectorAll('.btn').forEach(btn => {
            btn.addEventListener('click', handleButtonClick);
        });
    }

    function handleButtonClick(e) {
        const button = e.target;
        const serviceName = button.dataset.service;
        const action = button.dataset.action;

        if (action === 'start') {
            startService(serviceName);
        } else if (action === 'stop') {
            stopService(serviceName);
        } else if (action === 'restart') {
            restartService(serviceName);
        }
    }

    function updateServiceStatus(serviceName, status) {
        const service = services.find(s => s.name === serviceName);
        if (service) {
            service.status = status;
            renderServices();
        }
    }

    function showMessage(serviceName, message, type) {
        // 🔥 使用清理後的名稱來查找元素
        const safeName = sanitizeForClass(serviceName);
        const messageDiv = panelRoot.querySelector(`.message-${safeName}`);
        if (messageDiv) {
            messageDiv.innerHTML = `<div class="message ${type}">${message}</div>`;
            setTimeout(() => {
                messageDiv.innerHTML = '';
            }, 3000);
        }
    }

    async function startService(serviceName) {
        const wasAutoRefreshEnabled = isAutoRefreshEnabled;
        if (wasAutoRefreshEnabled) stopAutoRefresh();

        try {
            showMessage(serviceName, '正在啟動...', 'success');
            const result = await apiRequest(
                CONFIG.endpoints.start,
                serviceName,
                CONFIG.requestConfig.start
            );

            if (result.success !== false) {
                updateServiceStatus(serviceName, 'running');
                showMessage(serviceName, '服務已啟動', 'success');
            } else {
                throw new Error(result.message || '啟動失敗');
            }
        } catch (error) {
            console.error('❌ 啟動失敗:', error);
            showMessage(serviceName, '啟動失敗: ' + error.message, 'error');
        } finally {
            if (wasAutoRefreshEnabled && isContentVisible) {
                await loadServices();
                startAutoRefresh();
            }
        }
    }

    async function stopService(serviceName) {
        const wasAutoRefreshEnabled = isAutoRefreshEnabled;
        if (wasAutoRefreshEnabled) stopAutoRefresh();

        try {
            showMessage(serviceName, '正在停止...', 'success');
            const result = await apiRequest(
                CONFIG.endpoints.stop,
                serviceName,
                CONFIG.requestConfig.stop
            );

            if (result.success !== false) {
                updateServiceStatus(serviceName, 'stopped');
                showMessage(serviceName, '服務已停止', 'success');
            } else {
                throw new Error(result.message || '停止失敗');
            }
        } catch (error) {
            console.error('❌ 停止失敗:', error);
            showMessage(serviceName, '停止失敗: ' + error.message, 'error');
        } finally {
            if (wasAutoRefreshEnabled && isContentVisible) {
                await loadServices();
                startAutoRefresh();
            }
        }
    }

    async function restartService(serviceName) {
        const wasAutoRefreshEnabled = isAutoRefreshEnabled;
        if (wasAutoRefreshEnabled) stopAutoRefresh();

        try {
            showMessage(serviceName, '正在重啟...', 'success');
            const result = await apiRequest(
                CONFIG.endpoints.restart,
                serviceName,
                CONFIG.requestConfig.restart
            );

            if (result.success !== false) {
                updateServiceStatus(serviceName, 'running');
                showMessage(serviceName, '服務已重啟', 'success');
            } else {
                throw new Error(result.message || '重啟失敗');
            }
        } catch (error) {
            console.error('❌ 重啟失敗:', error);
            showMessage(serviceName, '重啟失敗: ' + error.message, 'error');
        } finally {
            if (wasAutoRefreshEnabled && isContentVisible) {
                await loadServices();
                startAutoRefresh();
            }
        }
    }

    // ==========================================
    // 🚀 初始化
    // ==========================================
    // 先註解掉api自動更新開關UI, 但功能依然存在
    // autoRefreshToggle.addEventListener('change', toggleAutoRefresh);

    loadServices();
    startAutoRefresh();
    setupVisibilityObserver();
})();