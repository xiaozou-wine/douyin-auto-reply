package com.dy_web_api.sdk.message.handler;

import java.io.IOException;
import java.net.http.HttpHeaders;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.Arrays;
import java.util.Base64;
import java.util.List;
import java.util.Optional;

/**
 * 发送响应取证，仅在 HTTP 200 但响应解析失败时启用。
 *
 * 摘要（进 app.log）只含元数据，绝不含响应体原文。
 * 详情（含响应体原文）写入单独文件，便于事后分析；set-cookie 等凭据头已脱敏。
 *
 * 诊断是尽力而为：任何写入失败都不得影响发送流程本身。
 */
final class SendResponseDiagnostics {
    /** 系统属性，覆盖详情文件路径；默认 logs/send-response-detail.log（相对进程工作目录）。 */
    static final String DETAIL_PATH_PROPERTY = "douyin.send.diag.path";

    private static final String DEFAULT_DETAIL_PATH = "logs/send-response-detail.log";
    private static final int HEX_PREFIX_BYTES = 32;
    private static final int DETAIL_TEXT_LIMIT = 8192;
    private static final int DETAIL_BODY_LIMIT = 65536;
    private static final long DETAIL_ROTATE_BYTES = 2L * 1024 * 1024;

    private static final List<String> REPORTED_HEADERS = List.of(
            "content-type", "content-encoding", "content-length", "transfer-encoding",
            "content-range", "vary", "server", "x-tt-logid", "x-request-id", "date", "connection"
    );
    private static final List<String> SENSITIVE_HEADERS = List.of(
            "set-cookie", "cookie", "authorization", "proxy-authorization"
    );

    private SendResponseDiagnostics() {
    }

    /**
     * 生成可进日志的脱敏摘要，并把完整详情追加到详情文件。
     *
     * @return 单行摘要，含字节数、声明长度、编码、哈希与首个 protobuf 键
     */
    static String capture(HttpResponse<byte[]> response) {
        byte[] body = response == null || response.body() == null ? new byte[0] : response.body();
        HttpHeaders headers = response == null ? null : response.headers();

        StringBuilder summary = new StringBuilder("send-response-diag");
        summary.append(" bytes=").append(body.length);

        long declared = parseDeclaredLength(firstHeader(headers, "content-length"));
        if (declared < 0) {
            summary.append(" declared=absent lengthMatch=unknown");
        } else {
            summary.append(" declared=").append(declared);
            summary.append(" lengthMatch=").append(declared == body.length);
        }

        summary.append(" contentEncoding=").append(describeEncoding(headers));
        summary.append(" gzip=").append(isGzip(body));
        summary.append(" sha256=").append(sha256Prefix(body));

        if (body.length == 0) {
            summary.append(" firstKey=none field=- wire=-");
        } else {
            int key = body[0] & 0xff;
            summary.append(" firstKey=0x").append(String.format("%02x", key));
            summary.append(" field=").append(key >>> 3);
            summary.append(" wire=").append(key & 0x07);
        }

        int prefixLength = Math.min(HEX_PREFIX_BYTES, body.length);
        summary.append(" hexPrefixBytes=").append(prefixLength);
        summary.append(" hex=").append(hexPrefix(body, prefixLength));

        writeDetail(response, body);
        return summary.toString();
    }

    /**
     * 记录"解析成功但服务端拒绝"的响应。
     *
     * 这条路径 2026-09-25 复现：body 是合法 protobuf，但 statusMessage != "OK"，
     * 而 JAR 原本只抛异常、不记录内容，导致拒绝原因一直不可见。
     *
     * @return 单行摘要，含 statusCode 与 statusMessage 的脱敏表示
     */
    static String recordParsedRejection(
            com.dy_web_api.sdk.message.protobuf.SendMessageResponse.DySendMsgResponse parsed
    ) {
        int statusCode = parsed.getStatusCode();
        String statusMessage = parsed.getStatusMessage();
        String extraInfo = null;
        try {
            extraInfo = parsed.getMessageData().getMessageInfo().getExtraInfo();
        } catch (RuntimeException ignored) {
            // messageData 可能未设置，不影响主摘要
        }

        String summary = "send-response-diag stage=POST_PARSE"
                + " statusCode=" + statusCode
                + " statusMessage=" + describeStatusMessage(statusMessage)
                + " statusMessageLen=" + (statusMessage == null ? 0 : statusMessage.length())
                + " extraInfoPresent=" + (extraInfo != null && !extraInfo.isEmpty());

        appendDetail(summary + "\n  statusMessageText=" + safeText(statusMessage)
                + "\n  extraInfoText=" + safeText(extraInfo) + "\n");
        return summary;
    }

    /** 记录 extra_info.status_code 非零导致的拒绝，只暴露状态码与结构，不含原文。 */
    static void recordExtraInfoRejection(String extraInfo, int statusCode) {
        appendDetail("send-response-diag stage=POST_PARSE reason=EXTRA_INFO_STATUS"
                + " extraStatusCode=" + statusCode
                + " extraInfoLen=" + (extraInfo == null ? 0 : extraInfo.length()) + "\n"
                + "  extraInfoText=" + safeText(extraInfo) + "\n");
    }

    private static String describeStatusMessage(String statusMessage) {
        if (statusMessage == null || statusMessage.isEmpty()) {
            return "<empty>";
        }
        // 摘要里不放原文，避免服务端把请求内容回显进日志
        return "present";
    }

