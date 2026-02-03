let refreshIntervalId = null;
let autoRefreshEnabled = true;
let currentRefreshIntervalMs = 15000; // Default to 15 seconds in milliseconds, will be updated from input/localStorage
let currentDashboardView = 'overview'; // Default or set by initializeDashboard
let ongoingFetchPromise = null;
let lastFetchCompletedAtMs = 0;
const MIN_FETCH_GAP_MS = 1000; // Avoid hammering the API when manual triggers cluster together

// Function to get the current interval from the input field
function getRefreshIntervalMs() {
    const intervalInput = document.getElementById('refreshIntervalInput');
    if (intervalInput) {
        let seconds = parseInt(intervalInput.value, 10);
        const minSeconds = parseInt(intervalInput.min, 10) || 1;
        const maxSeconds = parseInt(intervalInput.max, 10) || 300;

        if (isNaN(seconds) || seconds < minSeconds || seconds > maxSeconds) {
            seconds = 15; // Default to 15s if input is invalid or out of bounds
            intervalInput.value = seconds; // Correct the input field
            console.warn(`Invalid interval: ${intervalInput.value}. Resetting to ${seconds}s.`);
        }
        return seconds * 1000; // Convert to milliseconds
    }
    console.warn("Refresh interval input not found, defaulting to 15000ms.");
    return 15000; // Default if input not found
}

function updateRefreshStatusLabel() {
    const refreshStatusEl = document.getElementById('refreshStatus');
    if (!refreshStatusEl) return;
    refreshStatusEl.textContent = autoRefreshEnabled ? 'ON' : 'OFF';
}

// Function to (re)start the interval timer
function startRefreshInterval() {
    if (refreshIntervalId) {
        clearInterval(refreshIntervalId);
        refreshIntervalId = null;
    }
    if (autoRefreshEnabled) {
        currentRefreshIntervalMs = getRefreshIntervalMs(); // Get the latest value from input
        console.log(`Starting refresh interval at ${currentRefreshIntervalMs / 1000} seconds.`);
        refreshIntervalId = setInterval(() => fetchAndUpdateAllData(false), currentRefreshIntervalMs);
    }
    updateRefreshStatusLabel();
}

function initializeDashboard(hostsConfig, viewType = 'overview') {
    console.log(`Initializing dashboard with config for ${viewType} view:`, hostsConfig);
    currentDashboardView = viewType;

    const dashboardContainer = document.getElementById('dashboardContainer');
    if (!dashboardContainer) {
        console.error("Dashboard container not found!");
        return;
    }
    dashboardContainer.innerHTML = '';

    const loadingMsgElement = document.createElement('p');
    loadingMsgElement.id = 'loadingMessage';
    loadingMsgElement.textContent = 'Loading data for configured hosts...';
    dashboardContainer.appendChild(loadingMsgElement);

    // Set interval input value from localStorage or default
    const intervalInput = document.getElementById('refreshIntervalInput');
    if (intervalInput) {
        const savedIntervalSeconds = localStorage.getItem('dashboardRefreshIntervalSeconds');
        if (savedIntervalSeconds) {
            intervalInput.value = savedIntervalSeconds;
        }
        // currentRefreshIntervalMs will be set by startRefreshInterval called below
    }

    if (!hostsConfig || hostsConfig.length === 0) {
        const loadingMsg = document.getElementById('loadingMessage');
        if (loadingMsg) {
            loadingMsg.textContent = 'No hosts configured. Please check monitored_hosts_config.json and reload config if needed.';
        }
        updateLastUpdatedTimestamp(false);
        return;
    }

    hostsConfig.forEach(host => {
        let hostCard;
        if (currentDashboardView === 'overview') {
            hostCard = createOverviewHostCardStructure(host);
        } else {
            hostCard = createDetailedHostCardStructure(host);
        }
        dashboardContainer.appendChild(hostCard);
    });

    fetchAndUpdateAllData();
    startRefreshInterval(); // Use the new function to start/restart with current interval value
    setupEventListeners();
    updateRefreshStatusLabel();
}

function setupEventListeners() {
    const toggleRefreshLink = document.getElementById('toggleRefresh');
    if (toggleRefreshLink) {
        toggleRefreshLink.removeEventListener('click', handleToggleRefresh);
        toggleRefreshLink.addEventListener('click', handleToggleRefresh);
    }

    const reloadConfigBtn = document.getElementById('reloadConfigBtn');
    if (reloadConfigBtn) {
        reloadConfigBtn.removeEventListener('click', handleReloadConfig);
        reloadConfigBtn.addEventListener('click', handleReloadConfig);
    }

    const intervalInput = document.getElementById('refreshIntervalInput');
    if (intervalInput) {
        intervalInput.removeEventListener('change', handleIntervalChange);
        intervalInput.addEventListener('change', handleIntervalChange);
    }
}

function handleIntervalChange() {
    const newIntervalMs = getRefreshIntervalMs();
    // currentRefreshIntervalMs is updated inside startRefreshInterval
    console.log(`Refresh interval input changed. New value: ${newIntervalMs / 1000} seconds.`);
    localStorage.setItem('dashboardRefreshIntervalSeconds', newIntervalMs / 1000);
    startRefreshInterval();
    if (autoRefreshEnabled) {
        fetchAndUpdateAllData();
    }
}

