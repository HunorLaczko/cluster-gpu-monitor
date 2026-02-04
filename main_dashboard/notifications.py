import asyncio
import logging
import queue
import threading
import time
from typing import Dict, List, Optional, Callable, Any
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

def utc_now_timestamp():
    return time.time()

class NotificationManager:
    _instance = None
    
    def __new__(cls):
        if cls._instance is None:
            cls._instance = super(NotificationManager, cls).__new__(cls)
            cls._instance.init()
        return cls._instance

    def init(self):
        # Maps user_id -> List[queue.Queue]
        # A user might have multiple tabs open, so we support multiple queues per user.
        # However, typically SSE works one connection per client.
        # But if the same user opens 2 tabs, we want both to get the notif.
        self._subscribers: Dict[str, List[queue.Queue]] = {}
        self._lock = threading.Lock()

    def subscribe(self, user_id: str) -> queue.Queue:
        """
        Subscribe a user to notifications. Returns a queue that will receive messages.
        """
        logger.info(f"User subscribed to notifications: {user_id}")
        q = queue.Queue()
        with self._lock:
            if user_id not in self._subscribers:
                self._subscribers[user_id] = []
            self._subscribers[user_id].append(q)
        return q

    def unsubscribe(self, user_id: str, q: queue.Queue):
        with self._lock:
            if user_id in self._subscribers:
                if q in self._subscribers[user_id]:
                    self._subscribers[user_id].remove(q)
                if not self._subscribers[user_id]:
                    del self._subscribers[user_id]
        logger.info(f"User unsubscribed from notifications: {user_id}")

    def send_to_user(self, user_id: str, title: str, body: str, level: str = "info"):
        """
        Send a notification to a specific user.
        """
        message = {
            "title": title,
            "body": body,
            "level": level,
            "timestamp": utc_now_timestamp()
        }
        count = 0
        with self._lock:
            queues = self._subscribers.get(user_id, [])
            for q in queues:
                q.put(message)
                count += 1
        if count > 0:
            logger.info(f"Sent notification to user {user_id} (active tabs: {count}): {title}")
        else:
            logger.debug(f"User {user_id} is not connected, dropped notification: {title}")

    def broadcast(self, title: str, body: str, level: str = "info"):
        """
        Send a notification to all connected users.
        """
        message = {
            "title": title,
            "body": body,
            "level": level,
            "timestamp": utc_now_timestamp()
        }
        with self._lock:
            for user_queues in self._subscribers.values():
                for q in user_queues:
                    q.put(message)
        logger.info(f"Broadcasted notification: {title}")

    async def send_to_server_users(self, server_url: str, title: str, body: str, level: str = "info", user_list: List[str] = None):
        """
        Send notification to users logged into the server.
        
        Args:
            server_url: The server URL (for logging purposes)
            title: Notification title
            body: Notification body text
            level: Notification level (info, warning, critical)
            user_list: List of usernames to notify. Should be extracted from system.users in metrics.
        """
        if not user_list:
            logger.debug(f"No user_list provided for {server_url}, skipping notification")
            return 0
            
        target_usernames = set(user_list)
        logger.info(f"Sending notification '{title}' to server {server_url} users: {target_usernames}")
        
        count_sent = 0
        for username in target_usernames:
            # Send to user if they're subscribed (connected to dashboard)
            # If not connected, send_to_user will log a debug message
            self.send_to_user(username, title, body, level)
            count_sent += 1
            
        return count_sent


