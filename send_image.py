from dataclasses import dataclass, field
from typing import Any, Mapping
import random
import os
from .base import BaseSkill, DouyinPmCliClient, ExecuteResponse


@dataclass(slots=True)
class SendImageSkillConfig:
    image_paths: list[str] = field(default_factory=list)


class SendImageSkill(BaseSkill[SendImageSkillConfig]):
    def __init__(self, client: DouyinPmCliClient):
        super().__init__("send_image", client)

    @classmethod
    def build_config(cls, raw: Mapping[str, Any] | None = None) -> SendImageSkillConfig:
        raw = raw or {}
        image_paths = raw.get("image_paths", [])
        if not image_paths:
            default_path = os.path.join(
                os.path.dirname(__file__), "..", "images", "spark.png"
            )
            image_paths = [os.path.abspath(default_path)]
        return SendImageSkillConfig(image_paths=image_paths)

    def execute(
        self,
        conversation_id: str,
        conversation_short_id: int | str,
        is_group: bool = False,
        config: SendImageSkillConfig | None = None,
    ) -> ExecuteResponse:
        config = config or self.build_config()
        image_path = random.choice(config.image_paths)

        if not os.path.isfile(image_path):
            return {
                "success": False,
                "message": f"图片文件不存在: {image_path}",
                "data": {},
            }

        result = self.client.send_image_upload(
            conversation_id=conversation_id,
            conversation_short_id=conversation_short_id,
            image_path=image_path,
            is_group=is_group,
        )

        data = result.data
        if result.success:
            return {
                "success": True,
                "message": f"图片发送成功: {os.path.basename(image_path)}",
                "data": data,
            }
        else:
            return {
                "success": False,
                "message": f"图片发送失败: {data.get('message', '未知错误')}",
                "data": data.get("error", {}),
            }
