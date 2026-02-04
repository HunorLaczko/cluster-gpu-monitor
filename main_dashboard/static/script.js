/**
 * nvitop-dashboard Frontend Logic
 * Refactored for modularity, ES6+ standards, and modern error handling.
 */

class DashboardApp {
    constructor() {
        this.config = {
            refreshIntervalMs: 15000,
            autoRefresh: true,
            minFetchGapMs: 1000,
            viewType: 'overview',
            usageThresholds: {
                critical: 90,
                high: 70
            }
        };

        this.state = {
            hosts: [],
            lastFetchTime: 0,
            fetchPromise: null,
            fetchPromise: null,
            timerId: null,
            systemUsers: [] // Store fetched system users
        };

        this.els = {
            container: document.getElementById('dashboardContainer'),
            lastUpdated: document.getElementById('lastUpdated'),
            refreshStatus: document.getElementById('refreshStatus'),
            intervalInput: document.getElementById('refreshIntervalInput'),
            toggleBtn: document.getElementById('toggleRefresh'),
            reloadBtn: document.getElementById('reloadConfigBtn'),
            themeSelect: document.getElementById('themeSelect'),
            themeLink: document.getElementById('theme-stylesheet')
        };
    }

    /**
     * Escapes HTML special characters to prevent XSS attacks.
     * @param {string} str - The string to escape.
     * @returns {string} The escaped string safe for HTML insertion.
     */
    _escapeHtml(str) {
        if (str == null) return '';
        const div = document.createElement('div');
        div.textContent = String(str);
        return div.innerHTML;
    }

    /**
     * Entry point to initialize the dashboard.
     * @param {Array} initialHosts - List of host objects from server template.
     * @param {string} viewType - 'overview' or 'detailed'.
     */
    init(initialHosts, viewType) {
        this.config.viewType = viewType;
        this.state.hosts = initialHosts || [];

        console.log(`Initializing Dashboard (${viewType}) with ${this.state.hosts.length} hosts.`);

        this._loadSettings();
        this._setupEventListeners();
        this._renderInitialStructure();

        // Fetch system users for validation
        this.fetchSystemUsers();

        // Check for debug flag
        const urlParams = new URLSearchParams(window.location.search);
        if (urlParams.get('debug') === 'true') {
            this._enableDebugMode();
        }

        // Start the loop
        this.startAutoRefresh();
        this.fetchData();
    }

    _enableDebugMode() {
        // Add Debug link to status bar if not already present
        const statusBar = document.querySelector('.status-bar');
        if (statusBar && !statusBar.querySelector('a[href="/debug"]')) {
            // Find the last link before the "Last Updated" span
            const links = statusBar.querySelectorAll('a');
            const lastLink = links[links.length - 1]; // Usually "Docker"

            if (lastLink) {
                const debugLink = document.createElement('a');
                debugLink.href = "/debug";
                debugLink.className = window.location.pathname === '/debug' ? 'active-view' : '';
                debugLink.textContent = "Debug";
                debugLink.style.marginLeft = "5px"; // spacing

                // Insert separator and link
                const separator = document.createTextNode(" | ");
                lastLink.parentNode.insertBefore(separator, lastLink.nextSibling);
                lastLink.parentNode.insertBefore(debugLink, separator.nextSibling);
            }
        }
    }

    async fetchSystemUsers() {
        try {
            const res = await fetch('/api/users');
            const data = await res.json();
            if (data.users && Array.isArray(data.users)) {
                const EXCLUDED_USERS = ['root', 'test'];
                this.state.systemUsers = data.users
                    .map(u => u.username)
                    .filter(u => !EXCLUDED_USERS.includes(u));
                console.log('System users loaded for validation:', this.state.systemUsers.length);
            }
        } catch (err) {
            console.error('Failed to fetch system users:', err);
        }
    }



    _setupEventListeners() {
        if (this.els.toggleBtn) {
            this.els.toggleBtn.addEventListener('click', (e) => {
                e.preventDefault();
                this.toggleAutoRefresh();
            });
        }

        if (this.els.intervalInput) {
            this.els.intervalInput.addEventListener('change', () => {
                let seconds = parseInt(this.els.intervalInput.value, 10);
                if (isNaN(seconds) || seconds < 1) seconds = 15;
                this.els.intervalInput.value = seconds;

                this.config.refreshIntervalMs = seconds * 1000;
                localStorage.setItem('dashboardRefreshIntervalSeconds', seconds);

                console.log(`Interval updated to ${seconds}s`);
                this.startAutoRefresh(); // Restart timer
            });
        }

        if (this.els.reloadBtn) {
            this.els.reloadBtn.addEventListener('click', () => this.reloadConfig());
        }

        if (this.els.themeSelect) {
            this.els.themeSelect.addEventListener('change', (e) => {
                this.setTheme(e.target.value);
            });
        }
    }

    _loadSettings() {
        // Load Refresh Interval
        if (this.els.intervalInput) {
            const saved = localStorage.getItem('dashboardRefreshIntervalSeconds');
            if (saved) {
                const val = parseInt(saved, 10);
                if (val > 0) {
                    this.els.intervalInput.value = val;
                    this.config.refreshIntervalMs = val * 1000;
                }
            }
            this.config.refreshIntervalMs = parseInt(this.els.intervalInput.value, 10) * 1000;
        }

        // Load Theme
        const savedTheme = localStorage.getItem('dashboardTheme') || 'glass';
        this.setTheme(savedTheme);
    }

