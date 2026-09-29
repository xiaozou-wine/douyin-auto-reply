package com.dy_web_api.sdk.message.handler;

import java.net.http.HttpHeaders;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;

final class SendResponseClassifierTest {
    private SendResponseClassifierTest() {
    }

    static List<OfflineTestRunner.TestCase> tests() {
        return List.of(
                new OfflineTestRunner.TestCase("classifier-html", SendResponseClassifierTest::classifiesHtml),
                new OfflineTestRunner.TestCase("classifier-json", SendResponseClassifierTest::classifiesJson),
                new OfflineTestRunner.TestCase("classifier-text", SendResponseClassifierTest::classifiesText),
                new OfflineTestRunner.TestCase("classifier-empty", SendResponseClassifierTest::classifiesEmpty),
                new OfflineTestRunner.TestCase("classifier-protobuf", SendResponseClassifierTest::permitsProtobuf)
        );
    }

    private static void classifiesHtml() {
        var result = SendResponseClassifier.classify(
                headers("text/html; charset=utf-8; diagnostic=HEADER_SENTINEL"),
                "  <html>BODY_SENTINEL</html>".getBytes(StandardCharsets.UTF_8)
        );
        OfflineTestRunner.equals("HTML", result.contentType().name());
        OfflineTestRunner.equals("HTML_LIKE", result.magic().name());
        OfflineTestRunner.equals("HTML_BODY", result.reason().name());
        OfflineTestRunner.isFalse(result.permitsProtobuf());
        assertRedacted(result.metadata());
    }

    private static void classifiesJson() {
        var result = SendResponseClassifier.classify(
                headers("application/json; charset=utf-8; diagnostic=HEADER_SENTINEL"),
                " {\"message\":\"BODY_SENTINEL\"}".getBytes(StandardCharsets.UTF_8)
        );
        OfflineTestRunner.equals("JSON", result.contentType().name());
        OfflineTestRunner.equals("JSON_LIKE", result.magic().name());
        OfflineTestRunner.equals("JSON_BODY", result.reason().name());
        OfflineTestRunner.isFalse(result.permitsProtobuf());
        assertRedacted(result.metadata());
    }

    private static void classifiesText() {
        var result = SendResponseClassifier.classify(
                headers("text/plain; charset=utf-8; diagnostic=HEADER_SENTINEL"),
                "BODY_SENTINEL".getBytes(StandardCharsets.UTF_8)
        );
        OfflineTestRunner.equals("TEXT", result.contentType().name());
        OfflineTestRunner.equals("NON_PROTOBUF_CONTENT_TYPE", result.reason().name());
        OfflineTestRunner.isFalse(result.permitsProtobuf());
        assertRedacted(result.metadata());
    }

    private static void classifiesEmpty() {
        var result = SendResponseClassifier.classify(headers("application/x-protobuf"), new byte[0]);
        OfflineTestRunner.equals("PROTOBUF", result.contentType().name());
        OfflineTestRunner.equals("EMPTY", result.magic().name());
        OfflineTestRunner.equals("EMPTY_BODY", result.reason().name());
        OfflineTestRunner.isFalse(result.permitsProtobuf());
    }

    private static void permitsProtobuf() {
        var result = SendResponseClassifier.classify(
                headers("application/x-protobuf"),
                new byte[]{8, 1}
        );
        OfflineTestRunner.equals("PROTOBUF", result.contentType().name());
        OfflineTestRunner.equals("BINARY_OR_UNKNOWN", result.magic().name());
        OfflineTestRunner.equals("PARSE_PERMITTED", result.reason().name());
        OfflineTestRunner.isTrue(result.permitsProtobuf());
    }

    private static HttpHeaders headers(String contentType) {
        return HttpHeaders.of(Map.of("content-type", List.of(contentType)), (name, value) -> true);
    }

    private static void assertRedacted(String value) {
        OfflineTestRunner.notContains(value, "BODY_SENTINEL");
        OfflineTestRunner.notContains(value, "HEADER_SENTINEL");
        OfflineTestRunner.notContains(value, "text/html");
        OfflineTestRunner.notContains(value, "application/json");
    }
}
