const CONFIG = {
    apiBaseUrl: 'http://10.12.147.11:8000',
    endpoints: {
        restart: '/containers/{name}/restart'
    },
    requestConfig: {
        restart: { method: 'POST', body: { timeout: 10 } }
    }
};

// 🔧 工具函數
function sanitizeForClass(name) {
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
            ...(config.headers || {})
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

// 顯示訊息（可根據實際前端結構調整）
function showMessage(serviceName, message, type) {
    const safeName = sanitizeForClass(serviceName);
    const messageDiv = document.querySelector(`.message-${safeName}`);
    if (messageDiv) {
        messageDiv.innerHTML = `<div class="message ${type}">${message}</div>`;
        setTimeout(() => {
            messageDiv.innerHTML = '';
        }, 3000);
    }
}

// 重啟服務
async function restartService(serviceName) {
    try {
        showMessage(serviceName, '正在重啟...', 'success');
        const result = await apiRequest(
            CONFIG.endpoints.restart,
            serviceName,
            CONFIG.requestConfig.restart
        );
        if (result.success !== false) {
            showMessage(serviceName, '服務已重啟', 'success');
        } else {
            throw new Error(result.message || '重啟失敗');
        }
    } catch (error) {
        console.error(`❌ 重啟 ${serviceName} 失敗:`, error);
        showMessage(serviceName, '重啟失敗: ' + error.message, 'error');
    }
}

