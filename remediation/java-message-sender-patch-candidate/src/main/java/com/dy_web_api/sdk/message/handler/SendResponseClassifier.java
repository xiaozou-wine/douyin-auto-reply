package com.dy_web_api.sdk.message.handler;

import java.net.http.HttpHeaders;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

final class SendResponseClassifier {
    enum ContentTypeCategory {
        PROTOBUF,
        BINARY,
        JSON,
        HTML,
        TEXT,
        MISSING,
        OTHER
    }

    enum MagicCategory {
        EMPTY,
        HTML_LIKE,
        JSON_LIKE,
        BINARY_OR_UNKNOWN
    }

    enum Reason {
        PARSE_PERMITTED,
        EMPTY_BODY,
        HTML_BODY,
        JSON_BODY,
        NON_PROTOBUF_CONTENT_TYPE,
        MALFORMED_PROTOBUF,
        REMOTE_APPLICATION_FAILURE
    }

    record Assessment(
            ContentTypeCategory contentType,
            int byteLength,
            MagicCategory magic,
            Reason reason,
            boolean permitsProtobuf
    ) {
        String metadata() {
            return metadata("PRE_PARSE", reason);
        }

        String metadata(String stage, Reason safeReason) {
            return "send-response"
                    + " stage=" + stage
                    + " reason=" + safeReason
                    + " contentType=" + contentType
                    + " byteLength=" + byteLength
                    + " magic=" + magic;
        }
    }

    private SendResponseClassifier() {
    }

    static Assessment classify(HttpHeaders headers, byte[] body) {
        byte[] safeBody = body == null ? new byte[0] : body;
        ContentTypeCategory contentType = classifyContentType(
                headers == null ? null : headers.firstValue("content-type").orElse(null)
        );
        MagicCategory magic = classifyMagic(safeBody);

        if (magic == MagicCategory.EMPTY) {
            return new Assessment(contentType, 0, magic, Reason.EMPTY_BODY, false);
        }
        if (magic == MagicCategory.HTML_LIKE) {
            return new Assessment(contentType, safeBody.length, magic, Reason.HTML_BODY, false);
        }
        if (magic == MagicCategory.JSON_LIKE) {
            return new Assessment(contentType, safeBody.length, magic, Reason.JSON_BODY, false);
        }
        if (!isProtobufCompatible(contentType)) {
            return new Assessment(
                    contentType,
                    safeBody.length,
                    magic,
                    Reason.NON_PROTOBUF_CONTENT_TYPE,
                    false
            );
        }
        return new Assessment(contentType, safeBody.length, magic, Reason.PARSE_PERMITTED, true);
    }

    private static ContentTypeCategory classifyContentType(String rawContentType) {
        if (rawContentType == null || rawContentType.isBlank()) {
            return ContentTypeCategory.MISSING;
        }
        String mediaType = rawContentType.split(";", 2)[0].trim().toLowerCase(Locale.ROOT);
        if (mediaType.equals("application/x-protobuf")
                || mediaType.equals("application/protobuf")
                || mediaType.endsWith("+protobuf")) {
            return ContentTypeCategory.PROTOBUF;
        }
        if (mediaType.equals("application/octet-stream")) {
            return ContentTypeCategory.BINARY;
        }
        if (mediaType.equals("application/json") || mediaType.endsWith("+json")) {
            return ContentTypeCategory.JSON;
        }
        if (mediaType.equals("text/html") || mediaType.equals("application/xhtml+xml")) {
            return ContentTypeCategory.HTML;
        }
        if (mediaType.startsWith("text/")) {
            return ContentTypeCategory.TEXT;
        }
        return ContentTypeCategory.OTHER;
    }

    private static MagicCategory classifyMagic(byte[] body) {
        int index = 0;
        while (index < body.length && Character.isWhitespace(body[index] & 0xff)) {
            index++;
        }
        if (index == body.length) {
            return MagicCategory.EMPTY;
        }
        int first = body[index] & 0xff;
        if (first == '<') {
            return MagicCategory.HTML_LIKE;
        }
        if (first == '{' || first == '[') {
            return MagicCategory.JSON_LIKE;
        }
        return MagicCategory.BINARY_OR_UNKNOWN;
    }

    private static boolean isProtobufCompatible(ContentTypeCategory contentType) {
        return contentType == ContentTypeCategory.PROTOBUF
                || contentType == ContentTypeCategory.BINARY
                || contentType == ContentTypeCategory.MISSING;
    }
}
