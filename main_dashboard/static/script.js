let refreshIntervalId = null;
let autoRefreshEnabled = true;
let currentRefreshIntervalMs = 15000; // Default to 15 seconds in milliseconds, will be updated from input/localStorage
let currentDashboardView = 'overview'; // Default or set by initializeDashboard

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

// Function to (re)start the interval timer
function startRefreshInterval() {
    if (refreshIntervalId) {
        clearInterval(refreshIntervalId);
        refreshIntervalId = null;
    }
    if (autoRefreshEnabled) {
        currentRefreshIntervalMs = getRefreshIntervalMs(); // Get the latest value from input
        console.log(`Starting refresh interval at ${currentRefreshIntervalMs / 1000} seconds.`);
        refreshIntervalId = setInterval(fetchAndUpdateAllData, currentRefreshIntervalMs);
    }
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
    const refreshStatusEl = document.getElementById('refreshStatus');
    if (autoRefreshEnabled) {
        startRefreshInterval(); 
        if (refreshStatusEl) refreshStatusEl.textContent = 'ON';
        console.log("Auto-refresh enabled.");
        fetchAndUpdateAllData(); 
    } else {
        if (refreshIntervalId) {
            clearInterval(refreshIntervalId);
            refreshIntervalId = null;
        }
        if (refreshStatusEl) refreshStatusEl.textContent = 'OFF';
        console.log("Auto-refresh disabled.");
    }
}

