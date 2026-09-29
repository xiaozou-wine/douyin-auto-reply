"""
只读验证：用给定 sessionid 调用抖音图片上传授权接口，判断 sessionid 是否有效。
不发送任何消息，只做 GET 授权探测。sessionid 从环境变量 NEW_SESSIONID 读取，不写入文件、不回显。
用法：NEW_SESSIONID=xxx python3 verify_sessionid.py
"""
import os
import json
import urllib.parse
import urllib.request

USER_ID = os.getenv("DOUYIN_USER_ID", "").strip()


def load_env(path=".env"):
    env = {}
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if "=" in line and not line.startswith("#"):
                k, v = line.split("=", 1)
                env[k] = v
    return env


def parse_cookie_fields(cookies_str):
    cd = {}
    for item in cookies_str.split("; "):
        if "=" in item:
            k, v = item.split("=", 1)
            cd[k] = v
    return cd


def main():
    if not USER_ID:
        print("ERROR: DOUYIN_USER_ID not set in environment")
        return

    new_sessionid = os.environ.get("NEW_SESSIONID", "").strip()
    if not new_sessionid:
        print("ERROR: NEW_SESSIONID not set")
        return

    env = load_env()
    cd = parse_cookie_fields(env.get(f"COOKIES_{USER_ID}", ""))
    ms_token = cd.get("ms_token", "")
    fp = cd.get("s_v_web_id", "")
    uifid = cd.get("UIFID", "")

    params = {
        "device_platform": "webapp",
        "aid": "6383",
        "msToken": ms_token,
        "verifyFp": fp,
        "fp": fp,
    }
    base = "https://www.douyin.com/aweme/v1/web/im/upload/config/v2"
    url = base + "?" + urllib.parse.urlencode(params)

    req = urllib.request.Request(url, method="GET")
    req.add_header("accept", "application/json, text/plain, */*")
    req.add_header("Cookie", f"sessionid={new_sessionid}; sessionid_ss={new_sessionid}")
    req.add_header("referer", "https://www.douyin.com/jingxuan")
    req.add_header("uifid", uifid)
    req.add_header(
        "user-agent",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36",
    )

    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            code = resp.status
            body = resp.read().decode("utf-8", errors="replace")
        j = json.loads(body)
        sc = j.get("status_code", None)
        sm = j.get("status_msg", "")
        cfg = j.get("public_image_config", {}) or {}
        # 成功响应带 public_image_config，其中含临时 access key
        has_ak = bool(cfg.get("access_key_id"))
        has_token = bool(cfg.get("session_token"))
        space = cfg.get("space_name", "")
        print(f"HTTP={code} status_code={sc} status_msg={sm!r}")
        print(f"public_image_config: has_access_key={has_ak} has_session_token={has_token} space_name={space!r}")
        # 未登录时 status_code!=0 且不会给出 access key
        ok = (sc is None or sc == 0) and has_ak and has_token
        print("VERDICT:", "VALID" if ok else "INVALID")
    except Exception as e:
        print("ERROR:", type(e).__name__, str(e)[:200])


if __name__ == "__main__":
    main()
