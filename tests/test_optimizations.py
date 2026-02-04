import pytest
import asyncio
import time
import httpx
import main_dashboard.main_app as dashboard

@pytest.mark.asyncio
async def test_fetch_users_list_caching(monkeypatch):
    # Setup
    dashboard._users_cache = {"data": [], "expiry": 0}
    mock_users = [{"username": "user1"}, {"username": "user2"}]
    
    async def mock_fetch_from_host(client, host_conf):
        return mock_users

    monkeypatch.setattr(dashboard, "_fetch_users_from_host", mock_fetch_from_host)
    monkeypatch.setattr(dashboard, "MONITORED_HOSTS", [{"name": "host1", "api_url": "http://h1"}])
    
    # First call: should fetch and cache
    users1 = await dashboard.fetch_users_list()
    assert users1 == sorted(mock_users, key=lambda x: x["username"])
    assert dashboard._users_cache["data"] == users1
    assert dashboard._users_cache["expiry"] > time.time()
    
    # Modify mock to return something else
    async def mock_fetch_from_host_2(client, host_conf):
        return [{"username": "other"}]
    
    monkeypatch.setattr(dashboard, "_fetch_users_from_host", mock_fetch_from_host_2)
    
    # Second call: should return cached data
    users2 = await dashboard.fetch_users_list()
    assert users2 == users1
    assert users2 != [{"username": "other"}]

@pytest.mark.asyncio
async def test_fetch_users_list_parallel(monkeypatch):
    # Setup
    dashboard._users_cache = {"data": [], "expiry": 0}
    
    fetch_times = []
    
    async def mock_fetch_from_host(client, host_conf):
        fetch_times.append(time.time())
        await asyncio.sleep(0.5)
        return [{"username": host_conf["name"]}]

    monkeypatch.setattr(dashboard, "_fetch_users_from_host", mock_fetch_from_host)
    monkeypatch.setattr(dashboard, "MONITORED_HOSTS", [
        {"name": "host1", "api_url": "http://h1"},
        {"name": "host2", "api_url": "http://h2"},
        {"name": "host3", "api_url": "http://h3"}
    ])
    
    start = time.time()
    users = await dashboard.fetch_users_list()
    duration = time.time() - start
    
    # If parallel, should take ~0.5s, not ~1.5s
    assert duration < 1.0 
    assert len(fetch_times) == 3
    # Check that they were all started very close to each other
    assert max(fetch_times) - min(fetch_times) < 0.1
