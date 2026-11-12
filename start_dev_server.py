# -*- coding: utf-8 -*-
"""
start_dev_server.py - 用本仓库源码起 opencode2 serve, 并抓 CPU profile

放在仓库根目录运行: python start_dev_server.py(或用 --repo 指向别的工作树)

为什么不是直接 profile 编译出来的 opencode2.exe:
  编译后的 Bun 二进制会静默忽略命令行上的 --cpu-prof / --inspect, 采不到;
  但源码跑 bun 时这两者都正常。所以这里用 packages/cli/src/index.ts 起同参数的服务。

采样怎么做:
  用 `bun --preload <hook>` 把 node:inspector 的 Profiler 注入 serve 进程, 通过
  一个控制文件(start/stop/exit)驱动。好处是采多少秒由这里决定, 进程不用退出,
  也不依赖 Ctrl+C / 信号 —— taskkill /f 是拿不到 --cpu-prof 的落盘时机的。

流程:
  1. 先中断该端口上的 running 会话, 再结束占端口的 serve;
  2. bun --smol --preload <hook> --tsconfig-override packages/cli/tsconfig.json <abs>/src/index.ts serve ...
     一律摘掉代理变量直连, cwd 用下面 resolve_start_dir() 的固定目录;
  3. 等端口 LISTEN; 你到 TUI 里复现问题, 回车开始采样 N 秒;
  4. 产出 <out-dir>/serve-<时间戳>.cpuprofile + 同名 .md(热点表, 直接看);
  5. 结束后可用 --restore-cmd 交给调用方的启动器去恢复真服务(不给就只提示)。

自包含(重要):
  本脚本不 import 任何仓库外的东西, 只依赖 psutil 这个第三方包。会话中断 / 启动目录 /
  代理策略全部在下面自己实现: 曾经为了"避免两处参数漂移"去 import startopencode.py,
  结果是它被移走或换盘符后静默退回兜底(而兜底恰好塞了代理), 排查成本远大于重复几十行。

注意:
  * 这是源码运行, 没有编译产物的字节码; 但 --smol 与 build.ts 的 execArgv 一致。
    若源码里定位到的热点在编译产物上怀疑不同, 再按"把 --cpu-prof 烧进 execArgv"的办法复核。
  * **--interval 低于 1000µs 会让 serve 永久丢一个核**。Bun 1.4.3 上实测:
    Profiler.setSamplingInterval(<=500) + start/stop 之后, 有一个 native 线程一直空转,
    CPU 稳定在 98~100% 一个核, 直到进程重启; 1000µs(默认) 残留约 6%, 不采样时是 0%。
    这个空转不进 JS, 所以 cpuprofile 里看不到。要低间隔采样, 采完就把 serve 重启,
    别用 --keep 留着继续跑。
  * 采样期间跑的就是你那套 serve(同端口/同 cwd, 都不走代理), TUI 会自动连上(默认 --service)。
  * 控制文件写在 <out-dir>/serve-<时间戳>.control, 想手动补采可以 `echo start >` 它。

channel / version(踩过的坑):
  源码运行时 OPENCODE_CHANNEL / OPENCODE_VERSION 这两个"编译期常量"不存在, 会退化成 local, 于是
    - 数据库变成 opencode-local.db          -> 原来的 session 全部看不见
    - service 注册/配置变成 service-local.json -> 密码是新生成的, 客户端拿旧密码 401, 提示需要新密码
  所以这里: 通道固定 latest(需要别的通道用 --channel 覆盖), 从 `opencode2 --version` 读版本, 用 preload 补到
  globalThis 上, 让源码服务的 DB / 注册文件 / 密码 / 版本与编译产物完全一致。
  想换一份数据库(比如拷一份再采)就直接设 OPENCODE_DB 环境变量, 脚本会原样透传。

用法:
  python start_dev_server.py
  python start_dev_server.py --port 4599 --no-service --auto --seconds 5
  python start_dev_server.py --keep          # 采完别停, 留在前台继续用
  python start_dev_server.py --disableprofile  # 散包性能模式(不采样)
  python start_dev_server.py --restore-cmd "'C:\\cyx\\prog\\py314\\pythonw.exe' D:\\x\\launcher.py"
  python start_dev_server.py --help

性能模式(--disableprofile):
  不采样: 注入的 hook 只剩通道/版本补丁那几行, 不连 inspector(低间隔采样会让 Bun 空转一个核)。
  同样不加 --smol, 默认把 OPENCODE_LOG_LEVEL 压到 WARN, 并丢掉 OTEL_EXPORTER_OTLP_*(不导出 span)。
  注意 --smol 编译产物是带的(build.ts 的 execArgv), 这里去掉意味着"源码+更多内存换吞吐",
  内存占用会比编译产物高, 与编译产物的对照实验仍建议保持采样模式的默认参数。
  其余(端口/通道/版本/service 注册)与采样模式完全一样, 只是没有 profile 产物。

产物看哪里:
  .md     直接读 Hot Functions 表(推荐的入口)
  .cpuprofile 拖进 Chrome DevTools -> Performance -> Load profile, 或 https://speedscope.app
"""
import argparse
import base64
import concurrent.futures
import glob
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