    setTheme(themeName) {
        if (!this.els.themeLink) return;

        // Map theme names to filenames
        const themeMap = {
            'glass': 'theme_glass.css',
            'classic': 'theme_classic.css'
        };

        const filename = themeMap[themeName] || 'theme_glass.css';

        // Determine base path from current href to preserve relative paths
        const currentHref = this.els.themeLink.getAttribute('href');
        const basePath = currentHref.substring(0, currentHref.lastIndexOf('/') + 1);

        this.els.themeLink.setAttribute('href', basePath + filename);

        if (this.els.themeSelect) {
            this.els.themeSelect.value = themeName;
        }

        localStorage.setItem('dashboardTheme', themeName);
        console.log(`Theme set to: ${themeName} (${filename})`);
    }

    _renderInitialStructure() {
        this.els.container.innerHTML = '';

        if (!this.state.hosts.length) {
            this.showError('No hosts configured. Please checking settings or monitored_hosts.json.');
            return;
        }

        this.state.hosts.forEach(host => {
            let card;
            if (this.config.viewType === 'overview') {
                card = this._createOverviewCard(host);
            } else if (this.config.viewType === 'detailed') {
                card = this._createDetailedCard(host);
            } else if (this.config.viewType === 'docker') {
                card = this._createDockerCard(host);
            }
            if (card) this.els.container.appendChild(card);
        });
    }

    startAutoRefresh() {
        if (this.state.timerId) clearInterval(this.state.timerId);

        this._updateStatusUI();

        if (!this.config.autoRefresh) return;

        console.log(`Starting auto-refresh every ${this.config.refreshIntervalMs}ms`);
        this.state.timerId = setInterval(() => {
            this.fetchData();
        }, this.config.refreshIntervalMs);
    }

    toggleAutoRefresh() {
        this.config.autoRefresh = !this.config.autoRefresh;
        this.startAutoRefresh();
    }

    _updateStatusUI() {
        if (this.els.refreshStatus) {
            this.els.refreshStatus.textContent = this.config.autoRefresh ? 'ON' : 'OFF';
            this.els.refreshStatus.className = this.config.autoRefresh ? 'status-on' : 'status-off';
        }
    }

    async reloadConfig() {
        try {
            this.showToast('Reloading configuration...');
            const res = await fetch('/api/config/reload', { method: 'POST' });
            const data = await res.json();

            // Force a fresh fetch to get the new host list
            await this.fetchData(true);

            // Reload page to ensure clean state
            location.reload();
        } catch (err) {
            console.error('Config reload failed:', err);
            this.showError('Failed to reload configuration.');
        }
    }

    async fetchData(force = false) {
        const now = Date.now();
        // Debounce
        if (!force && now - this.state.lastFetchTime < this.config.minFetchGapMs) return;
        if (this.state.fetchPromise) return this.state.fetchPromise;

        const intervalSec = (this.config.refreshIntervalMs / 1000).toFixed(0);
        const url = `/api/data?client_interval_seconds=${intervalSec}${force ? '&fresh=1' : ''}`;

        this.state.fetchPromise = (async () => {
            try {
                const res = await fetch(url);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);

                const json = await res.json();
                this._processData(json);
                this.state.lastFetchTime = Date.now();
            } catch (err) {
                console.error('Fetch error:', err);
                this._handleGlobalError(err);
            } finally {
                this.state.fetchPromise = null;
            }
        })();

