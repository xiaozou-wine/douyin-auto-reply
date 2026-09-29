package com.dy_web_api.sdk.message.handler;

import javax.net.ssl.SSLSession;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpHeaders;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.stream.Stream;

/**
 * 离线测试：发送响应取证只暴露元数据，不泄漏响应体原文。
 * 全部输入为内存中的合成字节，不发起网络请求，不触发真实发送。
 */
final class SendResponseDiagnosticsTest {
    private SendResponseDiagnosticsTest() {
    }

    static List<OfflineTestRunner.TestCase> tests() {
        return List.of(
                new OfflineTestRunner.TestCase("diag-length-mismatch", SendResponseDiagnosticsTest::detectsLengthMismatch),
                new OfflineTestRunner.TestCase("diag-length-match", SendResponseDiagnosticsTest::acceptsMatchingLength),
                new OfflineTestRunner.TestCase("diag-length-absent", SendResponseDiagnosticsTest::marksAbsentLengthUnknown),
                new OfflineTestRunner.TestCase("diag-content-encoding", SendResponseDiagnosticsTest::reportsContentEncoding),
                new OfflineTestRunner.TestCase("diag-gzip-magic", SendResponseDiagnosticsTest::detectsGzipMagic),
                new OfflineTestRunner.TestCase("diag-hex-prefix-capped", SendResponseDiagnosticsTest::capsHexPrefix),
                new OfflineTestRunner.TestCase("diag-sha256-stable", SendResponseDiagnosticsTest::hashIsStableAndDiscriminating),
                new OfflineTestRunner.TestCase("diag-first-key", SendResponseDiagnosticsTest::reportsFirstProtobufKey),
                new OfflineTestRunner.TestCase("diag-empty-body", SendResponseDiagnosticsTest::handlesEmptyBody),
                new OfflineTestRunner.TestCase("diag-summary-excludes-body-text", SendResponseDiagnosticsTest::summaryExcludesBodyText),
                new OfflineTestRunner.TestCase("diag-detail-file", SendResponseDiagnosticsTest::writesDetailFile),
                new OfflineTestRunner.TestCase("diag-detail-redacts-set-cookie", SendResponseDiagnosticsTest::detailRedactsSetCookie)
        );
    }

    private static void detectsLengthMismatch() {
        byte[] body = new byte[10];
        Map<String, List<String>> headers = new LinkedHashMap<>();
        headers.put("content-type", List.of("application/x-protobuf"));
        headers.put("content-length", List.of("20"));

        String summary = SendResponseDiagnostics.capture(response(headers, body));

        OfflineTestRunner.contains(summary, " bytes=10");
        OfflineTestRunner.contains(summary, " declared=20");
        OfflineTestRunner.contains(summary, " lengthMatch=false");
    }

    private static void acceptsMatchingLength() {
        byte[] body = new byte[10];
        Map<String, List<String>> headers = new LinkedHashMap<>();
        headers.put("content-type", List.of("application/x-protobuf"));
        headers.put("content-length", List.of("10"));

        String summary = SendResponseDiagnostics.capture(response(headers, body));

        OfflineTestRunner.contains(summary, " lengthMatch=true");
    }

    private static void marksAbsentLengthUnknown() {
        byte[] body = new byte[4];
        String summary = SendResponseDiagnostics.capture(response("application/x-protobuf", body));

        OfflineTestRunner.contains(summary, " declared=absent");
        OfflineTestRunner.contains(summary, " lengthMatch=unknown");
    }

    private static void reportsContentEncoding() {
        Map<String, List<String>> headers = new LinkedHashMap<>();
        headers.put("content-type", List.of("application/x-protobuf"));
        headers.put("content-encoding", List.of("gzip"));

        String summary = SendResponseDiagnostics.capture(response(headers, new byte[]{0x0a, 0x00}));

        OfflineTestRunner.contains(summary, " contentEncoding=gzip");
    }

    private static void detectsGzipMagic() {
        byte[] body = {(byte) 0x1f, (byte) 0x8b, 0x08, 0x00};
        String summary = SendResponseDiagnostics.capture(response("application/octet-stream", body));

        OfflineTestRunner.contains(summary, " gzip=true");
        OfflineTestRunner.contains(summary, " firstKey=0x1f");
    }

    private static void capsHexPrefix() {
        byte[] body = new byte[100];
        String summary = SendResponseDiagnostics.capture(response("application/x-protobuf", body));

        OfflineTestRunner.contains(summary, " hexPrefixBytes=32");
        OfflineTestRunner.equals(64, valueOf(summary, "hex=").length());
    }

    private static void hashIsStableAndDiscriminating() {
        String first = valueOf(
                SendResponseDiagnostics.capture(response("application/x-protobuf", new byte[]{0x0a, 0x01, 0x41})),
                "sha256="
        );
        String repeat = valueOf(
                SendResponseDiagnostics.capture(response("application/x-protobuf", new byte[]{0x0a, 0x01, 0x41})),
                "sha256="
        );
        String other = valueOf(
                SendResponseDiagnostics.capture(response("application/x-protobuf", new byte[]{0x0a, 0x01, 0x42})),
                "sha256="
        );

        OfflineTestRunner.equals(first, repeat);
        OfflineTestRunner.equals(16, first.length());
        OfflineTestRunner.isFalse(first.equals(other));
    }