# 本脚本放在仓库根: 用自身位置定位源码, 换工作树/拷到别的 checkout 都不用改
REPO = Path(__file__).resolve().parent
CLI_DIR = REPO / "packages" / "cli"
ENTRY = CLI_DIR / "src" / "index.ts"

# 采样产物目录(临时目录约定)
OUT_DIR = Path(r"C:\cache\tmp\prof")
HOOK = OUT_DIR / "profile-hook.ts"

# 默认值(命令行都能覆盖)
DEFAULT_PORT = 4097
DEFAULT_CORS = ["https://lehhair.github.io"]
DEFAULT_SECONDS = 10
DEFAULT_DELAY = 2

# 统一启动目录: 从 d: 起按字母序找第一个存在的盘符 x, 启动目录即 x:\tmp\opencode_startdir。
# 不给 C 盘: 系统盘上的写入一旦被 UAC/杀软拦, 服务就起不来, 而临时盘上随便建。
START_DIR_LETTERS = "defghijklmnopqrstuvwxyz"
START_DIR_SUFFIX = os.path.join("tmp", "opencode_startdir")

# serve 子进程一律直连: 本机 2080 的代理经常没有可用出站(经它全是 connection reset / 502),
# 而 opencode.ai / models.opencode.ai 直连实测都通, 本地环回(网关 8787、TUI 到 serve)也不受影响。
PROXY_ENV_KEYS = (
    "ALL_PROXY", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
    "all_proxy", "http_proxy", "https_proxy", "no_proxy",
)

# serve --service 的 Basic 认证用户名(server/src/auth.ts 里写死), 密码在 service*.json 里
SERVICE_USERNAME = "opencode"
ABORT_TIMEOUT = 3
ABORT_WORKERS = 8


HOOK_TS = r'''
// 编译期常量补丁 —— 必须无条件注入, 与采样无关。
// channel / version 在编译产物里是 build.ts 的 define 常量, 源码跑时并不存在, version.ts 的
// `typeof OPENCODE_CHANNEL === "string"` 会退化成 "local": 数据库变成 opencode-local.db
// (看不到原来的 session), service 注册/配置文件变成 service-local.json(密码新生成, 客户端拿旧
// 密码 401), 版本 "local" 又让 TUI 找不到登记而另起一个服务。preload 在入口之前执行, 把这两个
// 常量补到 globalThis, 让源码跑的通道与编译产物完全一致。
// 这段和采样无关: 当初把它塞在采样 hook 里, 于是 --disableprofile(不装 hook)时通道全错。
const channel = process.env.OPENCODE_PROFILE_CHANNEL
const version = process.env.OPENCODE_PROFILE_VERSION
if (channel) (globalThis as any).OPENCODE_CHANNEL = channel
if (version) (globalThis as any).OPENCODE_VERSION = version
'''