function handleToggleRefresh(event) {
    event.preventDefault();
    autoRefreshEnabled = !autoRefreshEnabled;
    if (autoRefreshEnabled) {
        console.log("Auto-refresh enabled.");
        startRefreshInterval();
        fetchAndUpdateAllData();
    } else {
        console.log("Auto-refresh disabled.");
        if (refreshIntervalId) {
            clearInterval(refreshIntervalId);
            refreshIntervalId = null;
        }
    }
    updateRefreshStatusLabel();
}

async function handleReloadConfig() {
    console.log("Reloading host configuration...");
    try {
        const response = await fetch('/api/config/reload', { method: 'POST' });
        const result = await response.json();
        alert(result.message || "Configuration reload processed.");

        const dataResponse = await fetch('/api/data?fresh=1');
        const payload = await dataResponse.json();
        const payloadMetadata = !Array.isArray(payload) ? (payload.metadata || {}) : {};
        const payloadError = !Array.isArray(payload) ? (payload.error || payloadMetadata.error) : null;
        const newHostData = Array.isArray(payload) ? payload : payload.data;

        if (payloadError) {
            console.error("Reload config: /api/data reported an error.", payloadError);
            const dashboardContainer = document.getElementById('dashboardContainer');
            if (dashboardContainer) {
                dashboardContainer.innerHTML = `<p id="loadingMessage" style="color:red;">Failed to load new host data after config reload: ${payloadError}</p>`;
            }
            return;
        }
        if (!Array.isArray(newHostData)) {
            console.error("Reload config: /api/data did not return an array.", payload);
            return;
        }

        const newHostsConfig = newHostData.map(host => ({ name: host.name, api_url: host.url }));

        const loadingMsg = document.getElementById('loadingMessage');
        if (loadingMsg) loadingMsg.remove();

        initializeDashboard(newHostsConfig, currentDashboardView);
        fetchAndUpdateAllData(true);

    } catch (error) {
        console.error('Error reloading host configuration:', error);
        alert('Failed to reload host configuration.');
    }
}

function createDetailedHostCardStructure(hostConfig) {
    const cardId = `host-card-detailed-${hostConfig.name.replace(/[^a-zA-Z0-9]/g, '-')}`;
    const card = document.createElement('div');
    card.className = 'host-card';
    card.id = cardId;
    card.innerHTML = `
        <h2>
            <span>${hostConfig.name} <span class="status-dot"></span></span>
            <a href="${hostConfig.api_url || '#'}" target="_blank" class="hostname-link" title="Open exporter API endpoint">${hostConfig.api_url ? new URL(hostConfig.api_url).hostname : 'N/A'}</a>
        </h2>
        <div class="timestamp">Last data: <span class="data-timestamp">Waiting...</span></div>
        <div class="error-message" style="display: none;"></div>
        <div class="stats-section">
            <h3 class="section-title">System Vitals</h3>
            <div class="metrics-grid">
                 <div class="metric-item">
                    <strong>CPU Usage</strong>
                    <span class="cpu-percent">N/A</span>%
                    <div class="progress-bar-container"><div class="progress-bar cpu-progress"></div></div>
                </div>
                <div class="metric-item">
                    <strong>Memory Usage</strong>
                    <span class="memory-percent">N/A</span>% (<span class="memory-used">N/A</span> / <span class="memory-total">N/A</span> GB)
                    <div class="progress-bar-container"><div class="progress-bar memory-progress"></div></div>
                </div>
                <div class="metric-item load-metric">
                    <strong>CPU Load (1m / 5m / 15m)</strong>
                    <div class="load-average-values">
                        <span class="load-val-1">N/A</span> /
                        <span class="load-val-5">N/A</span> /
                        <span class="load-val-15">N/A</span>
                    </div>
                    <div class="load-max-text">Max: <span class="load-max-value">N/A</span></div>
                    <div class="progress-bar-container"><div class="progress-bar load-progress"></div></div>
                </div>
                <div class="metric-item disk-metric">
                    <strong>Disk Usage</strong>
                    <div class="disk-usage-list detailed-disk-list">
                        <p class="no-disk-data">No disk data.</p>
                    </div>
                </div>
            </div>
        </div>
        <div class="stats-section">
            <h3 class="section-title">GPUs</h3>
            <div class="gpus-container">
                <p class="no-gpu-message" style="display: none;">No GPU data available or no GPUs found.</p>
            </div>
        </div>`;
    return card;
}

function createOverviewHostCardStructure(hostConfig) {
    const cardId = `host-card-overview-${hostConfig.name.replace(/[^a-zA-Z0-9]/g, '-')}`;
    const card = document.createElement('div');
    card.className = 'overview-host-card';
    card.id = cardId;
    const hostnameDisplay = hostConfig.api_url ? new URL(hostConfig.api_url).hostname : 'N/A';
    card.innerHTML = `
        <h2>
            <span>${hostConfig.name} <span class="status-dot"></span></span>
            <a href="${hostConfig.api_url || '#'}" target="_blank" class="hostname-link" title="Open exporter API endpoint">
                ${hostnameDisplay.substring(0, 15) + (hostnameDisplay.length > 15 ? '...' : '')}
            </a>
        </h2>
        <div class="error-message" style="display: none;"></div>
        <div class="overview-metrics-grid">
            <div class="overview-metric-item">
                <strong>CPU</strong>
                <span class="metric-value cpu-percent">N/A</span>%
                <div class="overview-progress-bar-container"><div class="overview-progress-bar cpu-progress"></div></div>
            </div>
            <div class="overview-metric-item">
                <strong>RAM</strong>
                <span class="metric-value memory-percent">N/A</span>%
                <div class="overview-progress-bar-container"><div class="overview-progress-bar memory-progress"></div></div>
            </div>
            <div class="overview-metric-item load-metric">
                <strong>Load 1/5/15m</strong>
                <div class="load-average-values overview-load-values">
                    <span class="load-val-1">N/A</span> /
                    <span class="load-val-5">N/A</span> /
                    <span class="load-val-15">N/A</span>
                </div>
                <div class="load-max-text overview-load-max">Max: <span class="load-max-value">N/A</span></div>
                <div class="overview-progress-bar-container"><div class="overview-progress-bar load-progress"></div></div>
            </div>
            <div class="overview-metric-item disk-metric">
                <strong>Disk Usage</strong>
                <div class="disk-usage-list overview-disk-list">
                    <p class="no-disk-data">No disk data.</p>
                </div>
            </div>
        </div>
        <div class="gpus-overview-container">
            <p class="no-gpu-message" style="display: none;">No GPUs.</p>
        </div>
        <div class="timestamp" style="font-size: 0.75em; text-align: right; margin-top: auto; padding-top: 0.5rem;">
           <span class="data-timestamp">Waiting...</span>
        </div>`;
    return card;
}

