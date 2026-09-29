import requests, os, json
from datetime import datetime, timezone, timedelta
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))

# 账号与目标标识符从 .env 读取，不硬编码。
USER_ID = os.getenv("DOUYIN_USER_ID", "").strip()
TARGET_ID = os.getenv("DOUYIN_TARGET_ID", "").strip()

sessionid = os.getenv(f"SESSIONID_{USER_ID}", "")
cookies_str = os.getenv(f"COOKIES_{USER_ID}", "")
cookies = {}
for item in cookies_str.split("; "):
    if "=" in item:
        k, v = item.split("=", 1)
        cookies[k] = v
cookies["sessionid"] = sessionid

headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Referer": "https://www.douyin.com/",
    "Origin": "https://www.douyin.com",
    "Accept": "application/json, text/plain, */*",
}

conv_short_id = TARGET_ID

tests = [
    ("GET", "https://imapi.douyin.com/v1/stranger/get_conversation_list", {"aid": 6383, "cursor": 0}),
    ("GET", "https://imapi.douyin.com/v1/message/list", {"conversation_short_id": conv_short_id, "cursor": 0, "limit": 20, "aid": 6383}),
    ("GET", "https://imapi.douyin.com/v1/message/list", {"conversation_short_id": conv_short_id, "cursor": 0, "limit": 5}),
    ("POST", "https://imapi.douyin.com/v1/message/list", {"conversation_short_id": conv_short_id, "cursor": "0", "limit": "20"}),
    ("GET", "https://imapi.douyin.com/v1/message/list", {"conversation_id": f"0:1:{USER_ID}:3087850399084047", "cursor": 0, "limit": 20}),
    ("GET", "https://creator.douyin.com/aweme/v1/im/message/list/", {"conversation_short_id": conv_short_id, "cursor": 0, "limit": 20}),
    ("GET", "https://www.douyin.com/aweme/v1/web/im/message/list/", {"conversation_short_id": conv_short_id, "cursor": 0, "limit": 20}),
]

for method, url, params in tests:
    try:
        if method == "GET":
            r = requests.get(url, params=params, cookies=cookies, headers=headers, timeout=10)
        else:
            r = requests.post(url, json=params, cookies=cookies, headers=headers, timeout=10)
        body_preview = r.text[:300].replace("\n", " ").replace("\r", "")
        name = url.split("/v1/")[-1] if "/v1/" in url else url.split("douyin.com")[-1]
        print(f"{method} .../{name[:60]}")
        print(f"  status={r.status_code}, len={len(r.text)}, body={body_preview}")
        print()
    except Exception as e:
        name = url.split("douyin.com")[-1] if "douyin.com" in url else url
        print(f"ERR: {name[:60]} -> {e}")
        print()