PROFILE_TS = r'''
// 采样部分 —— 只有采样模式才追加到上面那段之后(import 会提升, 放在后面也合法)。
// 控制文件内容: start / stop / exit。
import { readFileSync, watch } from "node:fs"
import { Session } from "node:inspector"
import { basename, dirname } from "node:path"

const control = process.env.OPENCODE_PROFILE_CONTROL
const out = process.env.OPENCODE_PROFILE_OUT
const interval = Number(process.env.OPENCODE_PROFILE_INTERVAL || 1000)

const session = new Session()
session.connect()

const post = (method, params) =>
  new Promise((resolve, reject) =>
    session.post(method, params || {}, (error, result) => (error ? reject(error) : resolve(result))),
  )

let capturing = false
let queue = Promise.resolve()
const enqueue = (task) => {
  queue = queue.then(task).catch((error) => console.error("[profile] error:", error))
}

const start = async () => {
  if (capturing) return
  capturing = true
  console.error("[profile] 采样开始")
  await post("Profiler.enable")
  // 采样间隔(微秒); 老版本 inspector 不认就退回默认
  await post("Profiler.setSamplingInterval", { interval }).catch(() => {})
  await post("Profiler.start")
}

const stop = async () => {
  if (!capturing) return
  capturing = false
  const result = await post("Profiler.stop")
  await Bun.write(out, JSON.stringify(result.profile))
  console.error("[profile] 已写入", out)
}

let last = ""
const handle = () => {
  let text = ""
  try {
    text = readFileSync(control, "utf8").trim()
  } catch {
    return
  }
  if (text === last) return
  last = text
  if (text === "start") enqueue(start)
  if (text === "stop") enqueue(stop)
  if (text === "exit") enqueue(async () => process.exit(0))
}

// 用 fs.watch 而不是 setInterval 轮询: 轮询本身会出现在 profile 里(空闲时甚至是最大热点),
// 而且这几行代码就在被采样的进程里。
watch(dirname(control), (_event, filename) => {
  if (filename && filename.toString() !== basename(control)) return
  handle()
})
handle()

console.error("[profile] hook ready ->", out)
'''


def say(message: str = "") -> None:
    print(message, flush=True)


def step(message: str) -> None:
    say(f"[{time.strftime('%H:%M:%S')}] {message}")


def resolve_start_dir() -> str:
    """统一启动目录: 从 d: 起第一个存在的盘符下的 \\tmp\\opencode_startdir, 不存在就建。

    与启动器给真服务用的 cwd 一致: 源码跑和编译产物跑看到同一个 cwd, session 的
    project 归属才不会因为换了 cwd 而变成另一个项目。
    """
    for letter in START_DIR_LETTERS:
        root = f"{letter}:\\"
        if not os.path.exists(root):
            continue
        path = os.path.join(root, START_DIR_SUFFIX)
        try:
            os.makedirs(path, exist_ok=True)
        except OSError as error:
            raise SystemExit(f"建不了启动目录 {path}: {error}")
        return path
    raise SystemExit(f"从 {START_DIR_LETTERS[0]}: 到 {START_DIR_LETTERS[-1]}: 都没有可用盘符")


def serve_env() -> dict:
    """serve 子进程的环境: 摘掉继承来的所有代理变量, 直连。

    代理只在"用得上"的时候才值得设。这台机器上 2080 的 sing-box 经常没有可用出站,
    而 bun 的 fetch 一旦拿到 HTTPS_PROXY 就会把所有外部请求都送进去, 于是 Console 用量
    面板和 models.dev 全变成 "Transport error (...)", 聊天却正常(aigw 走 127.0.0.1:8787
    环回)。与其猜代理什么时候能用, 不如固定直连。
    """
    env = os.environ.copy()
    for key in PROXY_ENV_KEYS:
        env.pop(key, None)
    return env


def split_command(command: str) -> list[str]:
    """把一条命令行拆成 argv(Windows 路径安全)。

    不能用默认的 shlex.split: posix 模式会把 D:\\x 里的反斜杠当转义吃掉, 变成 D:x。
    posix=False 保留反斜杠但把引号留在词里, 所以再剥一层成对的首尾引号。
    """
    return [token[1:-1] if len(token) > 1 and token[0] == token[-1] and token[0] in "\"'" else token
            for token in shlex.split(command, posix=False)]


