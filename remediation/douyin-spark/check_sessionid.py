"""
只读 sessionid 健康检查 + 邮件告警。

由 cron 每天在 22:00 发送任务之前调用一次。只对抖音图片上传授权接口做
GET 探测，不发送任何消息，不修改任何状态。

判定规则（只有明确失效才告警，避免误报）：
  valid   -> 返回 access_key_id/session_token，静默退出
  invalid -> status_code=8 或 status_msg='用户未登录'，发邮件告警
  unknown -> 网络错误/非 JSON/未预期响应，只记日志，不发邮件

邮件配置从 .env 读取，键名 ALERT_EMAIL_*。
用法：.venv/bin/python3 check_sessionid.py [--test]
  --test  强制发送一封标记为测试的告警邮件，不写入状态文件
退出码：0=正常或不确定，1=已确认失效，2=配置缺失
"""
import json
import os
import smtplib
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from email.mime.text import MIMEText

from dotenv import load_dotenv

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
load_dotenv(os.path.join(BASE_DIR, ".env"))

USER_ID = os.getenv("DOUYIN_USER_ID", "").strip()
BEIJING_TZ = timezone(timedelta(hours=8))
STATE_FILE = os.path.join(BASE_DIR, ".session_check_state.json")
LOG_FILE = os.path.join(BASE_DIR, "logs", "session-check.log")

AUTH_URL = "https://www.douyin.com/aweme/v1/web/im/upload/config/v2"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36"
)


def log(message: str) -> None:
    """Append one timestamped line to the check log and stdout."""
    line = "%s - %s" % (datetime.now(BEIJING_TZ).strftime("%Y-%m-%d %H:%M:%S"), message)
    print(line, flush=True)
    try:
        os.makedirs(os.path.dirname(LOG_FILE), exist_ok=True)
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError as error:
        print("WARN: could not write log file: %s" % error, flush=True)


def parse_cookies(raw: str) -> dict:
    cookies = {}
    for item in raw.split(";"):
        if "=" in item:
            key, value = item.strip().split("=", 1)
            cookies[key] = value
    return cookies


def load_state() -> dict:
    try:
        with open(STATE_FILE, encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def save_state(state: dict) -> None:
    temp_path = STATE_FILE + ".tmp"
    with open(temp_path, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)
    os.replace(temp_path, STATE_FILE)


def probe(sessionid: str, cookies: dict) -> tuple:
    """Return (verdict, detail). Never raises."""
    params = {
        "device_platform": "webapp",
        "aid": "6383",
        "msToken": cookies.get("ms_token", ""),
        "verifyFp": cookies.get("s_v_web_id", ""),
        "fp": cookies.get("s_v_web_id", ""),
    }
    url = AUTH_URL + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, method="GET")
    req.add_header("accept", "application/json, text/plain, */*")
    req.add_header("Cookie", "sessionid=%s; sessionid_ss=%s" % (sessionid, sessionid))
    req.add_header("referer", "https://www.douyin.com/jingxuan")
    req.add_header("uifid", cookies.get("UIFID", ""))
    req.add_header("user-agent", USER_AGENT)

    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            body = resp.read().decode("utf-8", "replace")
    except Exception as error:  # noqa: BLE001 - any transport failure is "unknown"
        return "unknown", "request failed: %s: %s" % (type(error).__name__, str(error)[:150])

    try:
        payload = json.loads(body)
    except json.JSONDecodeError:
        return "unknown", "non-JSON response: %r" % body[:80]

    config = payload.get("public_image_config") or {}
    if config.get("access_key_id") and config.get("session_token"):
        return "valid", "status_code=%s space=%r" % (
            payload.get("status_code"), config.get("space_name"))

    status_code = payload.get("status_code")
    status_msg = payload.get("status_msg", "")
    if status_code == 8 or status_msg == "用户未登录":
        return "invalid", "status_code=%s status_msg=%r" % (status_code, status_msg)
    return "unknown", "unexpected response: status_code=%s status_msg=%r" % (
        status_code, status_msg)


