#!/usr/bin/env python3
"""Agent Builder — локальный сервер визуального конструктора сабагентов Claude Code.

Обычно его запускает приложение «Agent Builder.app». Без приложения, в браузере:
         python3 app/server.py            (откроет браузер сам)
         python3 app/server.py --port 8765 --no-browser

Код лежит рядом с этим файлом (static/), данные — в
~/Library/Application Support/Agent Builder (или в $AGENT_BUILDER_DATA).

Сервер слушает только 127.0.0.1. Каждый запрос к /api/ должен нести токен,
который сервер вшивает в страницу при старте: чужие сайты не смогут
записать файлы от вашего имени.

Запущен всегда один экземпляр: повторный запуск открывает уже работающий,
а устаревший (код обновился) останавливает и занимает его порт. Работающий
сервер сам перезапускается, если server.py изменился.
"""

import argparse
import json
import os
import re
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import unicodedata
import urllib.request
import webbrowser
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

HOME = Path.home()

APP_DIR = Path(__file__).resolve().parent  # код: server.py и static/ (внутри .app или в репозитории)
STATIC_DIR = APP_DIR / "static"
DATA_DIR = Path(os.environ.get("AGENT_BUILDER_DATA")
                or HOME / "Library" / "Application Support" / "Agent Builder")
SYSTEMS_DIR = DATA_DIR / "systems"
BACKUPS_DIR = DATA_DIR / "backups"
MANIFEST = DATA_DIR / "installed.json"
DRAFT_FILE = DATA_DIR / "draft.json"
STATE_FILE = DATA_DIR / ".server.json"

CLAUDE_DIR = HOME / ".claude"
USER_AGENTS_DIR = CLAUDE_DIR / "agents"

NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}$")
TEAM_BLOCK_RE = re.compile(
    r"\n*<!-- agent-builder:team -->.*?<!-- /agent-builder:team -->\n*", re.S
)
KNOWN_KEYS = {
    "name", "description", "tools", "model", "effort", "permissionMode",
    "maxTurns", "memory", "skills", "color",
}
TOKEN = secrets.token_urlsafe(24)


def code_version():
    try:
        return (APP_DIR / "server.py").stat().st_mtime
    except OSError:
        return 0


def say(text):
    """Печать, которая не падает, если окно приложения (читатель вывода) уже закрыто."""
    try:
        print(text, flush=True)
    except (OSError, ValueError):
        pass


STARTED_CODE = code_version()
RESTARTING = threading.Event()
PORT = {"value": None}
IDLE_EXIT = {"seconds": 0}         # 0 — работать, пока не закроют окно Терминала
LAST_SEEN = {"time": time.time()}  # когда страница последний раз обращалась к серверу
EXTRA_ARGS = []                    # аргументы, которые нужно сохранить при перезапуске

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
}


class ApiError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


# ---------- файлы и пути ----------

def resolve_target(target):
    """Возвращает (папка агентов, папка проекта или None)."""
    target = target or {}
    if target.get("scope") == "project":
        raw = (target.get("path") or "").strip()
        if not raw:
            raise ApiError("Не указана папка проекта.")
        project = Path(os.path.expanduser(raw)).resolve()
        if not project.is_dir():
            raise ApiError(f"Папка проекта не найдена: {project}")
        return project / ".claude" / "agents", project
    return USER_AGENTS_DIR, None


