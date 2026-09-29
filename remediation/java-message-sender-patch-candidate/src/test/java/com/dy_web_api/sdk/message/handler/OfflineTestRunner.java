package com.dy_web_api.sdk.message.handler;

import java.util.ArrayList;
import java.util.List;

final class OfflineTestRunner {
    record TestCase(String name, ThrowingRunnable body) {
    }

    @FunctionalInterface
    interface ThrowingRunnable {
        void run() throws Exception;
    }

    private OfflineTestRunner() {
    }

    public static void main(String[] args) throws Exception {
        List<TestCase> tests = new ArrayList<>();
        tests.addAll(SendResponseClassifierTest.tests());
        tests.addAll(loadOptionalTests());

        int passed = 0;
        for (TestCase test : tests) {
            try {
                test.body().run();
                passed++;
                System.out.println("PASS " + test.name());
            } catch (Throwable failure) {
                System.err.println("FAIL " + test.name());
                throw failure;
            }
        }
        System.out.println("PASS " + passed + " tests");
    }

    static void equals(Object expected, Object actual) {
        if (!java.util.Objects.equals(expected, actual)) {
            throw new AssertionError("values differ");
        }
    }

    static void isTrue(boolean value) {
        if (!value) {
            throw new AssertionError("expected true");
        }
    }

    static void isFalse(boolean value) {
        if (value) {
            throw new AssertionError("expected false");
        }
    }

    static void contains(String value, String fragment) {
        if (value == null || !value.contains(fragment)) {
            throw new AssertionError("missing expected fragment");
        }
    }

    static void notContains(String value, String fragment) {
        if (value != null && value.contains(fragment)) {
            throw new AssertionError("contained forbidden fragment");
        }
    }

    private static final List<String> OPTIONAL_TEST_CLASSES = List.of(
            "com.dy_web_api.sdk.message.handler.MessageSenderResponseParsingTest",
            "com.dy_web_api.sdk.message.handler.SendResponseDiagnosticsTest"
    );

    @SuppressWarnings("unchecked")
    private static List<TestCase> loadOptionalTests() throws Exception {
        List<TestCase> loaded = new ArrayList<>();
        for (String className : OPTIONAL_TEST_CLASSES) {
            try {
                Class<?> type = Class.forName(className);
                var method = type.getDeclaredMethod("tests");
                method.setAccessible(true);
                loaded.addAll((List<TestCase>) method.invoke(null));
            } catch (ClassNotFoundException ignored) {
                // 该编译轮次未包含这个可选测试类
            }
        }
        return loaded;
    }
}
