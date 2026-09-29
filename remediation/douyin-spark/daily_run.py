"""
抖音自动续火花 - 晚间发送脚本

逻辑：
1. 检查当天是否已经确认发送
2. 消息来源检测不可用时保持关闭，不做不可靠的即时发送判断
3. 在 SEND_WINDOW_START-SEND_WINDOW_END（默认 22:00-22:30）随机延迟后发送
4. 当天未确认发送成功时发一封告警邮件（同日只发一封）

发送窗口从 .env 读取，不要硬编码：cron 触发时刻与窗口起点是两处独立配置，
改了一处必须同步另一处，否则会出现"每天发告警但永远不发送"。
"""
import json
import os
import random
import sys
import time
import hashlib
from datetime import datetime, timezone, timedelta

from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))

from core.tasks import DeliveryResult, runTasks
from utils.alert_mail import send_mail
from utils.logger import setup_logger

logger = setup_logger(level="INFO")

STATE_FILE = os.path.join(os.path.dirname(__file__), ".send_state.json")
BEIJING_TZ = timezone(timedelta(hours=8))

# 发送窗口默认值，仅在 .env 未设置时生效。窗口长度由起止时间共同决定。
DEFAULT_WINDOW_START = "22:00"
DEFAULT_WINDOW_END = "22:30"

# 距窗口起点超过这个时长就认为 cron 与窗口配置对不上，停止发送。
MAX_START_WAIT_SECONDS = 6 * 3600


class StateFileError(RuntimeError):
    """The delivery state is unreadable, so sending must stop safely."""


class WindowConfigError(RuntimeError):
    """发送窗口配置不合法，必须停止发送，避免在错误的时间发消息。"""


def parse_window_time(raw, field: str) -> tuple:
    """把 .env 里的 HH:MM 解析成 (hour, minute)。

    未设置时用默认值；格式或范围不对则抛 WindowConfigError——宁可不发，
    也不要在猜测的时间发消息。
    """
    default = DEFAULT_WINDOW_START if field == "SEND_WINDOW_START" else DEFAULT_WINDOW_END
    text = (raw or "").strip() or default
    parts = text.split(":")
    if len(parts) != 2 or not all(part.strip().isdigit() for part in parts):
        raise WindowConfigError(f"{field}={text!r} 不是合法的 HH:MM 时间")
    hour, minute = int(parts[0]), int(parts[1])
    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        raise WindowConfigError(f"{field}={text!r} 超出 00:00-23:59 范围")
    return hour, minute


def send_window() -> tuple:
    """返回 (start, end) 两个 datetime。

    end 不晚于 start 时视为跨午夜窗口，end 顺延到次日。跨午夜窗口要求
    cron 触发时刻与 start 落在同一天，否则窗口起点会被算到 24 小时之后。
    """
    start_hour, start_minute = parse_window_time(
        os.getenv("SEND_WINDOW_START"), "SEND_WINDOW_START"
    )
    end_hour, end_minute = parse_window_time(
        os.getenv("SEND_WINDOW_END"), "SEND_WINDOW_END"
    )
    now = datetime.now(BEIJING_TZ)
    start = now.replace(hour=start_hour, minute=start_minute, second=0, microsecond=0)
    end = now.replace(hour=end_hour, minute=end_minute, second=0, microsecond=0)
    if end <= start:
        end += timedelta(days=1)
    return start, end


def window_label() -> str:
    """返回 "22:00-22:30" 形式的窗口文案，供日志与邮件使用，绝不抛异常。"""
    try:
        start, end = send_window()
    except WindowConfigError:
        start_text = (os.getenv("SEND_WINDOW_START") or "").strip() or DEFAULT_WINDOW_START
        end_text = (os.getenv("SEND_WINDOW_END") or "").strip() or DEFAULT_WINDOW_END
        return f"{start_text}-{end_text}"
    return f"{start.strftime('%H:%M')}-{end.strftime('%H:%M')}"