    private static String safeText(String value) {
        if (value == null || value.isEmpty()) {
            return "<empty>";
        }
        String trimmed = value.length() <= DETAIL_TEXT_LIMIT
                ? value
                : value.substring(0, DETAIL_TEXT_LIMIT) + "<truncated>";
        return trimmed.replace("\n", "\\n").replace("\r", "");
    }

    private static void appendDetail(String text) {
        try {
            Path target = detailPath();
            rotateIfOversized(target);
            Path parent = target.getParent();
            if (parent != null) {
                Files.createDirectories(parent);
            }
            Files.writeString(target, "=== " + Instant.now() + " ===\n" + text + "\n",
                    StandardCharsets.UTF_8, StandardOpenOption.CREATE, StandardOpenOption.APPEND);
        } catch (Exception ignored) {
            // 诊断写入失败不得影响发送流程
        }
    }

    private static void writeDetail(HttpResponse<byte[]> response, byte[] body) {
        try {
            Path target = detailPath();
            rotateIfOversized(target);
            Path parent = target.getParent();
            if (parent != null) {
                Files.createDirectories(parent);
            }

            StringBuilder detail = new StringBuilder();
            detail.append("=== ").append(Instant.now()).append(" send-response detail ===\n");
            detail.append("status=").append(response == null ? -1 : response.statusCode()).append('\n');
            detail.append("bytes=").append(body.length).append('\n');
            appendHeaders(detail, response == null ? null : response.headers());

            detail.append("--- body text (utf-8, limit ").append(DETAIL_TEXT_LIMIT).append(" chars) ---\n");
            detail.append(textPreview(body));
            detail.append("\n--- body base64 (limit ").append(DETAIL_BODY_LIMIT).append(" bytes) ---\n");
            detail.append(base64Preview(body));
            detail.append("\n--- body hex (limit ").append(DETAIL_BODY_LIMIT).append(" bytes) ---\n");
            detail.append(hexPreview(body));
            detail.append("\n\n");

            Files.writeString(target, detail.toString(), StandardCharsets.UTF_8,
                    StandardOpenOption.CREATE, StandardOpenOption.APPEND);
        } catch (Exception ignored) {
            // 诊断写入失败不得影响发送流程
        }
    }

    private static void appendHeaders(StringBuilder detail, HttpHeaders headers) {
        if (headers == null) {
            return;
        }
        for (String name : REPORTED_HEADERS) {
            Optional<String> value = headers.firstValue(name);
            if (value.isPresent()) {
                detail.append(name).append(": ").append(value.get()).append('\n');
            }
        }
        for (String name : SENSITIVE_HEADERS) {
            if (headers.firstValue(name).isPresent()) {
                detail.append(name).append(": <redacted>\n");
            }
        }
    }

    private static void rotateIfOversized(Path target) throws IOException {
        if (!Files.exists(target) || Files.size(target) < DETAIL_ROTATE_BYTES) {
            return;
        }
        Path rotated = target.resolveSibling(target.getFileName() + ".1");
        Files.move(target, rotated, StandardCopyOption.REPLACE_EXISTING);
    }

    private static Path detailPath() {
        String configured = System.getProperty(DETAIL_PATH_PROPERTY);
        String raw = configured == null || configured.isBlank() ? DEFAULT_DETAIL_PATH : configured;
        return Paths.get(raw);
    }

    private static String describeEncoding(HttpHeaders headers) {
        String encoding = firstHeader(headers, "content-encoding");
        return encoding == null || encoding.isBlank() ? "none" : encoding.trim();
    }

    private static String firstHeader(HttpHeaders headers, String name) {
        if (headers == null) {
            return null;
        }
        return headers.firstValue(name).orElse(null);
    }

    private static long parseDeclaredLength(String raw) {
        if (raw == null || raw.isBlank()) {
            return -1;
        }
        try {
            return Long.parseLong(raw.trim());
        } catch (NumberFormatException invalid) {
            return -1;
        }
    }

    private static boolean isGzip(byte[] body) {
        return body.length >= 2 && (body[0] & 0xff) == 0x1f && (body[1] & 0xff) == 0x8b;
    }

    private static String sha256Prefix(byte[] body) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(body);
            return hexPrefix(digest, 8);
        } catch (Exception unavailable) {
            return "unavailable";
        }
    }

    private static String hexPrefix(byte[] body, int length) {
        StringBuilder hex = new StringBuilder(length * 2);
        for (int i = 0; i < length; i++) {
            hex.append(String.format("%02x", body[i] & 0xff));
        }
        return hex.toString();
    }

    private static String textPreview(byte[] body) {
        String text = new String(body, StandardCharsets.UTF_8);
        if (text.length() <= DETAIL_TEXT_LIMIT) {
            return text;
        }
        return text.substring(0, DETAIL_TEXT_LIMIT) + "\n<truncated>";
    }

    private static String base64Preview(byte[] body) {
        byte[] slice = sliceForDetail(body);
        String encoded = Base64.getEncoder().encodeToString(slice);
        return slice.length == body.length ? encoded : encoded + "\n<truncated>";
    }

    private static String hexPreview(byte[] body) {
        byte[] slice = sliceForDetail(body);
        String hex = hexPrefix(slice, slice.length);
        return slice.length == body.length ? hex : hex + "\n<truncated>";
    }

    private static byte[] sliceForDetail(byte[] body) {
        return body.length <= DETAIL_BODY_LIMIT ? body : Arrays.copyOf(body, DETAIL_BODY_LIMIT);
    }
}
