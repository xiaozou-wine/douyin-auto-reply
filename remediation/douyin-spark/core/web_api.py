from __future__ import annotations

import base64
import json
import os
import shutil
import subprocess
import locale
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger("app")

# Max bytes to dump from each stream (raw dump, lossless via base64).
# 2026-09-23: raised 8192 -> 65536. The image-upload path logs the full
# CommitUpload response plus an exception stack; the 2026-09-23 failure
# produced 15328 bytes of stdout, so the old cap cut the dump off right
# before the actual error. base64 below is lossless over the whole chunk,
# but note the *_text field is still capped at 4096 chars, so read the
# tail of a large dump with: grep -h stdout_b64= ... | base64 -d | tail -c 4000
_DUMP_MAX_BYTES = 65536


@dataclass
class JarCallResult:
    returncode: int
    command: list[str]
    stdout: str
    stderr: str
    data: Optional[dict[str, Any]]
    success: Optional[bool]


@dataclass(frozen=True)
class JarCallFailure:
    returncode: int
    stdout_bytes: int
    stderr_bytes: int


class JarCallError(RuntimeError):
    """A post-dispatch CLI failure with a redacted diagnostic summary."""

    _OUTCOME = "unknown-after-dispatch"

    def __init__(self, result: JarCallResult, reason: str, diagnostics: dict[str, Any] | None = None):
        self.result = JarCallFailure(
            returncode=result.returncode,
            stdout_bytes=len(result.stdout.encode("utf-8")),
            stderr_bytes=len(result.stderr.encode("utf-8")),
        )
        self.reason = reason
        self.outcome = self._OUTCOME
        self.diagnostics = diagnostics or {}
        super().__init__(
            "CLI call failed "
            f"(reason={reason}, outcome={self.outcome}, "
            f"returncode={self.result.returncode}, "
            f"stdout_bytes={self.result.stdout_bytes}, "
            f"stderr_bytes={self.result.stderr_bytes})"
        )