def listen_root(kind: str) -> Path:
    """XDG 根目录下的 opencode 目录(data / state / config)。"""
    home = Path(os.environ.get("USERPROFILE") or os.path.expanduser("~"))
    default = {
        "data": home / ".local" / "share",
        "state": home / ".local" / "state",
        "config": home / ".config",
    }[kind]
    env = {"data": "XDG_DATA_HOME", "state": "XDG_STATE_HOME", "config": "XDG_CONFIG_HOME"}[kind]
    return Path(os.environ.get(env) or default) / "opencode"


def service_password(port: int) -> str | None:
    """取该端口 serve 的 Basic 密码; 取不到返回 None。

    --service 模式的密码不读 OPENCODE_PASSWORD: server-process.ts 用 service 配置里的 password,
    没有就随机生成并写回, 所以只能从 service*.json 里找。按可靠度:
      1. state 下的 service*.json 带 url, 按端口挑出当前实例;
      2. config 下的 service*.json 只有 password(按 channel 共用), 取最近修改的一份;
      3. 最后才看环境变量(只有非 --service 模式才生效)。
    """
    for path in sorted(glob.glob(str(listen_root("state") / "service*.json")),
                       key=os.path.getmtime, reverse=True):
        info = read_json(path) or {}
        if not info.get("password"):
            continue
        if url_port(str(info.get("url") or "")) == port:
            return str(info["password"])

    configured = [p for p in glob.glob(str(listen_root("config") / "service*.json"))
                  if (read_json(p) or {}).get("password")]
    if configured:
        info = read_json(max(configured, key=os.path.getmtime)) or {}
        if info.get("password"):
            return str(info["password"])

    for key in ("OPENCODE_PASSWORD", "OPENCODE_SERVER_PASSWORD"):
        if os.environ.get(key):
            return os.environ[key]
    return None


def read_json(path: str) -> dict | None:
    """读一个 JSON 对象; 读不到或不是对象就返回 None(文件可能正在被写一半)。"""
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def url_port(url: str) -> int | None:
    """从注册文件的 url 里取端口; 解析失败返回 None。"""
    try:
        return urllib.parse.urlparse(url).port
    except ValueError:
        return None


def abort_sessions(port: int) -> None:
    """把该端口上 running 的会话逐个 interrupt, 让服务端记成 interrupted 而不是被静默杀掉。

    必须带密码: serve 以 --service 模式跑时 /api/* 一律要 Basic 认证, 不带就 401,
    会话会被后面的 taskkill 直接带走, 恢复出来是"半截任务"。
    """
    password = service_password(port)
    if not password:
        step(f"警告: 读不到端口 {port} 的 service 密码, 跳过会话中断(会话会被 taskkill 直接带走)")
        return
    token = base64.b64encode(f"{SERVICE_USERNAME}:{password}".encode("utf-8")).decode("ascii")
    base = f"http://127.0.0.1:{port}"
    headers = {"Authorization": f"Basic {token}"}

    try:
        request = urllib.request.Request(f"{base}/api/session/active", headers=headers)
        with urllib.request.urlopen(request, timeout=ABORT_TIMEOUT) as response:
            active = (json.loads(response.read().decode("utf-8")) or {}).get("data") or {}
    except urllib.error.HTTPError as error:
        step(f"警告: 查询 {port} 的会话失败: {error}, 跳过中断")
        return
    except Exception as error:
        step(f"端口 {port}: 查不到会话({error}), 跳过中断")
        return

    ids = [sid for sid, info in active.items() if isinstance(info, dict) and info.get("type") == "running"]
    if not ids:
        step(f"端口 {port}: 没有 running 会话")
        return

    def interrupt_one(sid: str) -> tuple[str, bool, str]:
        """中断一个会话; 只回结果, 不让单个失败打断同批其它会话。"""
        request = urllib.request.Request(
            f"{base}/api/session/{urllib.parse.quote(sid)}/interrupt",
            data=b"{}",
            headers={"Content-Type": "application/json", **headers},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=ABORT_TIMEOUT) as response:
                return sid, bool((json.loads(response.read().decode("utf-8")) or {}).get("interrupted")), ""
        except Exception as error:
            return sid, False, str(error)

    with concurrent.futures.ThreadPoolExecutor(max_workers=min(len(ids), ABORT_WORKERS)) as pool:
        outcomes = list(pool.map(interrupt_one, ids))
    for sid, ok, detail in outcomes:
        if not ok:
            step(f"中断 {sid} 失败: {detail}")
    step(f"端口 {port}: 已中断 {sum(1 for _, ok, _ in outcomes if ok)}/{len(ids)} 个会话")


