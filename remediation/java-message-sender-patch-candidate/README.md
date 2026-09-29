# Offline Java response-handling patch candidate

This directory contains an offline source/test candidate for the private-message response handling inherited from `douyin-web-api-sdk`.

## Scope

- Patches only the HTTP-200 response path used by `MessageSender.sendMessageInternal`.
- Adds a pure classifier that rejects obvious HTML, JSON, text and empty responses before protobuf parsing.
- Converts truncated protobuf and parsed remote failures, including `extra_info`, into fixed, redacted metadata.
- Does not change request construction, image upload, `createConversation`, credentials, targets or scheduling.

## Important limitation

`PrivateMessageSendScript` source is not public and is not reconstructed here. This directory is **not** a rebuilt `kol_dy_msg` CLI and cannot prove that real Douyin sending has recovered. The production JAR is never executed by these tests.

The tracked full source is an exact authorized upstream copy plus the response-handling patch. It contains upstream hard-coded request templates and query material; treat this candidate as sensitive project source and do not publish it without a separate sanitization review.

## Offline test

From Git Bash:

```bash
export PRODUCTION_JAR=/e/dest/claude-test/projects/auto-reply/vps-production-backup-20260717-private/payload/douyin-spark/res/kol_dy_msg-1.0.4-SNAPSHOT-private-message-cli.jar
bash scripts/run-offline-tests.sh
```

The script verifies the exact JAR SHA-256, extracts only classpath files into ignored `build/`, compiles with `javac --release 17`, and runs synthetic in-memory response tests. It makes no network request and never launches the JAR.