function updateLastUpdatedTimestamp(success = true, refreshUtc = null) {
    const lastUpdatedEl = document.getElementById('lastUpdated');
    if (lastUpdatedEl) {
        if (success) {
            let timestamp;
            if (refreshUtc) {
                const parsed = new Date(refreshUtc);
                timestamp = isNaN(parsed.getTime()) ? new Date() : parsed;
            } else {
                timestamp = new Date();
            }
            lastUpdatedEl.textContent = timestamp.toLocaleTimeString();
        } else {
            lastUpdatedEl.textContent = "Update Error";
        }
    } else {
        console.warn("Element with ID 'lastUpdated' not found.");
    }
}

function processHostPayload(hostsData, metadata = {}) {
    const loadingMsg = document.getElementById('loadingMessage');
    if (Array.isArray(hostsData)) {
        if (loadingMsg) loadingMsg.remove();
    } else {
        const errorMessage = metadata && metadata.error ? metadata.error : 'Unexpected response from API.';
        console.error('Received non-array data while processing host payload:', hostsData);
        if (loadingMsg && document.getElementById('dashboardContainer').contains(loadingMsg)) {
            loadingMsg.textContent = `Error: ${errorMessage}`;
            loadingMsg.style.color = 'red';
        } else {
            const dashboardContainer = document.getElementById('dashboardContainer');
            if (dashboardContainer) {
                dashboardContainer.innerHTML = `<p id="loadingMessage" style="color:red;">Error from API: ${errorMessage}</p>`;
            }
        }
        updateLastUpdatedTimestamp(false, metadata ? metadata.last_refresh_utc : null);
        return;
    }

    hostsData.forEach(hostData => {
        try {
            if (currentDashboardView === 'overview') {
                updateOverviewHostCard(hostData);
            } else {
                updateDetailedHostCard(hostData);
            }
        } catch (cardError) {
            console.error(`Error updating card for host ${hostData.name}:`, cardError);
            const cardId = `host-card-${currentDashboardView}-${hostData.name.replace(/[^a-zA-Z0-9]/g, '-')}`;
            const cardElement = document.getElementById(cardId);
            if (cardElement) {
                const errorEl = cardElement.querySelector('.error-message');
                if (errorEl) {
                    errorEl.textContent = "Error displaying data for this host.";
                    errorEl.style.display = 'block';
                }
                const statusDot = cardElement.querySelector('.status-dot');
                if (statusDot) statusDot.className = 'status-dot error';
            }
        }
    });

    const hasMetadataError = Boolean(metadata && metadata.error);
    updateLastUpdatedTimestamp(!hasMetadataError, metadata ? metadata.last_refresh_utc : null);
    if (hasMetadataError) {
        console.warn('Cache metadata reported an error:', metadata.error);
    }
}

async function fetchAndUpdateAllData(force = false) {
    const now = Date.now();

    if (!force && ongoingFetchPromise) {
        console.debug('Reusing in-flight fetch to avoid duplicate polling.');
        return ongoingFetchPromise;
    }

    if (!force && now - lastFetchCompletedAtMs < MIN_FETCH_GAP_MS) {
        console.debug('Skipping fetch; last update completed recently.');
        return;
    }

    const intervalMs = Number.isFinite(currentRefreshIntervalMs) && currentRefreshIntervalMs > 0
        ? currentRefreshIntervalMs
        : getRefreshIntervalMs();
    const intervalSeconds = Math.max(1, intervalMs / 1000);

    const params = new URLSearchParams();
    if (force) {
        params.set('fresh', '1');
    }
    params.set('client_interval_seconds', intervalSeconds.toFixed(3));

    const endpoint = `/api/data?${params.toString()}`;
    console.log(`Fetching data from ${endpoint} at ${new Date().toLocaleTimeString()} (Interval: ${intervalSeconds}s, force=${force})`);

    const fetchPromise = (async () => {
        try {
            const response = await fetch(endpoint, { cache: 'no-store' });
            if (!response.ok) {
                throw new Error(`API Error: ${response.status} ${response.statusText}`);
            }

            const payload = await response.json();
            const metadata = Array.isArray(payload) ? {} : (payload.metadata || {});
            const hostsData = Array.isArray(payload) ? payload : payload.data;

            if (!Array.isArray(hostsData)) {
                metadata.error = metadata.error || 'Malformed API response. Expected an array of hosts.';
                processHostPayload(null, metadata);
                return;
            }

            processHostPayload(hostsData, metadata);
        } catch (error) {
            console.error('Failed to fetch or update data globally:', error);
            updateLastUpdatedTimestamp(false);
            const loadingMsg = document.getElementById('loadingMessage');
            const dashboardContainer = document.getElementById('dashboardContainer');

            if (loadingMsg && dashboardContainer && dashboardContainer.contains(loadingMsg)) {
                loadingMsg.textContent = `Error fetching data: ${error.message}. Check console.`;
                loadingMsg.style.color = 'red';
            } else if (dashboardContainer && !document.querySelector('.host-card') && !document.querySelector('.overview-host-card')) {
                dashboardContainer.innerHTML = `<p style="color:red; text-align:center;">Error fetching data: ${error.message}.</p>`;
            }
        } finally {
            lastFetchCompletedAtMs = Date.now();
            ongoingFetchPromise = null;
        }
    })();

    ongoingFetchPromise = fetchPromise;
    return fetchPromise;
}