async function handleReloadConfig() {
    console.log("Reloading host configuration...");
    try {
        const response = await fetch('/api/config/reload', { method: 'POST' });
        const result = await response.json();
        alert(result.message || "Configuration reload processed.");
        
        const dataResponse = await fetch('/api/data');
        const newHostData = await dataResponse.json();

        if (!Array.isArray(newHostData) && newHostData.error) {
            console.error("Reload config: /api/data returned an error.", newHostData.error);
            const dashboardContainer = document.getElementById('dashboardContainer');
            if (dashboardContainer) {
                 dashboardContainer.innerHTML = `<p id="loadingMessage" style="color:red;">Failed to load new host data after config reload: ${newHostData.error}</p>`;
            }
            return;
        }
         if (!Array.isArray(newHostData)) {
            console.error("Reload config: /api/data did not return an array.", newHostData);
            return;
        }

        const newHostsConfig = newHostData.map(host => ({ name: host.name, api_url: host.url })); 
        
        const loadingMsg = document.getElementById('loadingMessage');
        if(loadingMsg) loadingMsg.remove();

        initializeDashboard(newHostsConfig, currentDashboardView); 

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
                ${hostnameDisplay.substring(0,15) + (hostnameDisplay.length > 15 ? '...' : '')}
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
        </div>
        <div class="gpus-overview-container">
            <p class="no-gpu-message" style="display: none;">No GPUs.</p>
        </div>
        <div class="timestamp" style="font-size: 0.75em; text-align: right; margin-top: auto; padding-top: 0.5rem;">
           <span class="data-timestamp">Waiting...</span>
        </div>`;
    return card;
}

function updateLastUpdatedTimestamp(success = true) {
    const lastUpdatedEl = document.getElementById('lastUpdated');
    if (lastUpdatedEl) {
        if (success) {
            lastUpdatedEl.textContent = new Date().toLocaleTimeString();
        } else {
            lastUpdatedEl.textContent = "Update Error";
        }
    } else {
        console.warn("Element with ID 'lastUpdated' not found.");
    }
}

async function fetchAndUpdateAllData() {
    console.log("Fetching data from /api/data... at " + new Date().toLocaleTimeString() + ` (Interval: ${currentRefreshIntervalMs/1000}s)`);
    try {
        const response = await fetch('/api/data');
        if (!response.ok) {
            throw new Error(`API Error: ${response.status} ${response.statusText}`);
        }
        const hostsData = await response.json();
        
        const loadingMsg = document.getElementById('loadingMessage');
        if(loadingMsg) loadingMsg.remove();

        if (!Array.isArray(hostsData)) {
            console.error("Received non-array data from /api/data:", hostsData);
            if(hostsData && hostsData.error) {
                const dashboardContainer = document.getElementById('dashboardContainer');
                if (dashboardContainer) {
                    dashboardContainer.innerHTML = `<p id="loadingMessage" style="color:red;">Error from API: ${hostsData.error}</p>`;
                }
            }
            updateLastUpdatedTimestamp(false);
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
                    if(statusDot) statusDot.className = 'status-dot error';
                }
            }
        });
        updateLastUpdatedTimestamp(true);

    } catch (error) {
        console.error('Failed to fetch or update data globally:', error);
        updateLastUpdatedTimestamp(false);
        const loadingMsg = document.getElementById('loadingMessage');
        if (loadingMsg && document.getElementById('dashboardContainer').contains(loadingMsg)) {
            loadingMsg.textContent = `Error fetching data: ${error.message}. Check console.`;
            loadingMsg.style.color = 'red';
        } else if (!document.querySelector('.host-card') && !document.querySelector('.overview-host-card')) {
             const dashboardContainer = document.getElementById('dashboardContainer');
             if(dashboardContainer) dashboardContainer.innerHTML = `<p style="color:red; text-align:center;">Error fetching data: ${error.message}.</p>`;
        }
    }
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
                                    <td class="command" title="${p.command || ''}">${(p.command || 'N/A').substring(0,50)}${(p.command && p.command.length > 50) ? '...' : ''}</td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>`;
            } else if (gpu.processes && gpu.processes[0] && gpu.processes[0].error_detail) {
                 processesTable = `<p class="error-message" style="font-size:0.9em;">Proc Error: ${gpu.processes[0].error_detail}</p>`;
            }

            gpuCard.innerHTML = `
                <h4>GPU ${gpu.id !== undefined ? gpu.id : 'N/A'}: ${gpu.name || 'N/A'}</h4>
                <p>Util: <span class="gpu-util-val">${typeof gpu.utilization_gpu_percent === 'number' ? gpu.utilization_gpu_percent.toFixed(1) : 'N/A'}</span>%</p>
                <div class="progress-bar-container"><div class="progress-bar gpu-util-progress"></div></div>
                <p>Mem: <span class="gpu-mem-val">${typeof gpu.memory_percent === 'number' ? gpu.memory_percent.toFixed(1) : 'N/A'}</span>% 
                   (${typeof gpu.memory_used_mib === 'number' ? gpu.memory_used_mib.toFixed(1) : 'N/A'} / ${typeof gpu.memory_total_mib === 'number' ? gpu.memory_total_mib.toFixed(1) : 'N/A'} MiB)</p>
                <div class="progress-bar-container"><div class="progress-bar gpu-mem-progress"></div></div>
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
            
            const usernames = gpu.process_usernames || [];
            const usernamesList = usernames.length > 0 && usernames[0] !== "N/A"
                ? `<ul>${usernames.map(u => `<li>${u === "None" ? "<i>None</i>" : u}</li>`).join('')}</ul>`
                : (usernames.length > 0 && usernames[0] === "N/A" ? "<ul><li><i>N/A</i></li></ul>" : "<ul><li><i>None</i></li></ul>");

            gpuOverviewCard.innerHTML = `
                <h4>GPU ${gpu.id}: <span style="font-weight:normal; font-size:0.85em;">${(gpu.name || 'N/A').substring(0,15)}${(gpu.name && gpu.name.length > 15 ? "..." : "")}</span></h4>
                <div class="gpu-metrics-condensed">
                    <span class="gpu-metric-pair"><strong>Util:</strong> ${typeof gpu.utilization_gpu_percent === 'number' ? gpu.utilization_gpu_percent.toFixed(0) : 'N/A'}%</span>
                    <span class="gpu-metric-pair"><strong>Mem:</strong> ${typeof gpu.memory_percent === 'number' ? gpu.memory_percent.toFixed(0) : 'N/A'}%</span>
                </div>
                <div class="overview-progress-bar-container" style="height:8px; margin-top:2px; margin-bottom: 4px;">
                    <div class="overview-progress-bar gpu-util-progress"></div>
                </div>
                 <div class="overview-progress-bar-container" style="height:8px; margin-bottom: 4px;">
                    <div class="overview-progress-bar gpu-mem-progress"></div>
                </div>
                <div class="overview-gpu-processes">
                    <strong>Users:</strong> ${usernamesList}
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

function setNodeText(parent, selector, text) {
    const el = parent.querySelector(selector);
    if (el) el.textContent = text;
}

function updateProgressBar(parent, selector, percentage, viewType = 'detailed', showText = true) {
    const bar = parent.querySelector(selector);
    if (bar) {
        const p = Math.max(0, Math.min(100, typeof percentage === 'number' ? percentage : 0));
        bar.style.width = `${p}%`;
        if (showText) {
            bar.textContent = `${p.toFixed(viewType === 'overview' ? 0 : 1)}%`;
        } else {
            bar.textContent = '';
        }
        
        const progressBarClassPrefix = viewType === 'overview' ? 'overview-progress-bar' : 'progress-bar';
        bar.className = progressBarClassPrefix; 

        if (p > 85) {
            bar.classList.add('critical-usage');
        } else if (p > 65) {
            bar.classList.add('high-usage');
        }
    }
}

const faviconLink = document.createElement('link');
faviconLink.rel = 'icon';
faviconLink.href = '/static/favicon.ico'; 
document.head.appendChild(faviconLink);