def write_atomic(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def read_json(path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def backup(paths, label):
    """Копирует файлы в backups/<время>/, возвращает папку копии или None."""
    paths = [p for p in paths if p.exists()]
    if not paths:
        return None
    stamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    slug = re.sub(r"[^A-Za-z0-9._-]+", "_", label).strip("_")[-80:] or "target"
    dest = BACKUPS_DIR / stamp / slug
    dest.mkdir(parents=True, exist_ok=True)
    for p in paths:
        shutil.copy2(p, dest / p.name)
    return dest


# ---------- разбор агентов ----------

def unquote(value):
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] == '"':
        try:
            return json.loads(value)
        except ValueError:
            return value[1:-1]
    if len(value) >= 2 and value[0] == value[-1] == "'":
        return value[1:-1].replace("''", "'")
    return value


def split_top(text):
    """Делит по запятым, не заходя внутрь скобок: 'Agent(a, b), Read' -> 2 части."""
    parts, depth, cur = [], 0, ""
    for ch in text:
        if ch in "([":
            depth += 1
        elif ch in ")]":
            depth -= 1
        if ch == "," and depth == 0:
            parts.append(cur.strip())
            cur = ""
        else:
            cur += ch
    if cur.strip():
        parts.append(cur.strip())
    return parts


def parse_agent(text):
    m = re.match(r"^---[ \t]*\r?\n(.*?)\r?\n---[ \t]*(?:\r?\n|$)(.*)$", text, re.S)
    if not m:
        return None
    frontmatter, body = m.group(1), m.group(2)

    blocks, key = [], None  # [(ключ, [строки])]
    for line in frontmatter.splitlines():
        if re.match(r"^[A-Za-z_][\w-]*\s*:", line):
            key = line.split(":", 1)[0].strip()
            blocks.append((key, [line]))
        elif blocks:
            blocks[-1][1].append(line)

    fields, extra = {}, []
    for key, lines in blocks:
        if key not in KNOWN_KEYS:
            extra.extend(lines)
            continue
        value = lines[0].split(":", 1)[1].strip()
        items = [l.strip()[2:].strip() for l in lines[1:] if l.strip().startswith("- ")]
        if items:
            fields[key] = [unquote(i) for i in items]
        elif value.startswith("[") and value.endswith("]"):
            fields[key] = [unquote(i) for i in split_top(value[1:-1])]
        elif value in ("|", ">", "|-", ">-"):
            fields[key] = "\n".join(l.strip() for l in lines[1:]).strip()
        else:
            fields[key] = unquote(value)

    team_section = bool(TEAM_BLOCK_RE.search(body))
    body = TEAM_BLOCK_RE.sub("\n", body).strip()
    return {
        "fields": fields,
        "extraYaml": "\n".join(extra).strip(),
        "prompt": body,
        "teamSection": team_section,
    }


def agents_endpoint(req):
    """Агенты из папки назначения + к какой системе они относятся и кто вход проекта."""
    agents_dir, project = resolve_target(req.get("target"))
    agents = list_agents(agents_dir)
    owners = {
        n: (sid, info.get("name"))
        for sid, info in read_json(MANIFEST, {}).get(str(agents_dir), {}).items()
        for n in info.get("agents", [])
    }
    for a in agents:
        owner = owners.get(a["fields"]["name"])
        if owner:
            a["system"], a["systemName"] = owner
    settings_agent = None
    if project:
        settings_agent = read_json(project / ".claude" / "settings.json", {}).get("agent")
    return {"agents": agents, "settingsAgent": settings_agent}


def list_agents(agents_dir):
    result = []
    if not agents_dir.is_dir():
        return result
    for path in sorted(agents_dir.rglob("*.md")):
        try:
            parsed = parse_agent(path.read_text(encoding="utf-8"))
        except OSError:
            continue
        if not parsed or not parsed["fields"].get("name"):
            continue
        parsed["file"] = str(path)
        result.append(parsed)
    return result


# ---------- окружение ----------

def first_cwd(jsonl):
    try:
        with jsonl.open(encoding="utf-8", errors="replace") as fh:
            for i, line in enumerate(fh):
                if i > 60:
                    break
                if '"cwd"' not in line:
                    continue
                try:
                    cwd = json.loads(line).get("cwd")
                except ValueError:
                    continue
                if cwd:
                    return cwd
    except OSError:
        pass
    return None


def session_projects():
    """{папка: время последней сессии} — где вы запускали Claude Code."""
    base = CLAUDE_DIR / "projects"
    found = {}
    if not base.is_dir():
        return found
    for d in base.iterdir():
        if not d.is_dir():
            continue
        sessions = sorted(d.glob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True)
        for s in sessions[:6]:
            cwd = first_cwd(s)
            if cwd and "/scratch-workspaces/" not in cwd and os.path.isdir(cwd):
                found[cwd] = max(found.get(cwd, 0), s.stat().st_mtime)
                break
    return found


def claude_json_projects():
    """Папки из реестра Claude Code (~/.claude.json)."""
    return list(read_json(HOME / ".claude.json", {}).get("projects", {}).keys())


SCAN_SKIP = {
    "Library", "Applications", "Movies", "Music", "Pictures", "Public", "Google Drive",
    "node_modules", "__pycache__", "venv", "env", "go", "bin", "build", "dist", "target",
}


def scan_home(max_depth=3, budget=2.0):
    """Папки с .git, .claude или CLAUDE.md не глубже трёх уровней от домашней."""
    found, started = {}, time.monotonic()

    def walk(path, depth):
        if time.monotonic() - started > budget:
            return
        try:
            entries = list(os.scandir(path))
        except OSError:
            return
        names = {e.name for e in entries}
        marks = []
        if ".git" in names:
            marks.append("git")
        if "CLAUDE.md" in names:
            marks.append("claude-md")
        if ".claude" in names:
            marks.append("claude-dir")
        if marks and path != str(HOME):
            found[path] = marks
            if "git" in marks:
                return  # внутрь репозитория не спускаемся
        if depth >= max_depth:
            return
        for e in entries:
            if e.name.startswith(".") or e.name in SCAN_SKIP:
                continue
            try:
                if e.is_dir(follow_symlinks=False):
                    walk(e.path, depth + 1)
            except OSError:
                pass

    walk(str(HOME), 0)
    return found


def list_projects():
    items = {}

    def add(path, used=0, marks=()):
        # macOS отдаёт имена файлов в NFD («й» = «и» + знак), а Claude Code пишет NFC.
        path = unicodedata.normalize("NFC", str(Path(path)))
        skip = (path in (str(HOME), str(APP_DIR)) or "/scratch-workspaces/" in path
                or path.startswith(str(CLAUDE_DIR)) or not os.path.isdir(path))
        if skip:
            return
        item = items.setdefault(path, {"path": path, "name": os.path.basename(path) or path,
                                       "used": 0, "marks": set()})
        item["used"] = max(item["used"], used)
        item["marks"].update(marks)

    for path, used in session_projects().items():
        add(path, used, {"claude-code"})
    for path in claude_json_projects():
        add(path, 0, {"claude-code"})
    for path, marks in scan_home().items():
        add(path, 0, marks)

    home = str(HOME)
    for item in items.values():
        agents_dir = Path(item["path"]) / ".claude" / "agents"
        item["agents"] = len(list(agents_dir.glob("*.md"))) if agents_dir.is_dir() else 0
        item["display"] = "~" + item["path"][len(home):] if item["path"].startswith(home + "/") else item["path"]
        item["usedLabel"] = datetime.fromtimestamp(item["used"]).strftime("%d.%m.%Y") if item["used"] else ""
        item["marks"] = sorted(item["marks"])
    return sorted(items.values(), key=lambda i: (-i["used"], "claude-code" not in i["marks"], i["name"].lower()))


def pick_folder(_req):
    """Системное окно выбора папки (macOS)."""
    if sys.platform != "darwin":
        raise ApiError("Окно выбора папки есть только на macOS. Вставьте путь вручную.")
    script = ['-e', 'activate',
              '-e', 'POSIX path of (choose folder with prompt "Agent Builder: выберите папку проекта")']
    try:
        r = subprocess.run(["osascript", *script], capture_output=True, text=True, timeout=600)
    except subprocess.TimeoutExpired:
        raise ApiError("Окно выбора папки закрылось по таймауту.")
    if r.returncode != 0:
        if "-128" in r.stderr:  # нажали «Отмена»
            return {"path": None}
        raise ApiError(f"Не удалось открыть окно выбора папки: {r.stderr.strip()}")
    path = r.stdout.strip()
    return {"path": path.rstrip("/") or "/"}


def user_skills():
    skills = []
    base = CLAUDE_DIR / "skills"
    if base.is_dir():
        for d in sorted(base.iterdir()):
            if (d / "SKILL.md").is_file():
                skills.append(d.name)
    return skills


def env_info():
    return {
        "home": str(HOME),
        "userAgentsDir": str(USER_AGENTS_DIR),
        "userAgentsDirExists": USER_AGENTS_DIR.is_dir(),
        "userAgentsCount": len(list(USER_AGENTS_DIR.glob("*.md"))) if USER_AGENTS_DIR.is_dir() else 0,
        "skills": user_skills(),
        "systems": list_systems(),
    }


# ---------- сохранённые системы ----------

def system_slug(name):
    slug = re.sub(r"[^\w-]+", "-", name.strip().lower(), flags=re.U).strip("-")
    return slug[:80] or "system"


def list_systems():
    out = []
    if SYSTEMS_DIR.is_dir():
        for p in sorted(SYSTEMS_DIR.glob("*.json"), key=lambda p: -p.stat().st_mtime):
            data = read_json(p, {})
            out.append({
                "id": p.stem,
                "name": data.get("name") or p.stem,
                "agents": len(data.get("nodes", [])),
                "updated": datetime.fromtimestamp(p.stat().st_mtime).strftime("%d.%m.%Y %H:%M"),
            })
    return out


def save_system(data):
    name = (data.get("name") or "").strip()
    if not name:
        raise ApiError("У системы нет названия.")
    SYSTEMS_DIR.mkdir(exist_ok=True)
    slug = system_slug(name)
    write_atomic(SYSTEMS_DIR / f"{slug}.json", json.dumps(data, ensure_ascii=False, indent=2))
    # Систему переименовали — старый файл с тем же id больше не нужен.
    if data.get("id"):
        for p in SYSTEMS_DIR.glob("*.json"):
            if p.stem != slug and read_json(p, {}).get("id") == data["id"]:
                p.unlink()
    return {"id": slug, "systems": list_systems()}


def load_system(system_id):
    path = SYSTEMS_DIR / f"{system_slug(system_id)}.json"
    if not path.is_file():
        raise ApiError("Система не найдена.", 404)
    return read_json(path, {})


def delete_system(system_id):
    path = SYSTEMS_DIR / f"{system_slug(system_id)}.json"
    if path.is_file():
        backup([path], "systems")
        path.unlink()
    return {"systems": list_systems()}


# ---------- установка ----------

def install(req):
    agents_dir, project = resolve_target(req.get("target"))
    system = (req.get("system") or "").strip() or "system"
    system_name = (req.get("systemName") or "").strip() or system
    files = req.get("files") or []
    overwrite = set(req.get("overwrite") or [])
    dry_run = bool(req.get("dryRun"))

    names = []
    for f in files:
        name = f.get("name", "")
        if not NAME_RE.match(name):
            raise ApiError(f"Недопустимое имя агента: «{name}». Нужны латиница, цифры и дефис.")
        if name in names:
            raise ApiError(f"Имя «{name}» встречается дважды.")
        names.append(name)

    # installed.json: {папка агентов: {id системы: {"name": ..., "agents": [...]}}}
    manifest = read_json(MANIFEST, {})
    dir_key = str(agents_dir)
    by_system = manifest.get(dir_key, {})
    owner = {n: sid for sid, info in by_system.items() for n in info.get("agents", [])}
    previous = set(by_system.get(system, {}).get("agents", []))

    plan = []
    for f in files:
        name, content = f["name"], f["content"]
        if not content.endswith("\n"):
            content += "\n"
        f["content"] = content
        path = agents_dir / f"{name}.md"
        item = {"name": name, "path": str(path)}
        if not path.exists():
            item["action"] = "create"
        elif path.read_text(encoding="utf-8", errors="replace") == content:
            item["action"] = "same"
        elif name in owner:
            item["action"] = "update"
            if owner[name] != system:
                other = by_system[owner[name]].get("name", owner[name])
                item["note"] = f"сейчас принадлежит системе «{other}»"
        else:
            item["action"] = "overwrite" if name in overwrite else "conflict"
            item["note"] = "файл создан не конструктором"
        plan.append(item)

    for name in sorted(previous - set(names)):
        path = agents_dir / f"{name}.md"
        if path.exists():
            plan.append({"name": name, "path": str(path), "action": "remove"})

    settings_change = None
    settings_path = project / ".claude" / "settings.json" if project else None
    if project:
        settings = read_json(settings_path, {})
        current = settings.get("agent")
        ours = manifest.get("_settingsAgent", {}).get(str(project))
        wanted = req.get("entry") if req.get("entryInSettings") else None
        if wanted and wanted != current:
            settings_change = {"path": str(settings_path), "from": current, "to": wanted}
        elif not wanted and current and current == ours:
            settings_change = {"path": str(settings_path), "from": current, "to": None}

    result = {
        "agentsDir": str(agents_dir),
        "dirExists": agents_dir.is_dir(),
        "plan": plan,
        "settings": settings_change,
    }
    if dry_run:
        return result

    touched = [agents_dir / f"{i['name']}.md" for i in plan
               if i["action"] in ("update", "overwrite", "remove")]
    if settings_change:
        touched.append(settings_path)
    backup_dir = backup(touched, dir_key)

    content_by_name = {f["name"]: f["content"] for f in files}
    for item in plan:
        path = Path(item["path"])
        if item["action"] in ("create", "update", "overwrite"):
            write_atomic(path, content_by_name[item["name"]])
        elif item["action"] == "remove":
            path.unlink()

    if settings_change:
        settings = read_json(settings_path, {})
        agents_set = manifest.setdefault("_settingsAgent", {})
        if settings_change["to"]:
            settings["agent"] = settings_change["to"]
            agents_set[str(project)] = settings_change["to"]
        else:
            settings.pop("agent", None)
            agents_set.pop(str(project), None)
        write_atomic(settings_path, json.dumps(settings, ensure_ascii=False, indent=2) + "\n")

    installed = [i["name"] for i in plan if i["action"] not in ("conflict", "remove")]
    for other, info in list(by_system.items()):
        if other != system:
            info["agents"] = [n for n in info.get("agents", []) if n not in installed]
            if not info["agents"]:
                del by_system[other]
    by_system[system] = {"name": system_name, "agents": installed}
    manifest[dir_key] = by_system
    write_atomic(MANIFEST, json.dumps(manifest, ensure_ascii=False, indent=2))

    result["applied"] = True
    result["backupDir"] = str(backup_dir) if backup_dir else None
    return result


# ---------- HTTP ----------

class Handler(BaseHTTPRequestHandler):
    server_version = "AgentBuilder/1.0"

    def log_message(self, fmt, *args):
        if os.environ.get("AGENT_BUILDER_DEBUG"):
            super().log_message(fmt, *args)

    def send_json(self, status, data):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def host_ok(self):
        host = (self.headers.get("Host") or "").split(":")[0]
        return host in ("127.0.0.1", "localhost")

    def do_GET(self):
        if not self.host_ok():
            return self.send_error(403)
        path = urlparse(self.path).path
        if path == "/":
            path = "/index.html"
        if path.startswith("/api/"):
            return self.handle_api(path, None)
        file = (STATIC_DIR / path.lstrip("/")).resolve()
        if STATIC_DIR not in file.parents or not file.is_file():
            return self.send_error(404)
        data = file.read_bytes()
        if file.name == "index.html":
            data = data.replace(b"__TOKEN__", TOKEN.encode())
            LAST_SEEN["time"] = time.time()
        self.send_response(200)
        self.send_header("Content-Type", CONTENT_TYPES.get(file.suffix, "application/octet-stream"))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        if not self.host_ok():
            return self.send_error(403)
        length = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            return self.send_json(400, {"error": "Некорректный JSON."})
        self.handle_api(urlparse(self.path).path, body)

    def handle_api(self, path, body):
        if path == "/api/ping":  # без токена: только «кто здесь», для запуска одного экземпляра
            return self.send_json(200, {"app": "agent-builder", "pid": os.getpid(), "code": STARTED_CODE})
        if code_version() != STARTED_CODE:
            restart_soon()
            return self.send_json(409, {"error": "Конструктор обновился, перезагружаю страницу…", "reload": True})
        if self.headers.get("X-Token") != TOKEN:
            return self.send_json(403, {"error": "Сервер перезапускался, перезагружаю страницу…", "reload": True})
        LAST_SEEN["time"] = time.time()
        routes = {
            "/api/heartbeat": lambda b: {"ok": True},
            "/api/draft/load": lambda b: {"draft": read_json(DRAFT_FILE, None)},
            "/api/draft/save": save_draft,
            "/api/env": lambda b: env_info(),
            "/api/agents": agents_endpoint,
            "/api/projects": lambda b: {"projects": list_projects()},
            "/api/pick-folder": pick_folder,
            "/api/install": install,
            "/api/systems/save": save_system,
            "/api/systems/load": lambda b: load_system(b.get("id", "")),
            "/api/systems/delete": lambda b: delete_system(b.get("id", "")),
        }
        handler = routes.get(path)
        if not handler:
            return self.send_json(404, {"error": f"Сервер не знает команду {path}."})
        try:
            self.send_json(200, handler(body or {}))
        except ApiError as e:
            self.send_json(e.status, {"error": str(e)})
        except Exception as e:  # noqa: BLE001 — ошибку показываем в интерфейсе
            self.send_json(500, {"error": f"{type(e).__name__}: {e}"})


def free_port(start):
    for port in range(start, start + 50):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            if s.connect_ex(("127.0.0.1", port)) != 0:
                return port
    raise SystemExit("Не нашлось свободного порта.")


def save_draft(req):
    write_atomic(DRAFT_FILE, json.dumps(req, ensure_ascii=False))
    return {"ok": True}


# ---------- один экземпляр и перезапуск ----------

def ping(port):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/ping", timeout=1) as r:
            return json.loads(r.read())
    except Exception:  # noqa: BLE001 — нет ответа значит нет сервера
        return None


def running_instance():
    """Порт уже запущенного свежего конструктора. Устаревший останавливаем."""
    state = read_json(STATE_FILE, {})
    port, pid = state.get("port"), state.get("pid")
    if not port or not pid or pid == os.getpid():
        return None
    info = ping(port)
    if not info or info.get("app") != "agent-builder" or info.get("pid") != pid:
        return None
    if info.get("code") == STARTED_CODE:
        return port
    say("Нашёл устаревшую копию конструктора, останавливаю её…")
    try:
        os.kill(pid, signal.SIGTERM)
    except OSError:
        return None
    for _ in range(30):
        if not ping(port):
            break
        time.sleep(0.1)
    return None


def restart_soon():
    """Код обновился — перезапускаем себя на том же порту (PID и окно Терминала те же)."""
    if RESTARTING.is_set():
        return
    RESTARTING.set()

    def go():
        time.sleep(0.3)
        say("\nКод конструктора обновился, перезапускаюсь…")
        os.execv(sys.executable, [sys.executable, str(APP_DIR / "server.py"),
                                  "--port", str(PORT["value"]), "--no-browser",
                                  "--idle-exit", str(IDLE_EXIT["seconds"]), *EXTRA_ARGS])

    threading.Thread(target=go, daemon=True).start()


def main():
    parser = argparse.ArgumentParser(description="Конструктор агентов Claude Code")
    parser.add_argument("--port", type=int, default=None)
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--idle-exit", type=int, default=0, metavar="SECONDS",
                        help="выключиться, если страница не обращалась столько секунд (для запуска значком)")
    parser.add_argument("--parent-pid", type=int, default=0,
                        help="выключиться, когда завершится этот процесс (окно приложения)")
    parser.add_argument("--announce", action="store_true",
                        help="напечатать строку «@url …» для приложения-окна")
    args = parser.parse_args()
    IDLE_EXIT["seconds"] = max(0, args.idle_exit)
    if args.parent_pid:
        EXTRA_ARGS.extend(["--parent-pid", str(args.parent_pid)])
    if args.announce:
        EXTRA_ARGS.append("--announce")

    existing = running_instance()
    if existing:
        url = f"http://127.0.0.1:{existing}/"
        say(f"Конструктор уже запущен: {url}\nОткрываю его, это окно можно закрыть.")
        if args.announce:
            say(f"@url {url} shared")
        if not args.no_browser:
            webbrowser.open(url)
        return

    # Тот же порт, что в прошлый раз: у браузера тогда те же сохранённые данные страницы.
    port = free_port(args.port or read_json(STATE_FILE, {}).get("port") or 8765)
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    PORT["value"] = port
    write_atomic(STATE_FILE, json.dumps({"pid": os.getpid(), "port": port}))

    def stop(*_):
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGHUP, stop)  # закрыли окно Терминала

    def parent_alive():
        # Когда окно приложения завершается (даже аварийно), система сразу
        # переподчиняет сервер себе, и родитель меняется.
        if os.getppid() != args.parent_pid:
            return False
        try:
            os.kill(args.parent_pid, 0)
            return True
        except ProcessLookupError:
            return False
        except OSError:
            return True

    if IDLE_EXIT["seconds"] or args.parent_pid:
        def watchdog():
            while True:
                time.sleep(3 if args.parent_pid else 20)
                if args.parent_pid and not parent_alive():
                    say(f"{datetime.now():%H:%M} Окно приложения закрыто, выключаюсь.")
                elif IDLE_EXIT["seconds"] and time.time() - LAST_SEEN["time"] > IDLE_EXIT["seconds"]:
                    say(f"{datetime.now():%H:%M} Страница давно закрыта, выключаюсь.")
                else:
                    continue
                server.shutdown()
                return

        threading.Thread(target=watchdog, daemon=True).start()

    url = f"http://127.0.0.1:{port}/"
    how_to_stop = (f"Выключится сам, если страницей не пользоваться {IDLE_EXIT['seconds'] // 60} мин."
                   if IDLE_EXIT["seconds"] else "Остановить: Ctrl+C или закройте это окно")
    say(f"{datetime.now():%d.%m %H:%M} Agent Builder: {url}\n{how_to_stop}")
    if args.announce:
        say(f"@url {url} own")
    if not args.no_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        say("\nОстановлено.")
    finally:
        if read_json(STATE_FILE, {}).get("pid") == os.getpid() and not RESTARTING.is_set():
            # Порт оставляем: следующий запуск займёт его же.
            write_atomic(STATE_FILE, json.dumps({"pid": None, "port": port}))
        server.server_close()


if __name__ == "__main__":
    main()