    private static void reportsFirstProtobufKey() {
        // protobuf 键 0x0a = field 1, wire type 2（length-delimited）
        byte[] body = {0x0a, 0x05, 0x4f, 0x4b, 0x00, 0x00, 0x00};
        String summary = SendResponseDiagnostics.capture(response("application/x-protobuf", body));

        OfflineTestRunner.contains(summary, " firstKey=0x0a");
        OfflineTestRunner.contains(summary, " field=1");
        OfflineTestRunner.contains(summary, " wire=2");
    }

    private static void handlesEmptyBody() {
        String summary = SendResponseDiagnostics.capture(response("application/x-protobuf", new byte[0]));

        OfflineTestRunner.contains(summary, " bytes=0");
        OfflineTestRunner.contains(summary, " firstKey=none");
        OfflineTestRunner.contains(summary, " field=-");
        OfflineTestRunner.contains(summary, " wire=-");
    }

    private static void summaryExcludesBodyText() {
        byte[] body = "BODY_SENTINEL".getBytes(StandardCharsets.UTF_8);
        String summary = SendResponseDiagnostics.capture(response("text/plain", body));

        OfflineTestRunner.notContains(summary, "BODY_SENTINEL");
    }

    private static void writesDetailFile() throws Exception {
        Path dir = Files.createTempDirectory("send-diag-test");
        Path target = dir.resolve("nested").resolve("send-diag.log");
        String previous = System.getProperty(SendResponseDiagnostics.DETAIL_PATH_PROPERTY);
        System.setProperty(SendResponseDiagnostics.DETAIL_PATH_PROPERTY, target.toString());
        try {
            byte[] body = "DETAIL_TEXT_SENTINEL".getBytes(StandardCharsets.UTF_8);
            SendResponseDiagnostics.capture(response("application/x-protobuf", body));

            OfflineTestRunner.isTrue(Files.exists(target));
            String detail = Files.readString(target, StandardCharsets.UTF_8);
            OfflineTestRunner.contains(detail, "DETAIL_TEXT_SENTINEL");
            OfflineTestRunner.contains(detail, "application/x-protobuf");
            OfflineTestRunner.contains(detail, "bytes=");
        } finally {
            if (previous == null) {
                System.clearProperty(SendResponseDiagnostics.DETAIL_PATH_PROPERTY);
            } else {
                System.setProperty(SendResponseDiagnostics.DETAIL_PATH_PROPERTY, previous);
            }
            deleteRecursively(dir);
        }
    }

    private static void detailRedactsSetCookie() throws Exception {
        Path dir = Files.createTempDirectory("send-diag-redact");
        Path target = dir.resolve("send-diag.log");
        String previous = System.getProperty(SendResponseDiagnostics.DETAIL_PATH_PROPERTY);
        System.setProperty(SendResponseDiagnostics.DETAIL_PATH_PROPERTY, target.toString());
        try {
            Map<String, List<String>> headers = new LinkedHashMap<>();
            headers.put("content-type", List.of("application/x-protobuf"));
            headers.put("set-cookie", List.of("COOKIE_SENTINEL=abc; Path=/"));

            SendResponseDiagnostics.capture(response(headers, new byte[]{0x0a, 0x00}));

            String detail = Files.readString(target, StandardCharsets.UTF_8);
            OfflineTestRunner.notContains(detail, "COOKIE_SENTINEL");
            OfflineTestRunner.contains(detail, "<redacted");
        } finally {
            if (previous == null) {
                System.clearProperty(SendResponseDiagnostics.DETAIL_PATH_PROPERTY);
            } else {
                System.setProperty(SendResponseDiagnostics.DETAIL_PATH_PROPERTY, previous);
            }
            deleteRecursively(dir);
        }
    }

    private static void deleteRecursively(Path root) throws Exception {
        if (!Files.exists(root)) {
            return;
        }
        try (Stream<Path> paths = Files.walk(root)) {
            for (Path path : paths.sorted(Comparator.reverseOrder()).toList()) {
                Files.deleteIfExists(path);
            }
        }
    }

    private static String valueOf(String summary, String key) {
        int start = summary.indexOf(" " + key);
        if (start < 0) {
            throw new AssertionError("missing key " + key);
        }
        start += key.length() + 1;
        int end = summary.indexOf(' ', start);
        return end < 0 ? summary.substring(start) : summary.substring(start, end);
    }

    private static HttpResponse<byte[]> response(String contentType, byte[] body) {
        Map<String, List<String>> headers = new LinkedHashMap<>();
        headers.put("content-type", List.of(contentType));
        return response(headers, body);
    }

    private static HttpResponse<byte[]> response(Map<String, List<String>> headers, byte[] body) {
        HttpHeaders httpHeaders = HttpHeaders.of(headers, (name, value) -> true);
        return new StubResponse(httpHeaders, body);
    }

    private record StubResponse(HttpHeaders headers, byte[] body) implements HttpResponse<byte[]> {
        @Override
        public int statusCode() {
            return 200;
        }

        @Override
        public HttpRequest request() {
            return HttpRequest.newBuilder(URI.create("https://example.invalid/offline")).build();
        }

        @Override
        public Optional<HttpResponse<byte[]>> previousResponse() {
            return Optional.empty();
        }

        @Override
        public Optional<SSLSession> sslSession() {
            return Optional.empty();
        }

        @Override
        public URI uri() {
            return URI.create("https://example.invalid/offline");
        }

        @Override
        public HttpClient.Version version() {
            return HttpClient.Version.HTTP_2;
        }
    }
}
