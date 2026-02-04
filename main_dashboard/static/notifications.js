
class NotificationService {
    constructor() {
        this.eventSource = null;
        this.isConnected = false;
        this.retryTimeout = 1000;

        // Request permissions immediately on load (or usually on user interaction, but we want system alerts)
        // Best practice: request on a button click, but for an internal dashboard, we can try on load
        // or wait for the first user click.
        // We'll try on load, and if blocked, we might add a UI element.
        this.requestPermission();
    }

    requestPermission() {
        if (!("Notification" in window)) {
            console.log("This browser does not support desktop notification");
            return;
        }

        if (Notification.permission === "granted") {
            return;
        }

        if (Notification.permission !== "denied") {
            Notification.requestPermission().then((permission) => {
                if (permission === "granted") {
                    console.log("Notification permission granted");
                }
            });
        }
    }

    connect() {
        if (this.eventSource) {
            this.eventSource.close();
        }

        console.log("Connecting to notification stream...");
        this.eventSource = new EventSource('/api/notifications/stream');

        this.eventSource.addEventListener('connected', (e) => {
            console.log("Connected to notification service");
            this.isConnected = true;
            this.retryTimeout = 1000; // Reset backoff
        });

        this.eventSource.addEventListener('notification', (e) => {
            try {
                const data = JSON.parse(e.data);
                this.showNotification(data);
            } catch (err) {
                console.error("Error parsing notification data:", err);
            }
        });

        this.eventSource.onerror = (e) => {
            console.log("Notification stream error, reconnecting in " + this.retryTimeout + "ms");
            this.eventSource.close();
            this.isConnected = false;
            setTimeout(() => this.connect(), this.retryTimeout);
            this.retryTimeout = Math.min(this.retryTimeout * 2, 30000); // Max 30s backoff
        };
    }

    showNotification(msg) {
        if (Notification.permission !== "granted") {
            console.warn("Notification permission missing, cannot show:", msg);
            return;
        }

        const options = {
            body: msg.body,
            icon: '/static/favicon.ico', // Ensure this exists or use generic
            tag: msg.title, // Basic debounce by tag if needed
            timestamp: msg.timestamp * 1000
        };

        const notification = new Notification(msg.title, options);
        notification.onclick = () => {
            window.focus();
            notification.close();
        };
    }
}

// Store instance globally
const notificationService = new NotificationService();
document.addEventListener('DOMContentLoaded', () => {
    notificationService.connect();

    // Optional: add a global button handler if we want to manually request permissions
    // document.getElementById('enableNotifications')?.addEventListener('click', () => notificationService.requestPermission());
});