def detect_channel() -> str:
    """编译产物用的通道, 固定 latest。

    service.json 存在 == 装了 released 版本(latest/beta/next 共用这一个文件), 而 released 版本里
    latest 是常态; 旧实现把 service.json 一律当成 dev, 于是源码服务落到 dev 通道: 用 opencode-dev.db,
    密码写进 service-dev.json(客户端拿 service.json 的密码 401), 且 channel != local 时 app-assets
    直接报 "Web UI assets are missing from the CLI build"(打开 / 是 500)。
    要跑别的通道(dev / beta / 分支)用 --channel 覆盖。
    """
    return "latest"


def detect_version() -> str | None:
    """读已安装 opencode2 的版本。

    源码服务的注册信息会带上这个版本号; 版本对不上时 TUI 会把我们的服务**换掉**(拉起它自己的
    opencode2 serve), 采样就断了, 所以必须跟客户端报同一个版本。
    """
    for name in ("opencode2", "opencode"):
        executable = shutil.which(name)
        if not executable:
            continue
        try:
            result = subprocess.run([executable, "--version"], capture_output=True, text=True, timeout=20)
        except Exception:
            continue
        match = re.search(r"v(\S+)\s*$", (result.stdout or "").strip())
        if match:
            return match.group(1)
    return None


def expected_db(channel: str) -> Path:
    """按 databasePath() 的规则算出服务会打开的数据库文件。"""
    override = os.environ.get("OPENCODE_DB")
    if override:
        return Path(override)
    # 与 database-path.ts 对齐: 共享通道摊平到 opencode.db, 其它通道按名字分开
    shared = {"latest", "dev", "beta", "next", "prod"}
    name = (
        "opencode.db"
        if channel in shared
        else f"opencode-{re.sub(r'[^a-zA-Z0-9._-]', '-', channel)}.db"
    )
    return listen_root("data") / name


def listener_pid(port: int) -> int | None:
    """返回该端口 LISTEN 的 pid, 没有则 None。"""
    import psutil

    try:
        for conn in psutil.net_connections(kind="tcp"):
            if conn.status == psutil.CONN_LISTEN and conn.laddr and conn.laddr.port == port:
                return conn.pid
    except Exception as error:
        step(f"查询端口 {port} 失败: {error}")
    return None


