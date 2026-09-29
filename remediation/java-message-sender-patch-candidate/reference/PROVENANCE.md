# Provenance

- Production artifact: `vps-production-backup-20260717-private/payload/douyin-spark/res/kol_dy_msg-1.0.4-SNAPSHOT-private-message-cli.jar`
- Production JAR SHA-256: `0c9d3e6de84b4ecf434b926a011f343dbd3bd008aad62e9474118c76b00778f1`
- Public application repository: `2061360308/DouYinSparkFlow`
- Captured production branch/commit: `api` / `1df6c414fcc3d7e46d228135c38e69fb6a4bcc9b`
- JAR introduction commit: `31b13e732e13884ccd0ce3e7c2fd455c741372a7`
- Authorized SDK source: `2061360308/douyin-web-api-sdk@83d36f3`
- Upstream merge commit: `Rockedw/douyin-web-api-sdk@2c9d76d`
- Production `MessageSender.class` SHA-256: `13cade6b16eaabd72a37f15c2f312a056d0310fe988bc1a9837f4170c8969a9a`
- Production `SendMessageResponse$DySendMsgResponse.class` SHA-256: `25a994cc6b72a27b52b06fcc4e3f535db912012393fa2ef5aca967e5def8fcac`

The application repository's `origin/api` JAR and the captured production JAR are byte-for-byte identical. `PrivateMessageSendScript.class` exists in that JAR, but its Java source is absent from the public application and SDK repositories.

This candidate therefore covers only the matching public `MessageSender` SDK source. It is not a complete CLI source reconstruction or deployable production JAR.
