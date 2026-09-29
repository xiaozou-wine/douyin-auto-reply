from dataclasses import dataclass, field
from typing import Any, Mapping
import random
from .base import BaseSkill, DouyinPmCliClient, ExecuteResponse


@dataclass(slots=True)
class CustomTextSkillConfig:
    messages: list[str] = field(default_factory=list)


class CustomTextSkill(BaseSkill[CustomTextSkillConfig]):
    def __init__(self, client: DouyinPmCliClient):
        super().__init__("custom_text", client)

    @classmethod
    def build_config(cls, raw: Mapping[str, Any] | None = None) -> CustomTextSkillConfig:
        raw = raw or {}
        messages = raw.get("messages", [])
        if not messages:
            messages = ["续火花+1 🔥"]
        return CustomTextSkillConfig(messages=messages)

    def execute(
        self,
        conversation_id: str,
        conversation_short_id: int | str,
        is_group: bool = False,
        config: CustomTextSkillConfig | None = None,
    ) -> ExecuteResponse:
        config = config or self.build_config()
        message = random.choice(config.messages)
        result = self.client.send_text(
            conversation_id=conversation_id,
            conversation_short_id=conversation_short_id,
            content=message,
            is_group=is_group,
        )
        data = result.data
        if result.success:
            return {"success": True, "message": f"消息发送成功: {message}", "data": data}
        else:
            return {"success": False, "message": f"发送失败: {data.get('message', '未知错误')}", "data": data}
