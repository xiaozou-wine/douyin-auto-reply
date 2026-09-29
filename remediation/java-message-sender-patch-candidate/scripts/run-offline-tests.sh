#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
: "${PRODUCTION_JAR:?Set PRODUCTION_JAR to the verified production JAR path}"

PRODUCTION_JAR="$PRODUCTION_JAR" bash "$ROOT/scripts/prepare-offline-classpath.sh"

cd "$ROOT"
MAIN_CP="build/production-classes/BOOT-INF/classes;build/lib/*"

# Compile the patched full source to prove API/source compatibility. The exact
# production artifact excludes Lombok, so provide a local annotation stub and
# rely on the production MessageSender.class for Lombok's generated logger.
mkdir -p build/test-stubs/lombok/extern/slf4j build/test-stubs/com/dy_web_api/sdk/message/handler
cat > build/test-stubs/lombok/extern/slf4j/Slf4j.java <<'JAVA'
package lombok.extern.slf4j;
import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;
@Retention(RetentionPolicy.SOURCE)
@Target(ElementType.TYPE)
public @interface Slf4j {}
JAVA

python - <<'PY'
from pathlib import Path
source = Path('src/main/java/com/dy_web_api/sdk/message/handler/MessageSender.java').read_text(encoding='utf-8')
method_start = source.index('    static SendMessageResponse.DySendMsgResponse parseHttp200SendResponse(')
method_end = source.index('\n    public Map<String,Object> createConversation', method_start)
methods = source[method_start:method_end]
wrapper = '''package com.dy_web_api.sdk.message.handler;\n\nimport com.alibaba.fastjson2.JSON;\nimport com.alibaba.fastjson2.JSONObject;\nimport com.dy_web_api.sdk.message.exception.DouyinMessageException;\nimport com.dy_web_api.sdk.message.exception.ErrorCode;\nimport com.dy_web_api.sdk.message.protobuf.SendMessageResponse;\nimport java.net.http.HttpResponse;\n\nfinal class MessageSender {\n    private static final org.slf4j.Logger log = org.slf4j.LoggerFactory.getLogger(MessageSender.class);\n''' + methods + '\n}\n'
Path('build/test-stubs/com/dy_web_api/sdk/message/handler/MessageSender.java').write_text(wrapper, encoding='utf-8')
PY

# Lombok would generate this field in a normal Maven build. Add it only to an
# ephemeral compilation copy so the tracked patch stays limited to behavior.
python - <<'PY'
from pathlib import Path
source = Path('src/main/java/com/dy_web_api/sdk/message/handler/MessageSender.java').read_text(encoding='utf-8')
source = source.replace(
    'public class MessageSender {\n',
    'public class MessageSender {\n    private static final org.slf4j.Logger log = org.slf4j.LoggerFactory.getLogger(MessageSender.class);\n',
    1,
)
Path('build/test-stubs/MessageSender.java').write_text(source, encoding='utf-8')
PY

javac --release 17 -encoding UTF-8 -implicit:none \
  -cp "$MAIN_CP" \
  -d build/classes/main \
  build/test-stubs/lombok/extern/slf4j/Slf4j.java \
  src/main/java/com/dy_web_api/sdk/message/handler/SendResponseClassifier.java \
  src/main/java/com/dy_web_api/sdk/message/handler/SendResponseDiagnostics.java \
  build/test-stubs/MessageSender.java

# Compile a seam-only test class so offline tests do not depend on Lombok code
# generation and cannot instantiate or invoke the transport implementation.
javac --release 17 -encoding UTF-8 -implicit:none \
  -cp "$MAIN_CP" \
  -d build/classes/main \
  src/main/java/com/dy_web_api/sdk/message/handler/SendResponseClassifier.java \
  src/main/java/com/dy_web_api/sdk/message/handler/SendResponseDiagnostics.java \
  build/test-stubs/com/dy_web_api/sdk/message/handler/MessageSender.java

TEST_CP="build/classes/main;build/production-classes/BOOT-INF/classes;build/lib/*"
javac --release 17 -encoding UTF-8 -implicit:none \
  -cp "$TEST_CP" \
  -d build/classes/test \
  src/test/java/com/dy_web_api/sdk/message/handler/OfflineTestRunner.java \
  src/test/java/com/dy_web_api/sdk/message/handler/SendResponseClassifierTest.java \
  src/test/java/com/dy_web_api/sdk/message/handler/MessageSenderResponseParsingTest.java \
  src/test/java/com/dy_web_api/sdk/message/handler/SendResponseDiagnosticsTest.java

java -ea \
  -Ddouyin.send.diag.path=build/send-response-detail.log \
  -cp "build/classes/test;build/classes/main;build/production-classes/BOOT-INF/classes;build/lib/*" \
  com.dy_web_api.sdk.message.handler.OfflineTestRunner