class AlertManager:
    _instance = None

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super(AlertManager, cls).__new__(cls)
            cls._instance.init()
        return cls._instance

    def init(self):
        self.checks = []
        # Track currently active alerts (edge-triggered)
        self.active_alerts: set = set()
        # Track alerts reported in current cycle
        self.current_cycle_alerts: set = set()
        self._lock = threading.Lock()

    def register_check(self, check_func: Callable[[Any], None]):
        self.checks.append(check_func)

    async def process_data(self, hosts_data: List[Dict[str, Any]]):
        """
        Run all registered checks against the latest data.
        This should be called whenever data is refreshed.
        """
        # Reset current cycle
        with self._lock:
            self.current_cycle_alerts.clear()
        
        # Run all checks (they will call report_alert)
        for check in self.checks:
            try:
                if asyncio.iscoroutinefunction(check):
                    await check(hosts_data)
                else:
                    check(hosts_data)
            except Exception as e:
                logger.error(f"Error running alert check: {e}", exc_info=True)
        
        # Update active alerts to match current cycle
        with self._lock:
            self.active_alerts = self.current_cycle_alerts.copy()

    async def report_alert(self, alert_key: str, notification_callback):
        """
        Report an alert condition. If this is a new alert (edge-triggered),
        execute the notification callback.
        
        Args:
            alert_key: Unique identifier for this alert condition
            notification_callback: Async function to call if this is a new alert
        """
        with self._lock:
            # Add to current cycle
            self.current_cycle_alerts.add(alert_key)
            
            # Check if this is a new alert
            is_new = alert_key not in self.active_alerts
        
        if is_new:
            logger.info(f"New alert detected: {alert_key}")
            await notification_callback()


# --- Built-in Checks ---

async def disk_usage_check(hosts_data: List[Dict[str, Any]]):
    """
    Check for critical disk usage using 'disks' list from system metrics.
    """
    nm = NotificationManager()
    am = AlertManager()
    
    # Threshold could be config driven
    DISK_THRESHOLD = 90.0
    
    for host in hosts_data:
        system = host.get("system", {})
        disks = system.get("disks", [])
        
        # Parse disks list
        if isinstance(disks, list):
            for disk in disks:
                if not isinstance(disk, dict):
                    continue
                    
                path = disk.get("path")
                percent = disk.get("percent_used")
                
                if path and percent is not None:
                    try:
                        percent_val = float(percent)
                        if percent_val > DISK_THRESHOLD:
                            server_name = host.get("name", "Unknown Server")
                            alert_key = f"disk_usage:{server_name}:{path}"
                            
                            # Define notification callback
                            async def send_notification():
                                msg = f"Disk usage on {server_name} ({path}) is critical: {percent_val}%"
                                logger.warning(f"ALERT: {msg}")
                                
                                # Get logged in users from system metrics
                                current_users = [u.get("name") for u in system.get("users", []) if u.get("name")]
                                
                                url = host.get("url")
                                if url:
                                    await nm.send_to_server_users(
                                        server_url=url, 
                                        title=f"Critical Disk Usage on {server_name}", 
                                        body=msg, 
                                        level="critical",
                                        user_list=current_users
                                    )
                            
                            # Report alert (will only notify if new)
                            await am.report_alert(alert_key, send_notification)
                    except (ValueError, TypeError):
                        pass

async def root_process_check(hosts_data: List[Dict[str, Any]]):
    """
    Check for GPU processes running as root.
    """
    nm = NotificationManager()
    am = AlertManager()
    
    for host in hosts_data:
        server_name = host.get("name", "Unknown Server")
        gpus = host.get("gpus", [])
        
        # Collect offending PIDs to avoid duplicate alerts per host in one cycle
        root_procs = []
        
        if isinstance(gpus, list):
            for gpu in gpus:
                if not isinstance(gpu, dict): continue
                
                procs = gpu.get("processes", [])
                if isinstance(procs, list):
                    for p in procs:
                        # Check username. Exporter usually returns "root" or similar.
                        user = p.get("username", "")
                        if user == "root":
                            root_procs.append(f"{p.get('command', 'unknown')} (PID {p.get('pid')})")

        if root_procs:
            # Found root processes
            alert_key = f"root_process:{server_name}"
            
            # Define notification callback
            async def send_notification():
                msg = f"Root user detected on GPU processes: {', '.join(root_procs[:3])}"
                if len(root_procs) > 3:
                    msg += f" and {len(root_procs)-3} others..."
                msg += ". Please relaunch with your own user!"
                
                logger.warning(f"ALERT: {msg}")
                
                system = host.get("system", {})
                current_users = [u.get("name") for u in system.get("users", []) if u.get("name")]
                
                url = host.get("url")
                if url:
                    await nm.send_to_server_users(
                        server_url=url, 
                        title=f"Root Process Detected on {server_name}", 
                        body=msg, 
                        level="warning",
                        user_list=current_users
                    )
            
            # Report alert (will only notify if new)
            await am.report_alert(alert_key, send_notification)