class DouyinPmCliClient:
    """
    Python wrapper for:
      kol_dy_msg-1.0.4-SNAPSHOT-private-message-cli.jar

    Required init params:
      session_id, user_id, ms_token, verify_fp, fp, uifid

    Fixed (not exposed):
      output=json, quiet=false (diagnostic mode)
    """

    _OUTPUT = "json"
    _QUIET = False  # Diagnostic mode: let JAR output verbose info

    def __init__(
        self,
        *,
        session_id: str,
        user_id: str,
        ms_token: str,
        verify_fp: str,
        fp: str,
        uifid: str,
        jar_path: Optional[str | Path] = None,
        java_path: Optional[str | Path] = None,
        timeout_sec: int = 60,
    ) -> None:
        # property setters (with validation)
        self.session_id = session_id
        self.user_id = user_id
        self.ms_token = ms_token
        self.verify_fp = verify_fp
        self.fp = fp
        self.uifid = uifid
        self.timeout_sec = timeout_sec

        self.java_path = Path(java_path) if java_path else self._auto_find_java()
        self.jar_path = (
            Path(jar_path)
            if jar_path
            else Path(__file__).parent.parent
            / "res"
            / "kol_dy_msg-1.0.4-SNAPSHOT-private-message-cli.jar"
        )

    # ---------- property helpers ----------
    @staticmethod
    def _must_non_empty(name: str, value: str) -> str:
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"{name} is required and cannot be blank")
        return value.strip()

    # ---------- required business fields ----------
    @property
    def session_id(self) -> str:
        return self._session_id

    @session_id.setter
    def session_id(self, value: str) -> None:
        self._session_id = self._must_non_empty("session_id", value)

    @property
    def user_id(self) -> str:
        return self._user_id

    @user_id.setter
    def user_id(self, value: str) -> None:
        self._user_id = self._must_non_empty("user_id", value)

    @property
    def ms_token(self) -> str:
        return self._ms_token

    @ms_token.setter
    def ms_token(self, value: str) -> None:
        self._ms_token = self._must_non_empty("ms_token", value)

    @property
    def verify_fp(self) -> str:
        return self._verify_fp

    @verify_fp.setter
    def verify_fp(self, value: str) -> None:
        self._verify_fp = self._must_non_empty("verify_fp", value)

    @property
    def fp(self) -> str:
        return self._fp

    @fp.setter
    def fp(self, value: str) -> None:
        self._fp = self._must_non_empty("fp", value)

    @property
    def uifid(self) -> str:
        return self._uifid

    @uifid.setter
    def uifid(self, value: str) -> None:
        self._uifid = self._must_non_empty("uifid", value)

    # ---------- runtime fields ----------
    @property
    def jar_path(self) -> Path:
        return self._jar_path

    @jar_path.setter
    def jar_path(self, value: str | Path) -> None:
        p = Path(value)
        if not p.exists():
            raise FileNotFoundError(f"jar not found: {p}")
        self._jar_path = p

    @property
    def java_path(self) -> Path:
        return self._java_path

    @java_path.setter
    def java_path(self, value: str | Path) -> None:
        p = Path(value)
        if not p.exists():
            raise FileNotFoundError(f"java not found: {p}")
        self._java_path = p

    @property
    def timeout_sec(self) -> int:
        return self._timeout_sec

    @timeout_sec.setter
    def timeout_sec(self, value: int) -> None:
        if int(value) <= 0:
            raise ValueError("timeout_sec must be > 0")
        self._timeout_sec = int(value)

    # ---------- auto path discovery ----------
    def _auto_find_java(self) -> Path:
        java = shutil.which("java")
        if java:
            return Path(java)

        java_home = os.getenv("JAVA_HOME")
        if java_home:
            exe = "java.exe" if os.name == "nt" else "java"
            candidate = Path(java_home) / "bin" / exe
            if candidate.exists():
                return candidate

        raise FileNotFoundError("java not found in PATH (and JAVA_HOME is invalid)")

    # ---------- unified call ----------
    @staticmethod
    def _to_cli_value(v: Any) -> Optional[str]:
        if v is None:
            return None
        if isinstance(v, bool):
            return "true" if v else "false"
        return str(v)

    import locale

    @staticmethod
    def _decode_bytes(raw: bytes) -> str:
        if not raw:
            return ""
        tried = []
        for enc in ("utf-8", locale.getpreferredencoding(False), "gb18030", "cp936"):
            if not enc or enc in tried:
                continue
            tried.append(enc)
            try:
                return raw.decode(enc)
            except UnicodeDecodeError:
                pass
        return raw.decode("utf-8", errors="replace")

    @staticmethod
    def _parse_json_from_stdout(stdout: str) -> Optional[dict[str, Any]]:
        s = (stdout or "").strip()
        if not s:
            return None
        try:
            obj = json.loads(s)
            return obj if isinstance(obj, dict) else None
        except json.JSONDecodeError:
            pass

        # 兼容"前面有杂讯，最后一行才是 JSON"
        for line in reversed([x.strip() for x in s.splitlines() if x.strip()]):
            if line.startswith("{") and line.endswith("}"):
                try:
                    obj = json.loads(line)
                    return obj if isinstance(obj, dict) else None
                except json.JSONDecodeError:
                    continue
        return None

    @staticmethod
    def _dump_stream(name: str, raw_bytes: bytes) -> dict[str, str]:
        """
        Dump raw stream content losslessly, no interpretation.
        Returns base64 and text representations, up to _DUMP_MAX_BYTES.
        """
        total = len(raw_bytes)
        truncated = total > _DUMP_MAX_BYTES
        chunk = raw_bytes[:_DUMP_MAX_BYTES]

        result = {
            f"{name}_bytes": total,
        }

        # Lossless: base64
        result[f"{name}_b64"] = base64.b64encode(chunk).decode("ascii")
        if truncated:
            result[f"{name}_b64_truncated"] = True

        # Text: best-effort decode
        text = DouyinPmCliClient._decode_bytes(chunk)
        if text:
            # limit text dump to 4096 chars to avoid log flooding
            text_dump = text[:4096]
            result[f"{name}_text"] = text_dump
            if truncated or len(text) > 4096:
                result[f"{name}_text_truncated"] = True

        # Hex: always include first 128 bytes for binary signature
        hex_bytes = raw_bytes[:128]
        result[f"{name}_hex"] = hex_bytes.hex(" ")

        return result

    def _call(
        self,
        msg_type: str,
        *,
        params: Optional[dict[str, Any]] = None,
        timeout_sec: Optional[int] = None,
        check: bool = True,
    ) -> JarCallResult:
        call_params: dict[str, Any] = {
            "sessionId": self.session_id,
            "userId": self.user_id,
            "msToken": self.ms_token,
            "verifyFp": self.verify_fp,
            "fp": self.fp,
            "uifid": self.uifid,
            "type": msg_type,
            "output": self._OUTPUT,
            "quiet": self._QUIET,
        }
        if params:
            call_params.update(params)

        cmd = [str(self.java_path), "-jar", str(self.jar_path)]
        for k, v in call_params.items():
            vv = self._to_cli_value(v)
            if vv is None:
                continue
            key = k[2:] if k.startswith("--") else k
            cmd.extend([f"--{key}", vv])

        try:
            p = subprocess.run(
                cmd,
                capture_output=True,
                text=False,
                timeout=timeout_sec or self.timeout_sec,
            )
        except subprocess.TimeoutExpired as error:
            out = error.output or b""
            err = error.stderr or b""
            stdout_text = self._decode_bytes(out)
            stderr_text = self._decode_bytes(err)
            result = JarCallResult(
                returncode=-1,
                command=[],
                stdout=stdout_text,
                stderr=stderr_text,
                data=None,
                success=None,
            )
            diag: dict[str, Any] = {"reason": "timeout"}
            diag.update(self._dump_stream("stdout", out))
            diag.update(self._dump_stream("stderr", err))
            logger.error(f"JAR_TIMEOUT: {json.dumps({k: v for k, v in diag.items() if not k.endswith('_b64') and not k.endswith('_text')})}")
            logger.error(f"JAR_RESPONSE stdout_b64={diag.get('stdout_b64', '')}")
            if diag.get("stdout_text"):
                logger.error(f"JAR_RESPONSE stdout_text={diag['stdout_text']}")
            logger.error(f"JAR_RESPONSE stderr_b64={diag.get('stderr_b64', '')}")
            if diag.get("stderr_text"):
                logger.error(f"JAR_RESPONSE stderr_text={diag['stderr_text']}")
            raise JarCallError(result, reason="timeout", diagnostics=diag) from None

        stdout_text = self._decode_bytes(p.stdout)
        stderr_text = self._decode_bytes(p.stderr)
        data = self._parse_json_from_stdout(stdout_text)
        success_value = data.get("success") if data else None
        success = success_value if isinstance(success_value, bool) else None

        result = JarCallResult(
            returncode=p.returncode,
            command=cmd,
            stdout=stdout_text,
            stderr=stderr_text,
            data=data,
            success=success,
        )

        # Build raw dump, no classification
        diag: dict[str, Any] = {"reason": "unknown"}
        diag.update(self._dump_stream("stdout", p.stdout))
        diag.update(self._dump_stream("stderr", p.stderr))

        if check and p.returncode != 0:
            diag["reason"] = "nonzero-exit"
            self._log_diag(diag, "JAR_NONZERO_EXIT")
            raise JarCallError(result, reason="nonzero-exit", diagnostics=diag)
        if check and data is None:
            diag["reason"] = "invalid-json"
            self._log_diag(diag, "JAR_INVALID_JSON")
            raise JarCallError(result, reason="invalid-json", diagnostics=diag)
        if check and not isinstance(data.get("success"), bool):
            diag["reason"] = "invalid-success"
            self._log_diag(diag, "JAR_INVALID_SUCCESS")
            raise JarCallError(result, reason="invalid-success", diagnostics=diag)
        if check and success is False:
            diag["reason"] = "success-false"
            self._log_diag(diag, "JAR_SUCCESS_FALSE")
            raise JarCallError(result, reason="success-false", diagnostics=diag)

        return result

    def _log_diag(self, diag: dict[str, Any], tag: str) -> None:
        """Log the raw stream dump at ERROR level. No classification, no pattern matching."""
        # Summary line with metadata
        summary = {k: v for k, v in diag.items() if not k.endswith("_b64") and not k.endswith("_text") and not k.endswith("_hex")}
        logger.error(f"{tag}: exit_code={diag.get('reason', '?')}, meta={json.dumps(summary)}")

        # Full stdout as base64 (lossless)
        b64 = diag.get("stdout_b64", "")
        if b64:
            logger.error(f"{tag} stdout_b64={b64}")
        txt = diag.get("stdout_text", "")
        if txt:
            logger.error(f"{tag} stdout_text={txt}")
        hex_s = diag.get("stdout_hex", "")
        if hex_s:
            logger.error(f"{tag} stdout_hex={hex_s}")

        # Full stderr as base64 (lossless)
        b64 = diag.get("stderr_b64", "")
        if b64:
            logger.error(f"{tag} stderr_b64={b64}")
        txt = diag.get("stderr_text", "")
        if txt:
            logger.error(f"{tag} stderr_text={txt}")
        hex_s = diag.get("stderr_hex", "")
        if hex_s:
            logger.error(f"{tag} stderr_hex={hex_s}")

    # ---------- specialized methods ----------
    def send_text(
        self,
        *,
        conversation_id: str,
        conversation_short_id: int | str,
        content: str,
        is_group: bool = False,
        timeout_sec: Optional[int] = None,
        check: bool = True,
    ) -> JarCallResult:
        return self._call(
            "text",
            params={
                "conversationId": conversation_id,
                "conversationShortId": conversation_short_id,
                "content": content,
                "isGroup": is_group,
            },
            timeout_sec=timeout_sec,
            check=check,
        )

    def send_video_card(
        self,
        *,
        conversation_id: str,
        conversation_short_id: int | str,
        item_id: int | str,
        is_group: bool = False,
        timeout_sec: Optional[int] = None,
        check: bool = True,
    ) -> JarCallResult:
        return self._call(
            "video_card",
            params={
                "conversationId": conversation_id,
                "conversationShortId": conversation_short_id,
                "itemId": item_id,
                "isGroup": is_group,
            },
            timeout_sec=timeout_sec,
            check=check,
        )

    def send_dynamic_emoji(
        self,
        *,
        conversation_id: str,
        conversation_short_id: int | str,
        emoji_name: str,
        is_group: bool = False,
        timeout_sec: Optional[int] = None,
        check: bool = True,
    ) -> JarCallResult:
        return self._call(
            "dynamic_emoji",
            params={
                "conversationId": conversation_id,
                "conversationShortId": conversation_short_id,
                "emojiName": emoji_name,
                "isGroup": is_group,
            },
            timeout_sec=timeout_sec,
            check=check,
        )

    def send_image_upload(
        self,
        *,
        conversation_id: str,
        conversation_short_id: int | str,
        image_path: str | Path,
        is_group: bool = False,
        timeout_sec: Optional[int] = None,
        check: bool = True,
    ) -> JarCallResult:
        return self._call(
            "image_upload",
            params={
                "conversationId": conversation_id,
                "conversationShortId": conversation_short_id,
                "imagePath": str(image_path),
                "isGroup": is_group,
            },
            timeout_sec=timeout_sec,
            check=check,
        )

    def send_stranger_text(
        self,
        *,
        sec_uid: str,
        content: str,
        timeout_sec: Optional[int] = None,
        check: bool = True,
    ) -> JarCallResult:
        return self._call(
            "stranger_text",
            params={"secUid": sec_uid, "content": content},
            timeout_sec=timeout_sec,
            check=check,
        )


if __name__ == "__main__":
    pass