function updateDetailedHostCard(hostData) {
    const cardId = `host-card-detailed-${hostData.name.replace(/[^a-zA-Z0-9]/g, '-')}`;
    const card = document.getElementById(cardId);
    if (!card) {
        console.warn("Detailed card not found for host:", hostData.name);
        return;
    }

    const errorMsgEl = card.querySelector('.error-message');
    const statusDot = card.querySelector('.status-dot');
    const dataTimestampEl = card.querySelector('.data-timestamp');

    if (dataTimestampEl) {
        dataTimestampEl.textContent = hostData.fetch_time_utc ? new Date(hostData.fetch_time_utc).toLocaleTimeString() : (hostData.error ? 'Error' : 'N/A');
    }

    if (hostData.error) {
        errorMsgEl.textContent = `Error: ${hostData.error}`;
        errorMsgEl.style.display = 'block';
        if (statusDot) statusDot.className = 'status-dot error';
        setNodeText(card, '.cpu-percent', 'N/A');
        updateProgressBar(card, '.cpu-progress', 0, 'detailed');
        setNodeText(card, '.memory-percent', 'N/A');
        setNodeText(card, '.memory-used', 'N/A');
        setNodeText(card, '.memory-total', 'N/A');
        updateProgressBar(card, '.memory-progress', 0, 'detailed');
        applyLoadMetrics(card, {}, 'detailed', 'N/A');
        applyDiskMetrics(card, [], 'detailed', 'N/A');
        card.querySelector('.gpus-container').innerHTML = '<p class="no-gpu-message" style="display: block;">Error fetching host data.</p>';
        return;
    }

    errorMsgEl.style.display = 'none';
    if (statusDot) statusDot.className = 'status-dot ok';

    const system = hostData.system || {};
    if (system.error) {
        setNodeText(card, '.cpu-percent', 'Error');
        updateProgressBar(card, '.cpu-progress', 0, 'detailed');
        setNodeText(card, '.memory-percent', 'Error');
        if (statusDot) statusDot.className = 'status-dot warning';
    } else {
        setNodeText(card, '.cpu-percent', (typeof system.cpu_percent === 'number' ? system.cpu_percent.toFixed(1) : 'N/A'));
        updateProgressBar(card, '.cpu-progress', system.cpu_percent || 0, 'detailed');
        setNodeText(card, '.memory-percent', (typeof system.memory_percent === 'number' ? system.memory_percent.toFixed(1) : 'N/A'));
        setNodeText(card, '.memory-used', (typeof system.memory_used_gb === 'number' ? system.memory_used_gb.toFixed(2) : 'N/A'));
        setNodeText(card, '.memory-total', (typeof system.memory_total_gb === 'number' ? system.memory_total_gb.toFixed(2) : 'N/A'));
        updateProgressBar(card, '.memory-progress', system.memory_percent || 0, 'detailed');
    }

    const detailedLoadRatio = applyLoadMetrics(card, system, 'detailed', system.error ? 'Error' : 'N/A');
    if (statusDot && detailedLoadRatio !== null && detailedLoadRatio > 100 && statusDot.classList.contains('ok')) {
        statusDot.className = 'status-dot warning';
    }

    const diskSummary = applyDiskMetrics(card, Array.isArray(system.disks) ? system.disks : [], 'detailed', system.error ? 'Error' : 'N/A');
    if (statusDot && diskSummary.maxPercent !== null && diskSummary.maxPercent > 95 && statusDot.classList.contains('ok')) {
        statusDot.className = 'status-dot warning';
    }

    const gpusContainer = card.querySelector('.gpus-container');
    const noGpuMsg = gpusContainer.querySelector('.no-gpu-message') || document.createElement('p');
    if (!gpusContainer.querySelector('.no-gpu-message')) {
        noGpuMsg.className = 'no-gpu-message';
        noGpuMsg.style.display = 'none';
        gpusContainer.appendChild(noGpuMsg);
    }

    Array.from(gpusContainer.querySelectorAll('.gpu-card')).forEach(gc => gc.remove());

    if (hostData.gpus && Array.isArray(hostData.gpus) && hostData.gpus.length > 0) {
        let hasValidGpu = false;
        hostData.gpus.forEach(gpu => {
            if (typeof gpu !== 'object' || gpu === null) {
                console.warn("Malformed GPU data:", gpu); return;
            }
            if (gpu.error || gpu.message) {
                const gpuErrorCard = document.createElement('div');
                gpuErrorCard.className = 'gpu-card';
                gpuErrorCard.innerHTML = `<h4>GPU ${gpu.id || 'N/A'}</h4><p class="error-message" style="font-size:0.9em;">${gpu.error || gpu.message}</p>`;
                gpusContainer.appendChild(gpuErrorCard);
                if (statusDot && statusDot.className === 'status-dot ok') statusDot.className = 'status-dot warning';
                return;
            }
            hasValidGpu = true;

            const gpuCard = document.createElement('div');
            gpuCard.className = 'gpu-card';

            // Calculate total GPU memory in GB (rounded up)
            let totalMemGB = null;
            if (typeof gpu.memory_total_mib === 'number') {
                totalMemGB = Math.ceil(gpu.memory_total_mib / 1024);
            }

            let processesTable = '<p>No process data.</p>';
            if (gpu.processes && Array.isArray(gpu.processes) && gpu.processes.length > 0 && !(gpu.processes[0] && gpu.processes[0].error_detail)) {
                processesTable = `
                    <table class="processes-table">
                        <thead><tr><th>PID</th><th>User</th><th>GPU Mem (MiB)</th><th>CPU%</th><th>Command</th></tr></thead>
                        <tbody>
                            ${gpu.processes.map(p => `
                                <tr>
                                    <td>${p.pid || 'N/A'}</td>
                                    <td>${p.username || 'N/A'}</td>
                                    <td>${typeof p.gpu_memory_used_mib === 'number' ? p.gpu_memory_used_mib.toFixed(1) : 'N/A'}</td>
                                    <td>${typeof p.cpu_percent === 'number' ? p.cpu_percent.toFixed(1) : 'N/A'}%</td>
                                    <td class="command" title="${p.command || ''}">${(p.command || 'N/A').substring(0, 50)}${(p.command && p.command.length > 50) ? '...' : ''}</td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>`;
            } else if (gpu.processes && gpu.processes[0] && gpu.processes[0].error_detail) {
                processesTable = `<p class="error-message" style="font-size:0.9em;">Proc Error: ${gpu.processes[0].error_detail}</p>`;
            }

            gpuCard.innerHTML = `
                <h4>GPU ${gpu.id !== undefined ? gpu.id : 'N/A'}: ${cleanGpuName(gpu.name) || 'N/A'}${totalMemGB !== null ? ` (${totalMemGB} GB)` : ''}</h4>
                <div class="gpu-metric-row">
                    <span class="gpu-metric-label">Util:</span>
                    <div class="progress-bar-container"><div class="progress-bar gpu-util-progress"></div></div>
                    <span class="gpu-metric-value gpu-util-val">${typeof gpu.utilization_gpu_percent === 'number' ? gpu.utilization_gpu_percent.toFixed(1) : 'N/A'}%</span>
                </div>
                <div class="gpu-metric-row">
                    <span class="gpu-metric-label">Mem:</span>
                    <div class="progress-bar-container"><div class="progress-bar gpu-mem-progress"></div></div>
                    <span class="gpu-metric-value gpu-mem-val">${typeof gpu.memory_percent === 'number' ? gpu.memory_percent.toFixed(1) : 'N/A'}%</span>
                </div>
                <p style="text-align: right; font-size: 0.85em; margin-top: 0em; margin-bottom: 0.5em;">
                    <small>(${typeof gpu.memory_used_mib === 'number' ? gpu.memory_used_mib.toFixed(1) : 'N/A'} / ${typeof gpu.memory_total_mib === 'number' ? gpu.memory_total_mib.toFixed(1) : 'N/A'} MiB)</small>
                </p>
                <p>Temp: ${typeof gpu.temperature_celsius === 'number' ? gpu.temperature_celsius : 'N/A'}°C | Fan: ${typeof gpu.fan_speed_percent === 'number' ? gpu.fan_speed_percent : 'N/A'}%</p>
                <p>Pwr: ${typeof gpu.power_usage_watts === 'number' ? gpu.power_usage_watts.toFixed(1) : 'N/A'}W / ${typeof gpu.power_limit_watts === 'number' ? gpu.power_limit_watts.toFixed(1) : 'N/A'}W</p>
                <div class="section-title" style="font-size:1rem; margin-top:0.5rem;">Processes</div>
                ${processesTable}
            `;
            updateProgressBar(gpuCard, '.gpu-util-progress', gpu.utilization_gpu_percent || 0, 'detailed');
            updateProgressBar(gpuCard, '.gpu-mem-progress', gpu.memory_percent || 0, 'detailed');
            gpusContainer.appendChild(gpuCard);
        });
        if (noGpuMsg) noGpuMsg.style.display = hasValidGpu ? 'none' : 'block';
        if (!hasValidGpu && noGpuMsg) noGpuMsg.textContent = "No valid GPU data to display.";
    } else {
        let gpuErrorText = "No GPUs detected or data unavailable.";
        if (hostData.gpus && hostData.gpus.length > 0 && (hostData.gpus[0].error || hostData.gpus[0].message)) {
            gpuErrorText = hostData.gpus[0].error || hostData.gpus[0].message;
        }
        if (noGpuMsg) {
            noGpuMsg.textContent = gpuErrorText;
            noGpuMsg.style.display = 'block';
        }
        if (statusDot && statusDot.className === 'status-dot ok') statusDot.className = 'status-dot warning';
    }
}

function updateOverviewHostCard(hostData) {
    const cardId = `host-card-overview-${hostData.name.replace(/[^a-zA-Z0-9]/g, '-')}`;
    const card = document.getElementById(cardId);
    if (!card) {
        console.warn("Overview card not found for host:", hostData.name);
        return;
    }

    const errorMsgEl = card.querySelector('.error-message');
    const statusDot = card.querySelector('.status-dot');
    const dataTimestampEl = card.querySelector('.data-timestamp');
    if (dataTimestampEl) {
        dataTimestampEl.textContent = hostData.fetch_time_utc ? new Date(hostData.fetch_time_utc).toLocaleTimeString() : (hostData.error ? 'Error' : 'N/A');
    }

    if (hostData.error) {
        errorMsgEl.textContent = `Error: ${hostData.error}`;
        errorMsgEl.style.display = 'block';
        if (statusDot) statusDot.className = 'status-dot error';
        setNodeText(card, '.cpu-percent', 'ERR');
        updateProgressBar(card, '.cpu-progress', 0, 'overview', false);
        setNodeText(card, '.memory-percent', 'ERR');
        updateProgressBar(card, '.memory-progress', 0, 'overview', false);
        applyLoadMetrics(card, {}, 'overview', 'ERR');
        applyDiskMetrics(card, [], 'overview', 'ERR');
        card.querySelector('.gpus-overview-container').innerHTML = '<p class="no-gpu-message" style="display: block;">Error fetching host data.</p>';
        return;
    }
    errorMsgEl.style.display = 'none';
    if (statusDot) statusDot.className = 'status-dot ok';

    const system = hostData.system || {};
    if (system.error) {
        setNodeText(card, '.cpu-percent', 'Error');
        updateProgressBar(card, '.cpu-progress', 0, 'overview', false);
        setNodeText(card, '.memory-percent', 'Error');
        if (statusDot) statusDot.className = 'status-dot warning';
    } else {
        setNodeText(card, '.cpu-percent', (typeof system.cpu_percent === 'number' ? system.cpu_percent.toFixed(0) : 'N/A'));
        updateProgressBar(card, '.cpu-progress', system.cpu_percent || 0, 'overview', false);
        setNodeText(card, '.memory-percent', (typeof system.memory_percent === 'number' ? system.memory_percent.toFixed(0) : 'N/A'));
        updateProgressBar(card, '.memory-progress', system.memory_percent || 0, 'overview', false);
    }

    const overviewLoadRatio = applyLoadMetrics(card, system, 'overview', system.error ? 'Error' : 'N/A');
    if (statusDot && overviewLoadRatio !== null && overviewLoadRatio > 100 && statusDot.classList.contains('ok')) {
        statusDot.className = 'status-dot warning';
    }

    const diskSummary = applyDiskMetrics(card, Array.isArray(system.disks) ? system.disks : [], 'overview', system.error ? 'Error' : 'N/A');
    if (statusDot && diskSummary.maxPercent !== null && diskSummary.maxPercent > 95 && statusDot.classList.contains('ok')) {
        statusDot.className = 'status-dot warning';
    }

    const gpusContainer = card.querySelector('.gpus-overview-container');
    const noGpuMsg = gpusContainer.querySelector('.no-gpu-message') || document.createElement('p');
    if (!gpusContainer.querySelector('.no-gpu-message')) {
        noGpuMsg.className = 'no-gpu-message';
        noGpuMsg.style.display = 'none';
        gpusContainer.appendChild(noGpuMsg);
    }
    Array.from(gpusContainer.querySelectorAll('.overview-gpu-card')).forEach(gc => gc.remove());

    if (hostData.gpus && Array.isArray(hostData.gpus) && hostData.gpus.length > 0) {
        let hasValidGpu = false;
        hostData.gpus.forEach(gpu => {
            if (typeof gpu !== 'object' || gpu === null) {
                console.warn("Malformed GPU data for overview:", gpu); return;
            }
            if (gpu.error || gpu.message) {
                const gpuErrorDiv = document.createElement('div');
                gpuErrorDiv.className = 'overview-gpu-card';
                gpuErrorDiv.innerHTML = `<h4>GPU ${gpu.id || 'N/A'}</h4><p style="font-size:0.8em; color:red;">${gpu.error || gpu.message}</p>`;
                gpusContainer.appendChild(gpuErrorDiv);
                if (statusDot && statusDot.className === 'status-dot ok') statusDot.className = 'status-dot warning';
                return;
            }
            hasValidGpu = true;
            const gpuOverviewCard = document.createElement('div');
            gpuOverviewCard.className = 'overview-gpu-card';

            // Calculate total GPU memory in GB (rounded up)
            let totalMemGB = null;
            if (typeof gpu.memory_total_mib === 'number') {
                totalMemGB = Math.ceil(gpu.memory_total_mib / 1024);
            }

            const processes = gpu.processes || [];
            let userProcessMap = {};
            let hasProcessData = false;

            if (processes.length > 0 && !(processes[0] && processes[0].error_detail)) {
                hasProcessData = true;
                processes.forEach(p => {
                    const user = p.username || 'N/A';
                    if (!userProcessMap[user]) {
                        userProcessMap[user] = [];
                    }
                    userProcessMap[user].push(p.command || 'N/A');
                });
            }

            // Fallback to process_usernames if no detailed process data
            const usernames = gpu.process_usernames || [];
            let usernamesHtml = '';

            if (hasProcessData) {
                const users = Object.keys(userProcessMap).sort();
                usernamesHtml = users.map(u => {
                    const commands = userProcessMap[u].join('\n');
                    // Escape quotes for the title attribute just in case
                    const safeCommands = commands.replace(/"/g, '&quot;');
                    return `<li class="overview-user-tag" title="${safeCommands}">${u}</li>`;
                }).join('');
            } else if (usernames.length > 0 && usernames[0] !== "N/A" && usernames[0] !== "None") {
                usernamesHtml = usernames.map(u => `<li class="overview-user-tag">${u}</li>`).join('');
            } else if (usernames.length > 0 && (usernames[0] === "N/A" || usernames[0] === "None")) {
                usernamesHtml = `<li class="overview-user-tag"><i>${usernames[0]}</i></li>`;
            } else {
                usernamesHtml = "<li class=\"overview-user-tag\"><i>None</i></li>";
            }

            gpuOverviewCard.innerHTML = `
                <h4>GPU ${gpu.id}: <span style="font-weight:normal; font-size:0.85em;">${(cleanGpuName(gpu.name) || 'N/A').substring(0, 15)}${(gpu.name && cleanGpuName(gpu.name).length > 15 ? "..." : "")}${totalMemGB !== null ? ` (${totalMemGB} GB)` : ''}</span></h4>
                <div class="gpu-metric-row overview-gpu-metric-row">
                    <span class="gpu-metric-label">Util:</span>
                    <div class="overview-progress-bar-container"><div class="overview-progress-bar gpu-util-progress"></div></div>
                    <span class="gpu-metric-value">${typeof gpu.utilization_gpu_percent === 'number' ? gpu.utilization_gpu_percent.toFixed(0) : 'N/A'}%</span>
                </div>
                <div class="gpu-metric-row overview-gpu-metric-row">
                    <span class="gpu-metric-label">Mem:</span>
                    <div class="overview-progress-bar-container"><div class="overview-progress-bar gpu-mem-progress"></div></div>
                    <span class="gpu-metric-value">${typeof gpu.memory_percent === 'number' ? gpu.memory_percent.toFixed(0) : 'N/A'}%</span>
                </div>
                <div class="overview-gpu-processes">
                    <strong>Users:</strong> <ul class="overview-user-list">${usernamesHtml}</ul>
                </div>
            `;
            updateProgressBar(gpuOverviewCard, '.gpu-util-progress', gpu.utilization_gpu_percent || 0, 'overview', false);
            updateProgressBar(gpuOverviewCard, '.gpu-mem-progress', gpu.memory_percent || 0, 'overview', false);
            gpusContainer.appendChild(gpuOverviewCard);
        });
        if (noGpuMsg) noGpuMsg.style.display = hasValidGpu ? 'none' : 'block';
        if (!hasValidGpu && noGpuMsg) noGpuMsg.textContent = "No valid GPU data to display.";
    } else {
        let gpuErrorText = "No GPUs detected.";
        if (hostData.gpus && hostData.gpus.length > 0 && (hostData.gpus[0].error || hostData.gpus[0].message)) {
            gpuErrorText = hostData.gpus[0].error || hostData.gpus[0].message;
        }
        if (noGpuMsg) {
            noGpuMsg.textContent = gpuErrorText;
            noGpuMsg.style.display = 'block';
        }
        if (statusDot && statusDot.className === 'status-dot ok') statusDot.className = 'status-dot warning';
    }
}

// Helper to clean GPU names
function cleanGpuName(name) {
    if (!name || typeof name !== 'string') return name;
    // Remove NVIDIA, Nvidia, GeForce, RTX, Generation (case-insensitive, word boundaries)
    return name.replace(/\b(NVIDIA|Nvidia|GeForce|RTX|Generation)\b/gi, '').replace(/\s+/g, ' ').trim();
}

function setNodeText(parent, selector, text) {
    const el = parent.querySelector(selector);
    if (el) el.textContent = text;
}

function updateProgressBar(parent, selector, percentage, viewType = 'detailed', showText = true) {
    const bar = parent.querySelector(selector);
    if (!bar) {
        return;
    }

    const baseClass = viewType === 'overview' ? 'overview-progress-bar' : 'progress-bar';
    bar.classList.add(baseClass);
    bar.classList.remove(baseClass === 'overview-progress-bar' ? 'progress-bar' : 'overview-progress-bar');
    bar.classList.remove('high-usage', 'critical-usage', 'overload');

    const hasValue = typeof percentage === 'number' && Number.isFinite(percentage);
    const actualPercent = hasValue ? percentage : 0;
    const clampedPercent = Math.max(0, Math.min(actualPercent, 100));
    bar.style.width = `${hasValue ? clampedPercent : 0}%`;

    if (showText) {
        if (hasValue) {
            const decimals = viewType === 'overview' ? 0 : 1;
            bar.textContent = `${actualPercent.toFixed(decimals)}%`;
        } else {
            bar.textContent = 'N/A';
        }
    } else {
        bar.textContent = '';
    }

    if (!hasValue) {
        return;
    }

    if (actualPercent > 100) {
        bar.classList.add('overload');
    } else if (clampedPercent > 85) {
        bar.classList.add('critical-usage');
    } else if (clampedPercent > 65) {
        bar.classList.add('high-usage');
    }
}

function isFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
}

function applyLoadMetrics(parent, system, viewType = 'detailed', fallbackLabel = 'N/A') {
    const load1 = isFiniteNumber(system.load_average_1m) ? system.load_average_1m : null;
    const load5 = isFiniteNumber(system.load_average_5m) ? system.load_average_5m : null;
    const load15 = isFiniteNumber(system.load_average_15m) ? system.load_average_15m : null;
    const loadMax = isFiniteNumber(system.load_max) && system.load_max > 0 ? system.load_max : null;

    setNodeText(parent, '.load-val-1', load1 !== null ? load1.toFixed(2) : fallbackLabel);
    setNodeText(parent, '.load-val-5', load5 !== null ? load5.toFixed(2) : fallbackLabel);
    setNodeText(parent, '.load-val-15', load15 !== null ? load15.toFixed(2) : fallbackLabel);
    setNodeText(parent, '.load-max-value', loadMax !== null ? loadMax.toString() : fallbackLabel);

    const loadContainer = parent.querySelector('.load-average-values');
    if (loadContainer) {
        const summary = [
            `1m: ${load1 !== null ? load1.toFixed(2) : fallbackLabel}`,
            `5m: ${load5 !== null ? load5.toFixed(2) : fallbackLabel}`,
            `15m: ${load15 !== null ? load15.toFixed(2) : fallbackLabel}`,
            `Max: ${loadMax !== null ? loadMax : fallbackLabel}`
        ].join(' | ');
        loadContainer.setAttribute('title', summary);
    }

    const showText = viewType !== 'overview';
    const loadRatio = (load1 !== null && loadMax !== null) ? (load1 / loadMax) * 100 : null;
    updateProgressBar(parent, '.load-progress', loadRatio, viewType, showText);

    if (loadRatio === null) {
        const bar = parent.querySelector('.load-progress');
        if (bar) {
            bar.textContent = showText ? fallbackLabel : '';
        }
    }

    return loadRatio;
}

function formatGigabytes(value) {
    if (!isFiniteNumber(value)) {
        return 'N/A';
    }
    return `${value.toFixed(2)} GB`;
}

function applyDiskMetrics(parent, disks, viewType = 'detailed', fallbackLabel = 'N/A') {
    const listSelector = viewType === 'overview' ? '.overview-disk-list' : '.detailed-disk-list';
    const container = parent.querySelector(listSelector);

    if (!container) {
        return { maxPercent: null };
    }

    container.innerHTML = '';

    const addEmptyState = (text) => {
        const emptyEl = document.createElement('p');
        emptyEl.className = 'no-disk-data';
        emptyEl.textContent = text;
        container.appendChild(emptyEl);
    };

    if (!Array.isArray(disks) || disks.length === 0) {
        addEmptyState('No disk data.');
        return { maxPercent: null };
    }

    let maxPercent = null;

    disks.forEach(disk => {
        const item = document.createElement('div');
        item.className = `disk-item ${viewType}-disk-item`;

        const labelText = disk.label || disk.path || 'Unknown';

        if (disk.error) {
            item.classList.add('disk-item-error');

            const header = document.createElement('div');
            header.className = 'disk-item-header';

            const labelEl = document.createElement('span');
            labelEl.className = 'disk-label';
            labelEl.textContent = labelText;
            header.appendChild(labelEl);

            item.appendChild(header);

            const errorEl = document.createElement('div');
            errorEl.className = 'disk-error';
            errorEl.textContent = disk.error;
            item.appendChild(errorEl);

            container.appendChild(item);
            return;
        }

        const percentValue = isFiniteNumber(disk.percent_used) ? disk.percent_used : null;
        const percentDecimals = viewType === 'overview' ? 0 : 1;
        const percentText = percentValue !== null ? `${percentValue.toFixed(percentDecimals)}%` : fallbackLabel;

        const header = document.createElement('div');
        header.className = 'disk-item-header';

        const labelEl = document.createElement('span');
        labelEl.className = 'disk-label';
        labelEl.textContent = labelText;
        labelEl.title = disk.path || labelText;
        header.appendChild(labelEl);

        const percentEl = document.createElement('span');
        percentEl.className = 'disk-percent';
        percentEl.textContent = percentText;
        header.appendChild(percentEl);

        item.appendChild(header);

        const progressContainer = document.createElement('div');
        progressContainer.className = viewType === 'overview' ? 'overview-progress-bar-container' : 'progress-bar-container';

        const progressBar = document.createElement('div');
        progressBar.className = `${viewType === 'overview' ? 'overview-progress-bar' : 'progress-bar'} disk-progress`;
        progressContainer.appendChild(progressBar);
        item.appendChild(progressContainer);

        const usageDetails = document.createElement('div');
        usageDetails.className = 'disk-usage-details';
        const usedText = formatGigabytes(disk.used_gb);
        const totalText = formatGigabytes(disk.total_gb);
        usageDetails.textContent = `${usedText} / ${totalText}`;
        if (isFiniteNumber(disk.free_gb)) {
            usageDetails.textContent += ` (Free: ${formatGigabytes(disk.free_gb)})`;
        }
        item.appendChild(usageDetails);

        if (disk.path) {
            item.setAttribute('data-disk-path', disk.path);
        }
        if (percentValue !== null) {
            item.setAttribute('data-disk-percent', percentValue.toFixed(2));
        }

        container.appendChild(item);

        updateProgressBar(item, '.disk-progress', percentValue, viewType, viewType !== 'overview');

        if (percentValue !== null) {
            if (maxPercent === null) {
                maxPercent = percentValue;
            } else {
                maxPercent = Math.max(maxPercent, percentValue);
            }

            if (percentValue > 95) {
                item.classList.add('disk-item-critical');
            } else if (percentValue > 80) {
                item.classList.add('disk-item-warning');
            }
        }
    });

    if (!container.children.length) {
        addEmptyState('No disk data.');
        return { maxPercent: null };
    }

    return { maxPercent };
}

const faviconLink = document.createElement('link');
faviconLink.rel = 'icon';
faviconLink.href = '/static/favicon.ico';
document.head.appendChild(faviconLink);