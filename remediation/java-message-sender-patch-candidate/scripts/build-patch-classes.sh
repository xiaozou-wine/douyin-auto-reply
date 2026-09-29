#!/usr/bin/env bash
# 构建用于替换生产 JAR 内 BOOT-INF/classes 的补丁 class。
# 输出: build/deploy-classes/ —— 只含被替换的 3 个类及其内部类。
# 不执行生产 JAR，不发起网络请求。
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
: "${PRODUCTION_JAR:?Set PRODUCTION_JAR to the verified production JAR path}"

PRODUCTION_JAR="$PRODUCTION_JAR" bash "$ROOT/scripts/prepare-offline-classpath.sh"

cd "$ROOT"
MAIN_CP="build/production-classes/BOOT-INF/classes;build/lib/*"
HANDLER_DIR="build/deploy-classes/com/dy_web_api/sdk/message/handler"

rm -rf build/deploy-classes build/deploy-src
mkdir -p build/deploy-src/lombok/extern/slf4j "$HANDLER_DIR"

# 生产 JAR 不含 Lombok，提供注解桩
cat > build/deploy-src/lombok/extern/slf4j/Slf4j.java <<'JAVA'
package lombok.extern.slf4j;
import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;
@Retention(RetentionPolicy.SOURCE)
@Target(ElementType.TYPE)
public @interface Slf4j {}
JAVA

# Lombok 在正常 Maven 构建中会生成该 logger 字段，这里显式注入
python - <<'PY'
from pathlib import Path
source = Path('src/main/java/com/dy_web_api/sdk/message/handler/MessageSender.java').read_text(encoding='utf-8')
needle = 'public class MessageSender {\n'
if needle not in source:
    raise SystemExit('MessageSender class declaration not found')
source = source.replace(
    needle,
    needle + '    private static final org.slf4j.Logger log = org.slf4j.LoggerFactory.getLogger(MessageSender.class);\n',
    1,
)
Path('build/deploy-src/MessageSender.java').write_text(source, encoding='utf-8')
PY

javac --release 17 -encoding UTF-8 -implicit:none \
  -cp "$MAIN_CP" \
  -d build/deploy-classes \
  build/deploy-src/lombok/extern/slf4j/Slf4j.java \
  src/main/java/com/dy_web_api/sdk/message/handler/SendResponseClassifier.java \
  src/main/java/com/dy_web_api/sdk/message/handler/SendResponseDiagnostics.java \
  build/deploy-src/MessageSender.java

# 防呆：缝测试桩曾产出过 ~4KB 的残缺 MessageSender，部署前必须拦住
SENDER_BYTES=$(wc -c < "$HANDLER_DIR/MessageSender.class")
if [[ "$SENDER_BYTES" -lt 20000 ]]; then
  printf 'MessageSender.class 体积异常 (%s bytes)，疑似编译产物不完整\n' "$SENDER_BYTES" >&2
  exit 1
fi

printf 'deploy_classes_built=true sender_bytes=%s\n' "$SENDER_BYTES"
find build/deploy-classes -name '*.class' -printf '  %P\n' | sort
