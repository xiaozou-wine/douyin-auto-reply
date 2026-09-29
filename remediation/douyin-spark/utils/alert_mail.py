"""告警邮件发送通道。

配置从 .env 读取，键名 ALERT_EMAIL_*，与 check_sessionid.py 共用同一组
SMTP 凭据（只维护一处授权码）。

设计约束：发送失败只记日志并返回 False，绝不抛出。告警通道故障不得让
发送任务本身失败，也不得改变退出码语义。
"""
import os
import smtplib
from email.mime.text import MIMEText

from utils.logger import setup_logger

logger = setup_logger(level="INFO")


def send_mail(subject: str, html_body: str) -> bool:
    """把一封 HTML 邮件交给 SMTP 服务器，成功受理返回 True。

    配置不完整、认证失败、超时等一律返回 False 并写日志，不抛异常。
    """
    host = os.getenv("ALERT_EMAIL_SMTP", "").strip()
    port = os.getenv("ALERT_EMAIL_PORT", "465").strip()
    sender = os.getenv("ALERT_EMAIL_SENDER", "").strip()
    auth_code = os.getenv("ALERT_EMAIL_AUTH_CODE", "").strip()
    receiver = os.getenv("ALERT_EMAIL_RECEIVER", "").strip() or sender

    if not (host and sender and auth_code and receiver):
        logger.error("告警未发送: .env 中 ALERT_EMAIL_* 配置不完整")
        return False

    msg = MIMEText(html_body, "html", "utf-8")
    msg["Subject"] = subject
    msg["From"] = sender
    msg["To"] = receiver

    try:
        with smtplib.SMTP_SSL(host, int(port), timeout=25) as server:
            server.login(sender, auth_code)
            server.sendmail(sender, [receiver], msg.as_string())
        logger.info("告警邮件已发送")
        return True
    except Exception as error:  # noqa: BLE001 - 告警失败不能中断发送任务
        logger.error(f"告警邮件发送失败: {type(error).__name__}: {str(error)[:200]}")
        return False