def stop_existing(port: int) -> None:
    """结束占端口的旧 serve: 先中断会话(让 outcome=interrupted), 再整树 taskkill。"""
    pid = listener_pid(port)
    if pid is None:
        step(f"端口 {port} 空闲")
        return
    step(f"端口 {port} 被 pid={pid} 占用, 先中断其会话再结束")
    abort_sessions(port)
    subprocess.run(
        ["taskkill", "/F", "/T", "/PID", str(pid)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    deadline = time.time() + 20
    while time.time() < deadline:
        if listener_pid(port) is None:
            step("旧 serve 已结束")
            return
        time.sleep(0.5)
    raise SystemExit(f"端口 {port} 仍被占用, 请手动 taskkill 后再试")


def write_hook(out_dir: Path, profiling: bool) -> Path:
    """写注入脚本: 通道/版本补丁恒有, 采样代码只在采样模式追加。

    两者必须分开: 采样开关只该决定"要不要采", 不该决定"走哪条通道"。
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    hook = out_dir / "channel-hook.ts"
    source = HOOK_TS + (PROFILE_TS if profiling else "")
    hook.write_text(source.strip() + "\n", encoding="utf-8")
    return hook


def build_command(args, hook: Path, service: bool) -> list[str]:
    bun = shutil.which("bun")
    if not bun:
        raise SystemExit("PATH 里找不到 bun")
    if not ENTRY.exists():
        raise SystemExit(f"没找到源码入口 {ENTRY}; 这个脚本要放在仓库根目录(packages/cli 的上一级)")
    # 不用 `bun run`: 它的参数解析不接受前置的 --preload, 而这里需要 (a) 注入通道补丁/采样 hook
    # (b) 固定 cwd 由调用方给, 所以直接给绝对入口 + 显式指定 CLI 包的 tsconfig
    # (否则 tsx/jsx 会按仓库根的 tsconfig 解析, 报 react/jsx-dev-runtime 找不到)。
    command = [bun]
    if not args.disable_profile and not args.no_smol:
        command.append("--smol")  # 与 build.ts 的 execArgv 一致, 堆行为贴近编译产物
    command += [
        "--preload",
        str(hook),
        "--tsconfig-override",
        str(CLI_DIR / "tsconfig.json"),
        str(ENTRY),
        "serve",
    ]
    if service:
        command.append("--service")
    command += ["--port", str(args.port)]
    for origin in args.cors:
        command += ["--cors", origin]
    return command


def wait_listening(child: subprocess.Popen, port: int, timeout: float = 120.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if child.poll() is not None:
            return False
        if listener_pid(port) is not None:
            return True
        time.sleep(0.5)
    return False


def write_control(path: Path, text: str) -> None:
    path.write_text(text, encoding="utf-8")


def wait_file(path: Path, timeout: float) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if path.exists() and path.stat().st_size > 0:
            return True
        time.sleep(0.2)
    return False


def profile_markdown(profile_path: Path, window_seconds: float, interval_us: int) -> Path:
    """把 .cpuprofile 转成能直接看的 md: 热点函数 + 按文件聚合。

    按 hitCount 而不是 timeDeltas 统计: serve 大部分时间在等 I/O, timeDeltas 会把整段
    空闲算到最后一个样本头上, 读起来像"某个函数吃了 4 秒", 完全是错觉。
    """
    data = json.loads(profile_path.read_text(encoding="utf-8"))
    per_function: dict[tuple[str, str], int] = {}
    per_file: dict[str, int] = {}
    for node in data.get("nodes") or []:
        hits = node.get("hitCount") or 0
        if not hits:
            continue
        frame = node.get("callFrame") or {}
        name = frame.get("functionName") or "(anonymous)"
        url = (frame.get("url") or "").replace("file:///", "").replace("file://", "")
        location = f"{url}:{(frame.get('lineNumber') or 0) + 1}"
        per_function[(name, location)] = per_function.get((name, location), 0) + hits
        per_file[url or "(unknown)"] = per_file.get(url or "(unknown)", 0) + hits

    total = sum(per_function.values())
    lines = [
        "# CPU Profile",
        "",
        f"- 文件: `{profile_path}`",
        f"- 采样窗口: {window_seconds:.1f}s, 间隔 {interval_us}µs",
    ]
    if total == 0:
        lines += [
            "",
            "没有采到样本: 该窗口内 JS 没在执行(纯等待/空闲), 或者这一轮根本没跑起来。",
            "复现问题后再采, 或把 --seconds 调大。",
            "",
        ]
        target = profile_path.with_suffix(".md")
        target.write_text("\n".join(lines), encoding="utf-8")
        return target

    busy = total * interval_us / 1000
    rows = sorted(per_function.items(), key=lambda item: item[1], reverse=True)[:25]
    files = sorted(per_file.items(), key=lambda item: item[1], reverse=True)[:10]
    lines += [
        f"- 样本数: {total}(约 {busy / 1000:.2f}s 在跑 JS, 占窗口 {busy / (window_seconds * 1000) * 100:.1f}%)",
        "",
        "## 热点函数",
        "",
        "| Self% | Self | Function | Location |",
        "|------:|-----:|----------|----------|",
    ]
    for (name, location), hits in rows:
        lines.append(
            f"| {hits / total * 100:.1f}% | {hits * interval_us / 1000:.0f}ms | `{name}` | `{location}` |"
        )
    lines += ["", "## 按文件", "", "| Self% | Self | File |", "|------:|-----:|------|"]
    for url, hits in files:
        lines.append(f"| {hits / total * 100:.1f}% | {hits * interval_us / 1000:.0f}ms | `{url}` |")
    lines += [
        "",
        "> 函数名为 `(anonymous)` 时看 Location 定位到源码行。",
        "> 若热点集中在 `(program)` / `(garbage collector)` / `(idle)`, 说明 JS 没在算:",
        "> 要么 GC 压力(--smol 小堆), 要么耗在 native(watcher / fff / node-pty 子进程), 换 WPA 或先关掉对应功能再测。",
        "",
    ]
    target = profile_path.with_suffix(".md")
    target.write_text("\n".join(lines), encoding="utf-8")
    return target


def main() -> None:
    parser = argparse.ArgumentParser(
        description="用源码起 opencode2 serve 并抓 CPU profile",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"serve 端口(默认 {DEFAULT_PORT})")
    parser.add_argument("--cors", action="append", help=f"允许的浏览器来源, 可重复(默认 {DEFAULT_CORS[0]})")
    parser.add_argument("--seconds", type=int, default=DEFAULT_SECONDS, help=f"采样秒数(默认 {DEFAULT_SECONDS})")
    parser.add_argument("--interval", type=int, default=200, help="采样间隔微秒, 越小越细(默认 200)")
    parser.add_argument(
        "--disableprofile",
        dest="disable_profile",
        action="store_true",
        help="性能模式: 不采样(只剩通道补丁 hook)、去掉 --smol, 压日志级别、关 OTEL 导出(散包性能跑法)",
    )
    parser.add_argument("--no-smol", action="store_true", help="采样模式下也不加 --smol")
    parser.add_argument("--auto", action="store_true", help="端口就绪后直接采样, 不等回车")
    parser.add_argument("--delay", type=float, default=DEFAULT_DELAY, help=f"--auto 时端口就绪后再等几秒(默认 {DEFAULT_DELAY})")
    parser.add_argument("--out-dir", type=Path, default=OUT_DIR, help=f"产物目录(默认 {OUT_DIR})")
    parser.add_argument("--no-service", action="store_true", help="前台 serve, 不注册 service(TUI 需自行 --server 指向)")
    parser.add_argument("--keep", action="store_true", help="采样结束后不停掉 profile 服务")
    parser.add_argument(
        "--restore-cmd",
        help="结束后跑这条命令恢复真服务(例如启动器的绝对路径); 不给就只打印提示",
    )
    parser.add_argument(
        "--no-restart",
        action="store_true",
        help="已废弃: 现在默认就不恢复服务, 保留只为兼容还在传这个参数的旧启动 bat",
    )
    parser.add_argument(
        "--channel",
        help="覆盖通道(默认 latest); 决定用哪个数据库 / service 注册文件",
    )
    parser.add_argument("--version", help="覆盖上报给客户端的版本(默认读 opencode2 --version)")
    args = parser.parse_args()
    args.cors = args.cors or list(DEFAULT_CORS)
    out_dir: Path = args.out_dir

    profiling = not args.disable_profile
    # 无论哪种模式都要装: 通道/版本补丁在里面, 丢掉它会让源码服务退化成 local 通道。
    hook = write_hook(out_dir, profiling)

    # channel/version 必须与编译产物一致, 否则会落到 opencode-local.db(看不到 session)、
    # service-local.json(密码对不上), 而且版本不一致时 TUI 会把我们的服务换掉。
    channel = args.channel or detect_channel()
    version = args.version or detect_version()

    step(f"仓库: {REPO}")
    step(f"产物目录: {out_dir}")
    step(f"模式: {'采样' if profiling else '性能(--disableprofile)'}")
    step(f"channel={channel}  version={version or '(未探测到)'}")
    step(f"数据库: {expected_db(channel)}")
    if channel == "local" and not args.no_service:
        step("警告: 没推断出通道, 会落到 local 通道(独立数据库 + 独立密码), 需要的话用 --channel 指定")
    elif not expected_db(channel).exists():
        others = ", ".join(sorted(p.name for p in expected_db(channel).parent.glob("opencode*.db"))) or "无"
        step(f"警告: 预期数据库不存在, 通道可能推断错了(现有: {others}); 用 --channel 指定")
    if version is None and not args.no_service:
        step("警告: 没探测到已安装版本, TUI 可能因为版本不一致把这位服务换掉; 可用 --version 指定")

    stop_existing(args.port)

    stamp = time.strftime("%Y%m%d-%H%M%S")
    profile_path = out_dir / f"serve-{stamp}.cpuprofile"
    control = out_dir / f"serve-{stamp}.control"
    if profiling:
        write_control(control, "")

    env = serve_env()
    env["OPENCODE_PROFILE_CHANNEL"] = channel
    if version:
        env["OPENCODE_PROFILE_VERSION"] = version
    if profiling:
        env["OPENCODE_PROFILE_CONTROL"] = str(control)
        env["OPENCODE_PROFILE_OUT"] = str(profile_path)
        env["OPENCODE_PROFILE_INTERVAL"] = str(args.interval)
    else:
        # 性能优先: 只留通道补丁 hook(无采样代码), 不装 inspector; 再压掉日志和 span 导出
        env.setdefault("OPENCODE_LOG_LEVEL", "WARN")
        dropped = [key for key in ("OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_EXPORTER_OTLP_HEADERS") if env.pop(key, None)]
        step(
            f"性能开关: hook 仅含通道补丁(无采样), 无 --smol, OPENCODE_LOG_LEVEL={env['OPENCODE_LOG_LEVEL']}"
            + (f", 关 OTEL 导出({', '.join(dropped)})" if dropped else ", OTEL 未设置")
        )

    command = build_command(args, hook, service=not args.no_service)
    start_dir = resolve_start_dir()
    step("启动: " + " ".join(command[1:]))
    step(f"cwd: {start_dir}")
    child = subprocess.Popen(command, cwd=start_dir, env=env)

    try:
        if not wait_listening(child, args.port):
            raise SystemExit(f"serve 没能在端口 {args.port} 上起来(看上面的输出/日志)")

        step(f"serve 已就绪: http://127.0.0.1:{args.port}")
        if not profiling:
            step("性能模式运行中, Ctrl+C 结束")
            child.wait()
            raise SystemExit(0)
        if not args.auto:
            say()
            say("现在到 TUI 里把问题复现出来(opencode2 会自动连上这个服务)。")
            say(f"复现到位后按回车, 开始采样 {args.seconds} 秒 ...")
            try:
                input()
            except EOFError:
                step("stdin 不是终端, 直接开始采样")
        else:
            time.sleep(args.delay)

        write_control(control, "start")
        step(f"采样中({args.seconds}s) ...")
        time.sleep(args.seconds)
        write_control(control, "stop")

        if not wait_file(profile_path, 30):
            raise SystemExit(f"没等到 profile 文件: {profile_path}")
        step(f"profile 已写入: {profile_path} ({profile_path.stat().st_size} bytes)")

        markdown = profile_markdown(profile_path, args.seconds, args.interval)
        step(f"热点表: {markdown}")
        say()
        say(markdown.read_text(encoding="utf-8"))

    except KeyboardInterrupt:
        step("收到 Ctrl+C, 收尾")
    finally:
        if profiling and not profile_path.exists():
            step(f"注意: 没有生成 {profile_path.name}(采样窗口内进程提前退出了?)")
        if not args.keep:
            if profiling:
                write_control(control, "exit")
            try:
                child.wait(timeout=15)
            except subprocess.TimeoutExpired:
                subprocess.run(
                    ["taskkill", "/F", "/T", "/PID", str(child.pid)],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
        if args.keep:
            step(f"dev 服务仍在运行: http://127.0.0.1:{args.port}(Ctrl+C 结束)")
        elif args.restore_cmd:
            step(f"恢复真服务: {args.restore_cmd}")
            subprocess.run(split_command(args.restore_cmd))
        else:
            step("已停掉 dev 服务; 需要真服务的话用你自己的启动器拉起(或下次 --restore-cmd 让它自动恢复)")

    if profiling:
        say()
        say(f".cpuprofile 可拖进 Chrome DevTools(Performance -> Load profile)或 https://speedscope.app")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        say("bye")
