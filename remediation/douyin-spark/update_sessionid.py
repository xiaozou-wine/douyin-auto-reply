"""
只更新 .env 中 SESSIONID_<user_id> 一行为新值，其余内容原样保留。
新值从环境变量 NEW_SESSIONID 读取，不回显。先备份 .env 再原子替换。
用法：NEW_SESSIONID=xxx python3 update_sessionid.py
"""
import os
import shutil
import time

USER_ID = os.getenv("DOUYIN_USER_ID", "").strip()
ENV_PATH = ".env"
KEY = f"SESSIONID_{USER_ID}"


def main():
    if not USER_ID:
        print("ERROR: DOUYIN_USER_ID not set in environment")
        return

    new_sessionid = os.environ.get("NEW_SESSIONID", "").strip()
    if not new_sessionid:
        print("ERROR: NEW_SESSIONID not set")
        return

    with open(ENV_PATH, encoding="utf-8") as f:
        lines = f.readlines()

    # 备份
    ts = time.strftime("%Y%m%d_%H%M%S")
    backup = f"{ENV_PATH}.bak.{ts}"
    shutil.copy2(ENV_PATH, backup)

    found = False
    changed = False
    out = []
    for line in lines:
        if line.strip().startswith(f"{KEY}="):
            found = True
            old_val = line.split("=", 1)[1].strip()
            if old_val == new_sessionid:
                print("NO_CHANGE: sessionid already up to date")
                out.append(line)
            else:
                out.append(f"{KEY}={new_sessionid}\n")
                changed = True
        else:
            out.append(line)

    if not found:
        print(f"ERROR: {KEY} not found in {ENV_PATH}")
        return

    if not changed:
        return

    # 原子写
    tmp = ENV_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.writelines(out)
    os.chmod(tmp, 0o600)
    os.replace(tmp, ENV_PATH)
    print(f"UPDATED: {KEY} replaced, backup={backup}")


if __name__ == "__main__":
    main()
