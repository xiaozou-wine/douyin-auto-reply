from dataclasses import dataclass
import time

from utils.logger import setup_logger
from utils.config import get_config, get_userData
from .web_api import DouyinPmCliClient, JarCallError
from skills import execute_skill

config = get_config()
userData = get_userData()
logger = setup_logger(level=config.get("logLevel", "Info"))
matchMode = config.get("matchMode", "nickname")
userIDDict = {}


@dataclass(frozen=True)
class DeliveryResult:
    status: str
    reason: str = None

    @property
    def confirmed(self) -> bool:
        return self.status == "confirmed"


CONFIRMED = DeliveryResult("confirmed")
FAILED_BEFORE_DISPATCH = "failed-before-dispatch"
UNKNOWN_AFTER_DISPATCH = "unknown-after-dispatch"


def do_user_task(client, username, targets, skill_name, skill_config):
    if not targets:
        return DeliveryResult(FAILED_BEFORE_DISPATCH, "no-targets")

    all_confirmed = True
    for target in targets:
        try:
            result = execute_skill(
                skill_name=skill_name,
                client=client,
                conversation_id=target.get("conversation_id"),
                conversation_short_id=target.get("conversation_short_id"),
                is_group=target.get("is_group", False),
                config_raw=skill_config,
            )
            if isinstance(result, dict) and result.get("success") is True:
                logger.info("Task outcome: success")
            else:
                logger.error("Task outcome: failure")
                all_confirmed = False
            time.sleep(5)  # Wait before the next target.
        except JarCallError as error:
            logger.error(f"Task outcome: {error.outcome}")
            return DeliveryResult(error.outcome, error.reason)
        except Exception:
            logger.error("Task outcome: failed-before-dispatch")
            return DeliveryResult(FAILED_BEFORE_DISPATCH, "exception")

    return CONFIRMED if all_confirmed else DeliveryResult(FAILED_BEFORE_DISPATCH, "skill-failure")


def runTasks():
    try:
        logger.info("Task batch started")
        skill_name = config["skill"]["name"]
        skill_config = config["skill"]["config"]
        logger.debug("Task configuration loaded")

        client = None
        attempted = False

        for user in userData:
            cookies = user["cookies"]
            targets = user["targets"]
            user_id = user["user_id"]
            session_id = user["session_id"]

            ms_token = cookies.get("ms_token", "")
            verify_fp = cookies.get("s_v_web_id", "")
            fp = cookies.get("s_v_web_id", "")
            uifid = cookies.get("UIFID", "")

            if not client:
                client = DouyinPmCliClient(
                    session_id=session_id,
                    user_id=user_id,
                    ms_token=ms_token,
                    verify_fp=verify_fp,
                    fp=fp,
                    uifid=uifid,
                )
            else:
                client.session_id = session_id
                client.user_id = user_id
                client.ms_token = ms_token
                client.verify_fp = verify_fp
                client.fp = fp
                client.uifid = uifid

            logger.info("Account task started")
            if targets:
                attempted = True
            result = do_user_task(client, "", targets, skill_name, skill_config)
            logger.info("Account task completed")
            if result.status != "confirmed":
                return result

        if not attempted:
            return DeliveryResult(FAILED_BEFORE_DISPATCH, "no-targets")
        return CONFIRMED
    except Exception:
        logger.error("Task batch failed")
        return DeliveryResult(FAILED_BEFORE_DISPATCH, "batch-exception")
