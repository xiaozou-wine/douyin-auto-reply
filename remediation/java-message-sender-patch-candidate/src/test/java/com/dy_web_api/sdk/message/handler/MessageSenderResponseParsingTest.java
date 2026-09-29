package com.dy_web_api.sdk.message.handler;

import com.dy_web_api.sdk.message.exception.DouyinMessageException;
import com.dy_web_api.sdk.message.protobuf.SendMessageResponse;

import javax.net.ssl.SSLSession;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpHeaders;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.Optional;

final class MessageSenderResponseParsingTest {
    private MessageSenderResponseParsingTest() {
    }

    static List<OfflineTestRunner.TestCase> tests() {
        return List.of(
                new OfflineTestRunner.TestCase("sender-html", MessageSenderResponseParsingTest::rejectsHtml),
                new OfflineTestRunner.TestCase("sender-json", MessageSenderResponseParsingTest::rejectsJson),
                new OfflineTestRunner.TestCase("sender-text", MessageSenderResponseParsingTest::rejectsText),
                new OfflineTestRunner.TestCase("sender-empty", MessageSenderResponseParsingTest::rejectsEmpty),
                new OfflineTestRunner.TestCase("sender-truncated", MessageSenderResponseParsingTest::rejectsTruncated),
                new OfflineTestRunner.TestCase("sender-valid", MessageSenderResponseParsingTest::parsesValid),
                new OfflineTestRunner.TestCase("sender-remote-failure", MessageSenderResponseParsingTest::redactsRemoteFailure),
                new OfflineTestRunner.TestCase("sender-extra-failure", MessageSenderResponseParsingTest::redactsExtraInfoFailure)
        );
    }

    private static void rejectsHtml() {
        assertFailure(
                response("text/html; diagnostic=HEADER_SENTINEL", "<html>BODY_SENTINEL</html>".getBytes(StandardCharsets.UTF_8)),
                "stage=PRE_PARSE",
                "reason=HTML_BODY"
        );
    }

    private static void rejectsJson() {
        assertFailure(
                response("application/json; diagnostic=HEADER_SENTINEL", "{\"x\":\"BODY_SENTINEL\"}".getBytes(StandardCharsets.UTF_8)),
                "stage=PRE_PARSE",
                "reason=JSON_BODY"
        );
    }

    private static void rejectsText() {
        assertFailure(
                response("text/plain; diagnostic=HEADER_SENTINEL", "BODY_SENTINEL".getBytes(StandardCharsets.UTF_8)),
                "stage=PRE_PARSE",
                "reason=NON_PROTOBUF_CONTENT_TYPE"
        );
    }

    private static void rejectsEmpty() {
        assertFailure(
                response("application/x-protobuf", new byte[0]),
                "stage=PRE_PARSE",
                "reason=EMPTY_BODY"
        );
    }

    private static void rejectsTruncated() {
        byte[] valid = SendMessageResponse.DySendMsgResponse.newBuilder()
                .setStatusMessage("BODY_SENTINEL")
                .build()
                .toByteArray();
        byte[] truncated = Arrays.copyOf(valid, valid.length - 1);
        assertFailure(
                response("application/x-protobuf", truncated),
                "stage=PROTOBUF_PARSE",
                "reason=MALFORMED_PROTOBUF"
        );
    }

    private static void parsesValid() {
        byte[] valid = SendMessageResponse.DySendMsgResponse.newBuilder()
                .setStatusCode(0)
                .setStatusMessage("OK")
                .build()
                .toByteArray();
        var parsed = MessageSender.parseHttp200SendResponse(
                response("application/x-protobuf", valid)
        );
        OfflineTestRunner.equals(0, parsed.getStatusCode());
    }

    private static void redactsRemoteFailure() {
        byte[] failure = SendMessageResponse.DySendMsgResponse.newBuilder()
                .setStatusCode(1)
                .setStatusMessage("BODY_SENTINEL")
                .build()
                .toByteArray();
        assertFailure(
                response("application/x-protobuf; diagnostic=HEADER_SENTINEL", failure),
                "stage=POST_PARSE",
                "reason=REMOTE_APPLICATION_FAILURE"
        );
    }

    private static void redactsExtraInfoFailure() {
        var messageInfo = SendMessageResponse.MessageInfo.newBuilder()
                .setExtraInfo("{\"status_code\":9001,\"status_msg\":{\"message\":\"BODY_SENTINEL\"}}")
                .build();
        var messageData = SendMessageResponse.MessageData.newBuilder()
                .setMessageInfo(messageInfo)
                .build();
        byte[] failure = SendMessageResponse.DySendMsgResponse.newBuilder()
                .setStatusCode(0)
                .setStatusMessage("OK")
                .setMessageData(messageData)
                .build()
                .toByteArray();

        var parsed = MessageSender.parseHttp200SendResponse(
                response("application/x-protobuf; diagnostic=HEADER_SENTINEL", failure)
        );
        try {
            MessageSender.validateParsedSendResponse(parsed, SendResponseClassifier.classify(
                    response("application/x-protobuf", failure).headers(),
                    failure
            ));
            throw new AssertionError("expected failure");
        } catch (DouyinMessageException error) {
            String message = error.getMessage();
            OfflineTestRunner.contains(message, "stage=POST_PARSE");
            OfflineTestRunner.contains(message, "reason=REMOTE_APPLICATION_FAILURE");
            OfflineTestRunner.notContains(message, "BODY_SENTINEL");
            OfflineTestRunner.notContains(message, "9001");
        }
    }

    private static void assertFailure(
            HttpResponse<byte[]> response,
            String expectedStage,
            String expectedReason
    ) {
        try {
            MessageSender.parseHttp200SendResponse(response);
            throw new AssertionError("expected failure");
        } catch (DouyinMessageException failure) {
            String message = failure.getMessage();
            OfflineTestRunner.contains(message, expectedStage);
            OfflineTestRunner.contains(message, expectedReason);
            OfflineTestRunner.contains(message, "contentType=");
            OfflineTestRunner.contains(message, "byteLength=");
            OfflineTestRunner.contains(message, "magic=");
            OfflineTestRunner.notContains(message, "BODY_SENTINEL");
            OfflineTestRunner.notContains(message, "HEADER_SENTINEL");
            OfflineTestRunner.notContains(message, "InvalidProtocolBufferException");
            OfflineTestRunner.notContains(message, "input ended unexpectedly");
            OfflineTestRunner.notContains(message, "application/x-protobuf");
            OfflineTestRunner.notContains(message, "text/html");
            OfflineTestRunner.notContains(message, "application/json");
        }
    }

    private static HttpResponse<byte[]> response(String contentType, byte[] body) {
        HttpHeaders headers = HttpHeaders.of(
                Map.of("content-type", List.of(contentType)),
                (name, value) -> true
        );
        return new StubResponse(headers, body);
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