        return this.state.fetchPromise;
    }

    _processData(responsePayload) {
        // Handle normalization (array vs object with metadata)
        let data = [];
        let metadata = {};

        if (Array.isArray(responsePayload)) {
            data = responsePayload;
        } else {
            data = responsePayload.data || [];
            metadata = responsePayload.metadata || {};
        }

        if (metadata.error) {
            this.showError(metadata.error);
        }

        // Update timestamp
        if (this.els.lastUpdated) {
            const ts = metadata.last_refresh_utc
                ? new Date(metadata.last_refresh_utc).toLocaleTimeString()
                : new Date().toLocaleTimeString();
            this.els.lastUpdated.textContent = ts;
        }

        // Update cards
        data.forEach(hostData => {
            try {
                if (this.config.viewType === 'overview') {
                    this._updateOverviewCard(hostData);
                } else if (this.config.viewType === 'detailed') {
                    this._updateDetailedCard(hostData);
                } else if (this.config.viewType === 'docker') {
                    this._updateDockerCard(hostData);
                }
            } catch (e) {
                console.error(`Error updating host ${hostData.name}:`, e);
                this._showCardError(hostData.name, e.message);
            }
        });
    }

    _showCardError(hostname, msg) {
        const id = `host-${this._sanitizeId(hostname)}`;
        const card = document.getElementById(id);
        if (card) {
            const ts = card.querySelector('.timestamp');
            if (ts) {
                ts.textContent = 'Client Update Error';
                ts.style.color = 'var(--error-color)';
                ts.title = msg;
            }
        }
    }

    _handleGlobalError(err) {
        if (this.els.lastUpdated) {
            this.els.lastUpdated.textContent = 'Connection Error';
            this.els.lastUpdated.style.color = 'var(--error-color)';
        }
    }

    // --- Overview View ---

    _createOverviewCard(host) {
        const div = document.createElement('div');
        div.className = 'overview-host-card';
        div.id = `host-${this._sanitizeId(host.name)}`;

        const hostname = this._extractHostname(host.api_url);
        const escapedName = this._escapeHtml(host.name);
        const escapedHostname = this._escapeHtml(hostname);
        const escapedUrl = this._escapeHtml(host.api_url || '#');

        div.innerHTML = `
            <h2>
                <span>${escapedName} <span class="status-dot"></span></span>
                <a href="${escapedUrl}" target="_blank" class="hostname-link">${escapedHostname}</a>
            </h2>
            <div class="overview-metrics-grid">
                <div class="overview-metric-item">
                    <strong>CPU</strong>
                    <span class="metric-value cpu-val">--</span>
                    <div class="overview-progress-bar-container"><div class="overview-progress-bar cpu-bar"></div></div>
                </div>
                <div class="overview-metric-item">
                    <strong>RAM</strong>
                    <span class="metric-value ram-val">--</span>
                    <div class="overview-progress-bar-container"><div class="overview-progress-bar ram-bar"></div></div>
                </div>
                <div class="overview-metric-item load-metric">
                     <strong>Load Avg (1/5/15)</strong>
                     <span class="metric-value load-val-overview">--</span>
                     <div class="load-max-text" style="display:none;font-size:0.8em;color:var(--text-secondary);"></div>
                     <div class="overview-progress-bar-container"><div class="overview-progress-bar load-bar"></div></div>
                </div>
            </div>
            
            <div class="overview-disk-list overview-metric-item disk-metric" style="display:none;"></div>

            <div class="gpus-container"></div>
            <div class="timestamp">Wait...</div>
        `;
        return div;
    }

    _updateOverviewCard(data) {
        const id = `host-${this._sanitizeId(data.name)}`;
        const card = document.getElementById(id);
        if (!card) return;

        const system = data.system || {};
        const isError = !!data.error || !!system.error;

        // Status Dot
        const dot = card.querySelector('.status-dot');
        if (dot) dot.className = `status-dot ${isError ? 'error' : 'ok'}`;

        // CPU/RAM
        this._updateMetric(card, '.cpu-val', '.cpu-bar', system.cpu_percent, '%', isError);
        this._updateMetric(card, '.ram-val', '.ram-bar', system.memory_percent, '%', isError);

        // GPUs
        const gpuContainer = card.querySelector('.gpus-container');
        gpuContainer.innerHTML = ''; // Rebuild for simplicity

        if (data.gpus && data.gpus.length && !data.error) {
            data.gpus.forEach(gpu => {
                if (gpu.error) {
                    gpuContainer.innerHTML += `<div class="overview-gpu-card error"><small>${gpu.error}</small></div>`;
                    return;
                }
                const util = gpu.utilization_gpu_percent || 0;
                const mem = gpu.memory_percent || 0;

                const users = this._getGPUUsers(gpu);
                const hasMultipleUsers = users.length > 1;
                const userTags = users.map(u => {
                    const escapedUsername = this._escapeHtml(u.username);
                    const escapedCmdList = this._escapeHtml(u.commands.join(', '));
                    const warningClass = hasMultipleUsers ? ' multi-user-warning' : '';
                    return `<li class="overview-user-tag${warningClass}" title="User: ${escapedUsername}&#10;Process: ${escapedCmdList}"><i class="user-icon">👤</i>${escapedUsername}</li>`;
                }).join('');

                const usersHtml = userTags ? `<div class="overview-gpu-processes"><strong>Users:</strong> <ul class="overview-user-list">${userTags}</ul></div>` : '';

                const el = document.createElement('div');
                el.className = 'overview-gpu-card';
                const escapedGpuName = this._escapeHtml(this._cleanGpuName(gpu.name));
                el.innerHTML = `
                    <h4>${escapedGpuName} <small>(GPU ${gpu.id}, ${Math.ceil(gpu.memory_total_mib / 1024)}GB)</small></h4>
                    <div class="overview-gpu-metric-row" title="GPU Utilization: ${util}%">
                        <span class="gpu-metric-label">Util</span>
                        <div class="overview-progress-bar-container"><div class="overview-progress-bar gpu-util-bar" style="width:${util}%"></div></div>
                        <span class="gpu-metric-value">${util.toFixed(0)}%</span>
                    </div>
                    <div class="overview-gpu-metric-row" title="Memory Usage: ${mem}%">
                        <span class="gpu-metric-label">Mem</span>
                        <div class="overview-progress-bar-container"><div class="overview-progress-bar gpu-mem-bar" style="width:${mem}%"></div></div>
                        <span class="gpu-metric-value">${mem.toFixed(0)}%</span>
                    </div>
                    ${usersHtml}
                `;
                gpuContainer.appendChild(el);

                // Apply color classes to GPU bars
                const utilBar = el.querySelector('.gpu-util-bar');
                const memBar = el.querySelector('.gpu-mem-bar');
                if (utilBar) {
                    const utilClass = this._getUsageClass(util);
                    if (utilClass) utilBar.classList.add(utilClass);
                }
                if (memBar) {
                    const memClass = this._getUsageClass(mem);
                    if (memClass) memBar.classList.add(memClass);
                }
            });
        } else if (isError) {
            gpuContainer.innerHTML = `<div class="error-message">${this._escapeHtml(data.error || system.error)}</div>`;
        }

        // Update CPU Load Metrics
        // We will update the values here assuming element exists.

        const loadValEl = card.querySelector('.load-val-overview');
        const loadMaxEl = card.querySelector('.load-metric .load-max-text');
        const loadBar = card.querySelector('.load-metric .load-bar');

        if (loadValEl) {
            const l1 = system.load_average_1m;
            const l5 = system.load_average_5m;
            const l15 = system.load_average_15m;

            // Format: 1.05 / 0.80 / 0.60
            loadValEl.textContent = `${l1 !== undefined ? l1.toFixed(2) : '-'} / ${l5 !== undefined ? l5.toFixed(2) : '-'} / ${l15 !== undefined ? l15.toFixed(2) : '-'}`;

            const threads = system.load_max || system.cpu_count || system.logical_cpu_count;
            if (threads) {
                if (loadMaxEl) {
                    loadMaxEl.style.display = 'inline';
                    loadMaxEl.textContent = ` (${threads} threads)`;
                }

                // Calc % based on 1m load
                if (loadBar && l1 !== undefined) {
                    const rawPct = (l1 / threads) * 100;
                    const displayPct = Math.min(100, rawPct); // Cap display width at 100%
                    loadBar.style.width = `${displayPct}%`;
                    loadBar.className = 'overview-progress-bar load-bar'; // reset

                    // Add overload class if exceeding 100%
                    if (rawPct > 100) {
                        loadBar.classList.add('overload');
                    } else {
                        const usageClass = this._getUsageClass(rawPct);
                        if (usageClass) loadBar.classList.add(usageClass);
                    }
                }
            } else {
                if (loadMaxEl) loadMaxEl.style.display = 'none';
                if (loadBar) loadBar.style.width = '0%';
            }
        }

        // Update Load Bar if present

        // Disks logic...

        // Disks
        const diskContainer = card.querySelector('.overview-disk-list');
        if (diskContainer) {
            if (system.disks && system.disks.length > 0) {
                diskContainer.style.display = 'flex';
                // Reuse the same helper but with different view type

                diskContainer.innerHTML = '';
                system.disks.forEach(disk => {
                    const dEl = document.createElement('div');
                    dEl.className = 'disk-item';
                    dEl.innerHTML = `
                        <div class="disk-item-header">
                            <span class="disk-label" title="${disk.path}">${disk.label}</span>
                            <span class="disk-percent">${disk.percent_used.toFixed(0)}%</span>
                        </div>
                        <div class="overview-progress-bar-container">
                            <div class="overview-progress-bar ${this._getUsageClass(disk.percent_used)}" style="width:${disk.percent_used}%"></div>
                        </div>
                        <div class="disk-usage-details">${disk.used_gb.toFixed(1)} / ${disk.total_gb.toFixed(1)} GB</div>
                    `;
                    diskContainer.appendChild(dEl);
                });
            } else {
                diskContainer.style.display = 'none';
            }
        }

        // Timestamp
        const ts = card.querySelector('.timestamp');
        if (ts) ts.textContent = data.fetch_time_utc ? new Date(data.fetch_time_utc).toLocaleTimeString() : 'Error';
    }

    // --- Detailed View ---

    _createDetailedCard(host) {
        const div = document.createElement('div');
        div.className = 'host-card';
        div.id = `host-${this._sanitizeId(host.name)}`;
        const hostname = this._extractHostname(host.api_url);
        const escapedName = this._escapeHtml(host.name);
        const escapedHostname = this._escapeHtml(hostname);
        const escapedUrl = this._escapeHtml(host.api_url || '#');

        div.innerHTML = `
            <h2>
                <span>${escapedName} <span class="status-dot"></span></span>
                <a href="${escapedUrl}" target="_blank" class="hostname-link">${escapedHostname}</a>
            </h2>
            
            <div class="metrics-grid">
                <div class="metric-item">
                    <strong>CPU Usage</strong>
                    <div class="metric-value cpu-val">--</div>
                    <div class="progress-bar-container"><div class="progress-bar cpu-bar"></div></div>
                </div>
                <div class="metric-item">
                    <strong>Memory</strong>
                    <div class="metric-value ram-val">--</div>
                    <div class="progress-bar-container"><div class="progress-bar ram-bar"></div></div>
                    <small class="ram-detail" style="color:var(--text-secondary)">-- / -- GB</small>
                </div>
                <div class="metric-item">
                     <strong>Load Avg (1/5/15)</strong>
                     <div class="metric-value load-val" style="font-family:var(--font-mono); font-size:1rem;">-- / -- / --</div>
                     <div class="progress-bar-container"><div class="progress-bar load-bar"></div></div>
                </div>
            </div>

            <div class="section-title">GPU Status</div>
            <div class="gpus-container"></div>
            
            <div class="section-title">Disk Usage</div>
            <div class="disk-container metrics-grid"></div>

            <div class="timestamp">Last data: --</div>
        `;
        return div;
    }

    _updateDetailedCard(data) {
        const id = `host-${this._sanitizeId(data.name)}`;
        const card = document.getElementById(id);
        if (!card) return;

        const system = data.system || {};
        const isError = !!data.error || !!system.error;

        // Dot
        card.querySelector('.status-dot').className = `status-dot ${isError ? 'error' : 'ok'}`;

        // CPU/RAM
        this._updateMetric(card, '.cpu-val', '.cpu-bar', system.cpu_percent, '%', isError);
        this._updateMetric(card, '.ram-val', '.ram-bar', system.memory_percent, '%', isError);

        if (!isError) {
            const used = system.memory_used_gb?.toFixed(1) || '-';
            const total = system.memory_total_gb?.toFixed(1) || '-';
            card.querySelector('.ram-detail').textContent = `${used} / ${total} GB`;

            const l1 = system.load_average_1m ?? '-';
            const l5 = system.load_average_5m ?? '-';
            const l15 = system.load_average_15m ?? '-';
            card.querySelector('.load-val').textContent = `${l1} / ${l5} / ${l15}`;

            // Update Load Bar
            const loadBar = card.querySelector('.load-bar');
            if (loadBar && system.load_average_1m !== undefined) {
                const threads = system.load_max || system.cpu_count || system.logical_cpu_count;
                if (threads) {
                    const rawPct = (system.load_average_1m / threads) * 100;
                    const displayPct = Math.min(100, rawPct);
                    loadBar.style.width = `${displayPct}%`;

                    // Reset classes
                    loadBar.className = 'progress-bar load-bar';

                    if (rawPct > 100) {
                        loadBar.classList.add('overload');
                    } else {
                        const usageClass = this._getUsageClass(rawPct);
                        if (usageClass) loadBar.classList.add(usageClass);
                    }
                } else {
                    loadBar.style.width = '0%';
                }
            }
        }

        // GPUs
        const gpuContainer = card.querySelector('.gpus-container');
        gpuContainer.innerHTML = '';

        if (data.gpus && !data.error) {
            data.gpus.forEach(gpu => {
                if (gpu.error) {
                    gpuContainer.innerHTML += `<div class="gpu-card"><p class="error-text">${gpu.error}</p></div>`;
                    return;
                }

                const processRows = (gpu.processes || []).map(p => {
                    const escapedUsername = this._escapeHtml(p.username);
                    const escapedCommand = this._escapeHtml(p.command);
                    const truncatedCmd = this._escapeHtml(p.command?.substring(0, 40));
                    return `
                    <tr>
                        <td>${p.pid}</td>
                        <td>${escapedUsername}</td>
                        <td>${p.gpu_memory_used_mib?.toFixed(0)} MiB</td>
                        <td>${p.cpu_percent?.toFixed(1)}%</td>
                        <td class="command" title="${escapedCommand}">${truncatedCmd}...</td>
                    </tr>
                `}).join('');

                const el = document.createElement('div');
                el.className = 'gpu-card';
                const escapedGpuName = this._escapeHtml(this._cleanGpuName(gpu.name));
                el.innerHTML = `
                    <h4>
                        ${escapedGpuName} (ID: ${gpu.id})
                        <span style="font-size:0.8em; font-weight:400; color:var(--text-secondary)">
                            ${gpu.temperature_celsius}°C | Fan: ${gpu.fan_speed_percent}% | Power: ${gpu.power_usage_watts}/${gpu.power_limit_watts}W
                        </span>
                    </h4>
                    <div class="metrics-grid" style="grid-template-columns: 1fr 1fr; gap:0.5rem; margin-bottom:1rem;">
                         <div class="gpu-metric-row">
                            <span class="gpu-metric-label">Util: ${gpu.utilization_gpu_percent}%</span>
                            <div class="progress-bar-container"><div class="progress-bar" style="width:${gpu.utilization_gpu_percent}%"></div></div>
                        </div>
                        <div class="gpu-metric-row">
                            <span class="gpu-metric-label">Mem: ${gpu.memory_used_mib?.toFixed(0)} / ${gpu.memory_total_mib?.toFixed(0)} MiB</span>
                            <div class="progress-bar-container"><div class="progress-bar" style="width:${gpu.memory_percent}%"></div></div>
                        </div>
                    </div>
                    <table class="processes-table">
                        <thead><tr><th>PID</th><th>User</th><th>Mem</th><th>CPU</th><th>Command</th></tr></thead>
                        <tbody>${processRows || '<tr><td colspan="5">No processes</td></tr>'}</tbody>
                    </table>
                `;
                gpuContainer.appendChild(el);
            });
        }

        // Disks
        const diskContainer = card.querySelector('.disk-container');
        diskContainer.innerHTML = '';
        if (system.disks) {
            system.disks.forEach(disk => {
                const dEl = document.createElement('div');
                dEl.className = 'metric-item';
                dEl.innerHTML = `
                    <strong>${disk.label}</strong>
                    <small>${disk.used_gb} / ${disk.total_gb} GB</small>
                    <div class="progress-bar-container">
                        <div class="progress-bar ${this._getUsageClass(disk.percent_used)}" style="width:${disk.percent_used}%"></div>
                    </div>
                `;
                diskContainer.appendChild(dEl);
            });
        }

        // Timestamp
        const ts = card.querySelector('.timestamp');
        if (ts) ts.textContent = `Last data: ${data.fetch_time_utc ? new Date(data.fetch_time_utc).toLocaleTimeString() : 'Error'}`;
    }


    // --- Docker View ---

    _createDockerCard(host) {
        const div = document.createElement('div');
        div.className = 'host-card docker-host-card';
        div.id = `host-${this._sanitizeId(host.name)}`;
        const hostname = this._extractHostname(host.api_url);
        const escapedName = this._escapeHtml(host.name);
        const escapedHostname = this._escapeHtml(hostname);
        const escapedUrl = this._escapeHtml(host.api_url || '#');

        div.innerHTML = `
            <h2>
                <span>${escapedName} <span class="status-dot"></span></span>
                <a href="${escapedUrl}" target="_blank" class="hostname-link">${escapedHostname}</a>
            </h2>
            
            <div class="docker-summary-grid">
                <div class="metric-item">
                    <strong>Containers</strong>
                    <div class="metric-value containers-count">--</div>
                    <small style="color:var(--text-secondary)">Running / Total</small>
                </div>
                <div class="metric-item">
                    <strong>Images</strong>
                    <div class="metric-value images-count">--</div>
                    <small style="color:var(--text-secondary)">Total Size: <span class="images-size">--</span></small>
                </div>
                <div class="metric-item">
                    <strong>Build Cache</strong>
                    <div class="metric-value build-cache-size">--</div>
                </div>
                <div class="metric-item">
                    <strong>Local Volumes</strong>
                    <div class="metric-value volumes-count">--</div>
                    <small style="color:var(--text-secondary)">Total Size: <span class="volumes-size">--</span></small>
                </div>
            </div>

            <div class="docker-details-section">
                <details>
                    <summary>Containers (<span class="containers-total-badge">0</span>)</summary>
                    <table class="docker-table containers-table">
                        <thead>
                            <tr>
                                <th>ID</th>
                                <th>Image</th>
                                <th>Status</th>
                                <th>Names</th>
                                <th>Size</th>
                            </tr>
                        </thead>
                        <tbody><tr><td colspan="5">Loading...</td></tr></tbody>
                    </table>
                </details>

                <details>
                    <summary>Images (<span class="images-total-badge">0</span>)</summary>
                    <table class="docker-table images-table">
                        <thead>
                            <tr>
                                <th>Repository</th>
                                <th>Tag</th>
                                <th>ID</th>
                                <th>Size</th>
                            </tr>
                        </thead>
                        <tbody><tr><td colspan="4">Loading...</td></tr></tbody>
                    </table>
                </details>
            </div>

            <div class="timestamp">Last data: --</div>
        `;

        // Initialize Resizable Columns after a short delay to ensure DOM insertion
        setTimeout(() => {
            this._initResizableTables(div);
            this._initSortableTables(div);
        }, 100);
        return div;
    }

    _initSortableTables(container) {
        const tables = container.querySelectorAll('.docker-table');
        tables.forEach(table => {
            const headers = table.querySelectorAll('th');
            headers.forEach((th, index) => {
                th.addEventListener('click', () => {
                    // Toggle sort direction
                    const currentSort = th.getAttribute('data-sort');
                    const newSort = currentSort === 'asc' ? 'desc' : 'asc';

                    // Reset others
                    headers.forEach(h => h.removeAttribute('data-sort'));

                    // Set new sort
                    th.setAttribute('data-sort', newSort);

                    this._sortTable(table, index, newSort === 'asc');
                });
            });
        });
    }

    _sortTable(table, colIndex, asc) {
        const tbody = table.querySelector('tbody');
        const rows = Array.from(tbody.querySelectorAll('tr'));

        // Don't sort if valid data isn't loaded (e.g. Loading... or empty)
        if (rows.length === 0 || rows[0].cells.length <= 1) return;

        const isSizeColumn = table.rows[0].cells[colIndex].textContent.trim().toLowerCase().includes('size');

        rows.sort((rowA, rowB) => {
            const cellA = rowA.cells[colIndex].innerText.trim();
            const cellB = rowB.cells[colIndex].innerText.trim();

            if (isSizeColumn) {
                const sizeA = this._parseSize(cellA);
                const sizeB = this._parseSize(cellB);
                return asc ? sizeA - sizeB : sizeB - sizeA;
            } else {
                return asc ? cellA.localeCompare(cellB) : cellB.localeCompare(cellA);
            }
        });

        // Re-append rows in new order
        rows.forEach(row => tbody.appendChild(row));
    }

    _parseSize(sizeStr) {
        if (!sizeStr || sizeStr === '--') return 0;
        const units = { 'B': 1, 'KB': 1024, 'MB': 1024 ** 2, 'GB': 1024 ** 3, 'TB': 1024 ** 4 };
        const match = sizeStr.match(/([\d.]+)\s*([A-Za-z]+)/);
        if (match) {
            const val = parseFloat(match[1]);
            const unit = match[2].toUpperCase();
            return val * (units[unit] || 1);
        }
        return 0;
    }

    _initResizableTables(container) {
        const tables = container.querySelectorAll('.docker-table');
        tables.forEach(table => {
            const cols = table.querySelectorAll('th');
            cols.forEach(col => {
                // Prevent double initialization
                if (col.querySelector('.resizer')) return;

                const resizer = document.createElement('div');
                resizer.classList.add('resizer');
                resizer.style.height = `${table.offsetHeight}px`;
                col.appendChild(resizer);

                this._createResizableColumn(col, resizer);
            });
        });
    }

    _createResizableColumn(col, resizer) {
        let x = 0;
        let w = 0;
        let nextCol = null;
        let nextW = 0;

        const mouseDownHandler = (e) => {
            // Only left mouse button
            if (e.button !== 0) return;

            // Should adjust the two columns that the resizer divides
            nextCol = col.nextElementSibling;
            if (!nextCol) return; // Cannot resize if no neighbor

            x = e.clientX;

            const styles = window.getComputedStyle(col);
            const nextStyles = window.getComputedStyle(nextCol);

            w = parseFloat(styles.width);
            nextW = parseFloat(nextStyles.width);

            document.addEventListener('mousemove', mouseMoveHandler);
            document.addEventListener('mouseup', mouseUpHandler);
            resizer.classList.add('resizing');
            e.preventDefault(); // Prevent text selection
        };

        const mouseMoveHandler = (e) => {
            const dx = e.clientX - x;

            // Limit checks could be added here (e.g. min-width)
            if (w + dx > 30 && nextW - dx > 30) {
                col.style.width = `${w + dx}px`;
                nextCol.style.width = `${nextW - dx}px`;
            }
        };

        const mouseUpHandler = () => {
            document.removeEventListener('mousemove', mouseMoveHandler);
            document.removeEventListener('mouseup', mouseUpHandler);
            resizer.classList.remove('resizing');
        };

        resizer.addEventListener('mousedown', mouseDownHandler);
        // Prevent click propagation to sorting if we implemented it
        resizer.addEventListener('click', (e) => e.stopPropagation());
    }

    _updateDockerCard(data) {
        const id = `host-${this._sanitizeId(data.name)}`;
        const card = document.getElementById(id);
        if (!card) return;

        const docker = data.docker || {};
        const isError = !!data.error || !!docker.error;

        // Dot
        card.querySelector('.status-dot').className = `status-dot ${isError ? 'error' : 'ok'}`;
        if (isError) {
            const ts = card.querySelector('.timestamp');
            if (ts) ts.textContent = `Error: ${data.error || docker.error}`;
            return;
        }

        const summary = docker.summary || {};
        const containers = docker.containers || [];
        const images = docker.images || [];

        // Summary metrics
        const containersData = summary["Containers"] || { TotalCount: 0, Running: 0, Size: "0B" };
        const imagesData = summary["Images"] || { TotalCount: 0, Size: "0B" };
        const buildCacheData = summary["Build Cache"] || { Size: "0B" };
        const volumesData = summary["Local Volumes"] || { TotalCount: 0, Size: "0B" };

        card.querySelector('.containers-count').textContent = `${containersData.Running || 0} / ${containersData.TotalCount || 0}`;
        card.querySelector('.images-count').textContent = imagesData.TotalCount || 0;
        card.querySelector('.images-size').textContent = imagesData.Size || "0B";
        card.querySelector('.build-cache-size').textContent = buildCacheData.Size || "0B";
        card.querySelector('.volumes-count').textContent = volumesData.TotalCount || 0;
        card.querySelector('.volumes-size').textContent = volumesData.Size || "0B";

        // Update Badges
        card.querySelector('.containers-total-badge').textContent = containers.length;
        card.querySelector('.images-total-badge').textContent = images.length;

        // Containers Table
        const containersBody = card.querySelector('.containers-table tbody');
        if (containersBody) {
            if (containers.length === 0) {
                containersBody.innerHTML = '<tr><td colspan="5">No containers found.</td></tr>';
            } else {
                containersBody.innerHTML = containers.map(c => {
                    let statusClass = '';
                    const s = (c.Status || '').toLowerCase();
                    if (s.startsWith('up')) statusClass = 'status-text-success';
                    else if (s.includes('exit')) statusClass = 'status-text-error';
                    else if (s.includes('pause')) statusClass = 'status-text-warning';

                    // Error Detection for Names
                    let rowClass = "";
                    let namesHtml = this._escapeHtml(c.Names);

                    if (this.state.systemUsers.length > 0) {
                        const names = c.Names || "";
                        const namesStr = Array.isArray(names) ? names.join(',') : String(names);

                        const validation = this._validateAndHighlight(namesStr);
                        namesHtml = validation.html;

                        if (validation.isError) {
                            rowClass = "error-row";
                        }
                    } else {
                        namesHtml = this._escapeHtml(c.Names);
                    }

                    return `
                    <tr class="${rowClass}">
                        <td title="${c.ID}">${c.ID.substring(0, 12)}</td>
                        <td title="${c.Image}">${c.Image.substring(0, 30)}</td>
                        <td class="${statusClass}" title="${c.Status}">${c.Status}</td>
                        <td title="${c.Names}">${namesHtml}</td>
                        <td title="${c.Size}">${c.Size}</td>
                    </tr>
                `}).join('');
            }
        }

        // Images Table
        const imagesBody = card.querySelector('.images-table tbody');
        if (imagesBody) {
            if (images.length === 0) {
                imagesBody.innerHTML = '<tr><td colspan="4">No images found.</td></tr>';
            } else {
                imagesBody.innerHTML = images.map(i => {
                    // Error Detection for Images
                    let rowClass = "";
                    let repoHtml = this._escapeHtml(i.Repository);
                    let tagHtml = this._escapeHtml(i.Tag);

                    if (this.state.systemUsers.length > 0) {
                        // Check Repository
                        const repoVal = this._validateAndHighlight(i.Repository);
                        // Check Tag
                        const tagVal = this._validateAndHighlight(i.Tag);

                        // If EITHER is valid (has user or ignore keyword), then the row is NOT an error.
                        // But wait, the requirement is "if they don't contain any of the usernames... do a red outline".
                        // So if Repository has user OR Tag has user, it's valid.
                        // If NEITHER has user, it's error.
                        // However, _validateAndHighlight returns isError=true if no match.

                        const repoValid = !repoVal.isError;
                        const tagValid = !tagVal.isError;

                        repoHtml = repoVal.html;
                        tagHtml = tagVal.html;

                        // We highlight matches in individual columns.
                        // The row is error only if BOTH are invalid (i.e. neither contained a user/ignore word).
                        // Actually, usually the user is in the Repo OR the Tag. One match is sufficient to validate the image ownership.

                        if (!repoValid && !tagValid) {
                            rowClass = "error-row";
                        }
                    }

                    return `
                    <tr class="${rowClass}">
                        <td title="${i.Repository}">${repoHtml}</td>
                        <td title="${i.Tag}">${tagHtml}</td>
                        <td title="${i.ID}">${i.ID.substring(7, 19)}</td>
                        <td title="${i.Size}">${i.Size}</td>
                    </tr>
                `}).join('');
            }
        }

        // Timestamp
        const ts = card.querySelector('.timestamp');
        if (ts) ts.textContent = `Last data: ${data.fetch_time_utc ? new Date(data.fetch_time_utc).toLocaleTimeString() : 'Error'}`;
    }


    // --- Helpers ---

    _updateMetric(card, valSelector, barSelector, value, unit = '', isError = false) {
        const valEl = card.querySelector(valSelector);
        const barEl = card.querySelector(barSelector);

        if (isError || value == null) {
            if (valEl) valEl.textContent = 'ERR';
            if (barEl) barEl.style.width = '0%';
            return;
        }

        if (valEl) valEl.textContent = `${typeof value === 'number' ? value.toFixed(1) : value}${unit}`;

        if (barEl) {
            const pct = Math.min(100, Math.max(0, parseFloat(value) || 0));
            barEl.style.width = `${pct}%`;
            barEl.className = barEl.className.replace(/high-usage|critical-usage/g, '').trim();
            const usageClass = this._getUsageClass(pct);
            if (usageClass) {
                barEl.classList.add(usageClass);
            }
        }
    }

    _getUsageClass(pct) {
        if (pct > this.config.usageThresholds.critical) return 'critical-usage';
        if (pct > this.config.usageThresholds.high) return 'high-usage';
        return '';
    }

    _sanitizeId(name) {
        return name.replace(/[^a-zA-Z0-9]/g, '-');
    }

    _extractHostname(url) {
        try {
            return new URL(url).hostname;
        } catch {
            return 'N/A';
        }
    }

    _cleanGpuName(name) {
        if (!name) return 'Unknown GPU';
        return name.replace(/\b(NVIDIA|Nvidia|GeForce|RTX|Generation)\b/gi, '').replace(/\s+/g, ' ').trim();
    }

    _getGPUUsers(gpu) {
        if (!gpu || !gpu.processes || !gpu.processes.length) return [];
        const users = [];
        const seen = new Set();

        gpu.processes.forEach(p => {
            if (p.username && p.username !== 'N/A') {
                // Create a unique key for username to avoid duplicates
                const key = p.username;
                if (!seen.has(key)) {
                    seen.add(key);
                    users.push({
                        username: p.username,
                        commands: [p.command]
                    });
                } else {
                    // Add command to existing user entry if different?
                    const existing = users.find(u => u.username === p.username);
                    if (existing && !existing.commands.includes(p.command)) {
                        existing.commands.push(p.command);
                    }
                }
            }
        });
        return users;
    }

    _validateAndHighlight(text) {
        if (!text) return { html: '', isError: true };

        const IGNORED_KEYWORDS = ['netdata', 'portainer', 'docker-socket', 'grafana', 'prometheus'];

        // Check ignore list
        for (const keyword of IGNORED_KEYWORDS) {
            if (text.includes(keyword)) {
                return { html: this._escapeHtml(text), isError: false };
            }
        }

        // Check system users
        if (this.state.systemUsers && this.state.systemUsers.length > 0) {
            for (const user of this.state.systemUsers) {
                if (text.includes(user)) {
                    const escapedText = this._escapeHtml(text);
                    const escapedUser = this._escapeHtml(user);
                    // Replace the first occurrence or all? Usually names are simple.
                    // We need to be careful with HTML injection. 
                    // Since we escaped the whole text, we can try to insert the span.
                    // But simpler is to split by the user string.

                    const parts = escapedText.split(escapedUser);
                    // Join with the highlighted span
                    const highlightedHtml = parts.join(`<span class="user-match">${escapedUser}</span>`);
                    return { html: highlightedHtml, isError: false };
                }
            }
            // If we have users but no match found
            return { html: this._escapeHtml(text), isError: true };
        }

        // If user list is empty, default to no error (or whatever previous logic was)
        // Previous logic: "if systemUsers is empty, skip error detection" -> isError = false
        return { html: this._escapeHtml(text), isError: false };
    }

    showError(msg) {
        this.els.container.innerHTML = `<p style="color:var(--error-color); text-align:center; padding:2rem;">${msg}</p>`;
    }

    showToast(msg) {
        console.log(`Toast: ${msg}`);
    }
}

// Global instance
const app = new DashboardApp();

// Exposed entry point for HTML
window.initializeDashboard = (hosts, view) => app.init(hosts, view);