def send_alert(today: str, streak: int, detail: str, is_test: bool = False) -> bool:
    """Email the operator. Returns True when handed to the SMTP server."""
    host = os.getenv("ALERT_EMAIL_SMTP", "").strip()
    port = os.getenv("ALERT_EMAIL_PORT", "465").strip()
    sender = os.getenv("ALERT_EMAIL_SENDER", "").strip()
    auth_code = os.getenv("ALERT_EMAIL_AUTH_CODE", "").strip()
    receiver = os.getenv("ALERT_EMAIL_RECEIVER", "").strip() or sender

    if not (host and sender and auth_code and receiver):
        log("ALERT NOT SENT: ALERT_EMAIL_* config incomplete in .env")
        return False

    prefix = "[测试] " if is_test else ""
    subject = "%s[续火告警] sessionid 已失效，今晚将无法发送 (%s)" % (prefix, today)
    streak_line = (
        "这是连续第 %d 天失效。" % streak if streak > 1 else "这是首次检测到失效。"
    )
    if is_test:
        streak_line = "这是一封测试邮件，用于验证告警通道；当前 sessionid 状态见下方探测结果。"
    body = """<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f5f5f5;">
<div style="max-width:600px;margin:20px auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.1);">
  <div style="background:#c0392b;padding:18px 24px;">
    <h1 style="margin:0;color:#fff;font-size:18px;font-weight:600;">抖音续火花：sessionid 已失效</h1>
    <p style="margin:6px 0 0;color:rgba(255,255,255,0.8);font-size:13px;">{today}</p>
  </div>
  <div style="padding:22px 24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:14px;line-height:1.7;color:#24292e;">
    <p style="margin:0 0 14px;">巡检发现 <code>SESSIONID_{uid}</code> 已失效，<strong>今晚 22:00 的续火花发送会失败</strong>。</p>
    <p style="margin:0 0 14px;">{streak_line}</p>
    <p style="margin:0 0 6px;color:#6a737d;font-size:13px;">探测结果：</p>
    <pre style="margin:0 0 18px;padding:10px 12px;background:#f6f8fa;border-radius:6px;font-size:12px;overflow-x:auto;">{detail}</pre>
    <p style="margin:0 0 8px;font-weight:600;">如何修复</p>
    <ol style="margin:0 0 16px;padding-left:20px;">
      <li>在 Edge 打开 <a href="https://www.douyin.com/">douyin.com</a> 扫码登录</li>
      <li>登录后告诉 Claude「登录好了」，由它导出并更新 VPS 凭据</li>
      <li>或手工执行：<code>NEW_SESSIONID=&lt;32位&gt; .venv/bin/python3 update_sessionid.py</code></li>
    </ol>
    <p style="margin:0;color:#6a737d;font-size:12px;">sessionid 有效期为 60 天，到期需重新登录。本告警由 check_sessionid.py 每日自动发出，修复后自动停止。</p>
  </div>
</div></body></html>""".format(today=today, uid=USER_ID, streak_line=streak_line, detail=detail)

    msg = MIMEText(body, "html", "utf-8")
    msg["Subject"] = subject
    msg["From"] = sender
    msg["To"] = receiver

    try:
        with smtplib.SMTP_SSL(host, int(port), timeout=25) as server:
            server.login(sender, auth_code)
            server.sendmail(sender, [receiver], msg.as_string())
        return True
    except Exception as error:  # noqa: BLE001 - alert failure must not crash the check
        log("ALERT SEND FAILED: %s: %s" % (type(error).__name__, str(error)[:200]))
        return False


def main() -> int:
    is_test = "--test" in sys.argv[1:]
    today = datetime.now(BEIJING_TZ).strftime("%Y-%m-%d")
    if not USER_ID:
        log("FATAL: DOUYIN_USER_ID missing from environment")
        return 2
    sessionid = os.getenv("SESSIONID_" + USER_ID, "").strip()
    if not sessionid:
        log("FATAL: SESSIONID_%s missing from .env" % USER_ID)
        return 2

    cookies = parse_cookies(os.getenv("COOKIES_" + USER_ID, ""))
    verdict, detail = probe(sessionid, cookies)
    log("verdict=%s detail=%s" % (verdict, detail))

    if is_test:
        log("--test mode: sending one alert email, not touching state")
        sent = send_alert(today, 0, detail, is_test=True)
        log("test alert %s" % ("sent" if sent else "FAILED"))
        return 0 if sent else 1

    state = load_state()

    if verdict == "invalid":
        streak = int(state.get("invalid_streak", 0)) + 1
        if state.get("last_alert_date") != today:
            sent = send_alert(today, streak, detail)
            if sent:
                state["last_alert_date"] = today
                log("alert emailed, streak=%d" % streak)
            else:
                log("alert could not be sent, streak=%d" % streak)
        else:
            log("already alerted today, skipping email")
        state["invalid_streak"] = streak
        state["last_invalid_date"] = today
        save_state(state)
        return 1

    if verdict == "valid":
        previous = int(state.get("invalid_streak", 0))
        if previous:
            log("recovered after %d day(s) of invalid sessionid" % previous)
        state["invalid_streak"] = 0
        state["last_ok_date"] = today
        save_state(state)
        return 0

    # unknown: do not alert, but record so the gap is visible later
    state["last_unknown_date"] = today
    state["last_unknown_detail"] = detail
    save_state(state)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