def get_state() -> dict:
    try:
        with open(STATE_FILE, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return {}
    except json.JSONDecodeError as error:
        raise StateFileError("Send state file is invalid") from error


def save_state(state: dict) -> None:
    state_path = os.path.abspath(STATE_FILE)
    temp_path = f"{state_path}.tmp"
    try:
        with open(temp_path, "w", encoding="utf-8") as f:
            json.dump(state, f, ensure_ascii=False, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp_path, state_path)
    finally:
        try:
            os.unlink(temp_path)
        except FileNotFoundError:
            pass


def target_state_key(target_key: str) -> str:
    """Return a non-reversible state key instead of storing the conversation ID."""
    digest = hashlib.sha256(target_key.encode("utf-8")).hexdigest()
    return f"target-{digest[:16]}"


def already_sent_today(state: dict, target_key: str) -> bool:
    """检查某个对话今天是否已经发送过消息"""
    today = datetime.now(BEIJING_TZ).strftime("%Y-%m-%d")
    if state.get("date") != today:
        return False
    return bool(
        state.get(target_state_key(target_key), False)
        or state.get(target_key, False)
    )


def mark_sent(state: dict, target_key: str) -> None:
    """标记今天已发送"""
    today = datetime.now(BEIJING_TZ).strftime("%Y-%m-%d")
    state["date"] = today
    state[target_state_key(target_key)] = True
    state["sent_at"] = datetime.now(BEIJING_TZ).isoformat()
    save_state(state)


def mark_unknown(state: dict, target_key: str, reason=None) -> None:
    """Persist an uncertain post-dispatch outcome and block automatic retries."""
    today = datetime.now(BEIJING_TZ).strftime("%Y-%m-%d")
    state["date"] = today
    state["unknown_target"] = target_state_key(target_key)
    state["unknown_at"] = datetime.now(BEIJING_TZ).isoformat()
    state["unknown_reason"] = reason or "unknown-after-dispatch"
    save_state(state)


def mark_sent_safely(state: dict, target_key: str) -> bool:
    """消息已确认发出后写状态。写失败必须告警。

    状态没落盘意味着明天会把这天当成"没发过"，存在重复发送风险，
    所以这里不能只写日志。
    """
    try:
        mark_sent(state, target_key)
        return True
    except OSError as error:
        logger.error(f"状态写入失败: {error}")
        alert_failure(
            state,
            "state-write-failed",
            "消息已确认发出，但 .send_state.json 写入失败: %s" % error,
            persist=False,
        )
        return False


def has_unresolved_unknown(state: dict, target_key: str) -> bool:
    today = datetime.now(BEIJING_TZ).strftime("%Y-%m-%d")
    return (
        state.get("date") == today
        and state.get("unknown_target") == target_state_key(target_key)
    )


def alert_failure(state, status: str, detail: str, persist: bool = True) -> None:
    """当天未确认发送成功时发一封告警邮件，同一天只发一封。

    ``state`` 为 None 表示发送状态文件不可读：此时只发邮件，不写状态，
    避免覆盖损坏文件里可能还有用的证据。
    """
    today = datetime.now(BEIJING_TZ).strftime("%Y-%m-%d")
    if state is not None and state.get("last_alert_date") == today:
        logger.info("今天已经发过失败告警，跳过")
        return

    now = datetime.now(BEIJING_TZ).strftime("%Y-%m-%d %H:%M:%S")
    subject = f"[续火告警] 今日未发送成功 ({status}) {today}"
    body = """<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f5f5f5;">
<div style="max-width:600px;margin:20px auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.1);">
  <div style="background:#c0392b;padding:18px 24px;">
    <h1 style="margin:0;color:#fff;font-size:18px;font-weight:600;">抖音续火花：今晚未发送成功</h1>
    <p style="margin:6px 0 0;color:rgba(255,255,255,0.8);font-size:13px;">{today} {now}</p>
  </div>
  <div style="padding:22px 24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:14px;line-height:1.7;color:#24292e;">
    <p style="margin:0 0 14px;">今天这一次续火花<strong>没有确认发送成功</strong>，状态未标记为已发送。</p>
    <p style="margin:0 0 6px;color:#6a737d;font-size:13px;">失败详情：</p>
    <pre style="margin:0 0 18px;padding:10px 12px;background:#f6f8fa;border-radius:6px;font-size:12px;overflow-x:auto;">status: {status}
detail: {detail}</pre>
    <p style="margin:0 0 8px;font-weight:600;">排查方向</p>
    <ol style="margin:0 0 16px;padding-left:20px;">
      <li><code>unknown-after-dispatch</code>：已派发但结果未知，系统已阻止当日重试以免重复发送。查看 <code>logs/cron.log</code> 里的 <code>JAR_NONZERO_EXIT</code> 原始输出。</li>
      <li><code>failed-before-dispatch</code>：消息未派发，通常是凭据失效或上传授权失败，按 sessionid 更换流程处理。</li>
      <li><code>window-missed</code>：进程启动时已过窗口终点，检查机器是否休眠或 cron 是否未按时触发。</li>
      <li><code>window-misconfigured</code>：<code>SEND_WINDOW_START</code>/<code>SEND_WINDOW_END</code> 不是合法 HH:MM，或 cron 触发时刻离窗口起点太远。</li>
      <li><code>state-file-corrupt</code>：<code>.send_state.json</code> 损坏，脚本已安全停止，未发送任何消息。</li>
      <li><code>state-write-failed</code>：消息已确认发出，但状态写入失败（通常是磁盘满），请手工补记当天状态以免明天误判。</li>
    </ol>
    <p style="margin:0;color:#6a737d;font-size:12px;">本告警由 daily_run.py 在发送任务结束时自动发出，发送成功当天不会收到。</p>
  </div>
</div></body></html>""".format(today=today, now=now, status=status, detail=detail)

    if not send_mail(subject, body):
        return

    if state is not None and persist:
        state["last_alert_date"] = today
        try:
            save_state(state)
        except OSError as error:
            logger.error(f"告警已发送但状态写入失败: {error}")


def random_night_delay():
    """在配置的发送窗口内随机延迟。

    窗口早于当前时刻且未结束则立即进入随机延迟；窗口尚未开始则先等到起点。
    返回值只表示"可以发送"，窗口配置错误会抛 WindowConfigError 由调用方处理。
    """
    start, end = send_window()
    now = datetime.now(BEIJING_TZ)

    # 窗口已经结束，今天不发了
    if now > end:
        logger.warning(
            f"当前时间 {now.strftime('%H:%M')} 已过窗口终点 {end.strftime('%H:%M')}，跳过发送"
        )
        return False

    # 窗口还没开始，先等到起点。等太久说明 cron 与窗口配置对不上，停止发送。
    if now < start:
        wait_seconds = (start - now).total_seconds()
        if wait_seconds > MAX_START_WAIT_SECONDS:
            raise WindowConfigError(
                "距窗口起点还有 %.1f 小时，超过上限 %d 小时；"
                "检查 cron 触发时刻是否与 SEND_WINDOW_START 同一天"
                % (wait_seconds / 3600, MAX_START_WAIT_SECONDS // 3600)
            )
        logger.info(
            f"当前时间 {now.strftime('%H:%M')}，距离窗口起点 {start.strftime('%H:%M')} "
            f"还有 {wait_seconds:.0f} 秒，等待中..."
        )
        time.sleep(wait_seconds)

    # 在剩余窗口内随机延迟，由 remaining_seconds 钳制，不会跨过窗口终点。
    now = datetime.now(BEIJING_TZ)
    remaining_seconds = max(0, int((end - now).total_seconds()))
    delay = random.randint(0, remaining_seconds)
    logger.info(f"随机延迟 {delay} 秒（{delay//60} 分 {delay%60} 秒）...")
    time.sleep(delay)

    return True


def try_check_messages():
    """Return ``None`` because safe message-origin detection is unavailable.

    The former unauthenticated HTTP probe could not reliably identify the sender
    and could turn an ambiguous response into an immediate send.  Keep this
    function fail-closed until a supported, verified detection method exists.
    """
    logger.info("Message detection unavailable; skipping detection")
    return None


def get_target_key() -> str:
    """返回续火花目标的会话标识，由 .env 的 DOUYIN_TARGET_ID 提供。

    抽成函数而不是在 main() 里直接读 os.environ：测试可以 patch 它，
    不必依赖环境变量的加载时序。
    """
    return os.getenv("DOUYIN_TARGET_ID", "").strip()


def main():
    logger.info("=" * 50)
    logger.info("抖音自动续火花 - 智能发送脚本启动")
    logger.info(f"发送窗口: {window_label()}")
    logger.info("=" * 50)

    try:
        state = get_state()
    except StateFileError as error:
        # 状态不可读时无法判断今天是否已发送，宁可漏发也不能重复发送。
        logger.error(f"发送状态文件不可读，安全停止: {error}")
        alert_failure(None, "state-file-corrupt", str(error))
        return

    target_key = get_target_key()
    if not target_key:
        logger.error("DOUYIN_TARGET_ID 未设置，无法确定发送目标，安全停止")
        alert_failure(state, "missing-target-id", "DOUYIN_TARGET_ID 未在 .env 中设置")
        return

    # === 第一步：检查今天是否已发送 ===
    if already_sent_today(state, target_key):
        logger.info("今天已经发送过了，跳过本次运行")
        return
    if has_unresolved_unknown(state, target_key):
        logger.error("今天存在未确认的发送结果，阻止自动重试")
        alert_failure(
            state,
            "unknown-after-dispatch",
            "当天已有未确认记录: %s at %s"
            % (state.get("unknown_reason", "unknown"), state.get("unknown_at", "unknown")),
        )
        return

    # === 第二步：消息来源检测当前关闭 ===
    api_result = try_check_messages()
    if api_result is True:
        logger.info("检测到对方今天发过消息，立即回复！")
        # 直接发，不等待晚间窗口
        result = runTasks()
        if result.confirmed:
            if mark_sent_safely(state, target_key):
                logger.info("回复完成 ✅")
        else:
            if result.status == "unknown-after-dispatch":
                mark_unknown(state, target_key, result.reason)
            logger.error(f"回复未确认 ({result.status})，不标记已发送")
            alert_failure(state, result.status, result.reason or "-")
        return

    # === 第三步：走晚间随机发送 ===
    if api_result is None:
        logger.info("消息检测不可用，走晚间定时发送")
    else:
        logger.info("对方今天未发消息，等待晚间窗口发送")

    # 等待窗口内随机时间
    try:
        may_send = random_night_delay()
    except WindowConfigError as error:
        logger.error(f"发送窗口配置错误，安全停止: {error}")
        alert_failure(state, "window-misconfigured", str(error))
        return

    if not may_send:
        alert_failure(
            state,
            "window-missed",
            "%s 启动时已过窗口 %s，今天没有发送"
            % (datetime.now(BEIJING_TZ).strftime("%H:%M:%S"), window_label()),
        )
        return

    # 执行发送
    logger.info("开始发送消息...")
    result = runTasks()
    if result.confirmed:
        if mark_sent_safely(state, target_key):
            logger.info(f"发送完成 ✅ (时间: {datetime.now(BEIJING_TZ).strftime('%H:%M:%S')})")
    else:
        if result.status == "unknown-after-dispatch":
            mark_unknown(state, target_key, result.reason)
        logger.error(
            f"发送未确认 ({result.status}, 时间: {datetime.now(BEIJING_TZ).strftime('%H:%M:%S')})，不标记已发送"
        )
        alert_failure(state, result.status, result.reason or "-")


if __name__ == "__main__":
    main()
