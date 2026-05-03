#!/usr/bin/env python3
# ClaudeWebUI - Developed by acidvegas in Python (https://github.com/acidvegas/claudewebui)
# claudewebui/app.py

import fcntl
import glob
import hmac
import json
import os
import pty
import re
import select
import shutil
import signal
import struct
import subprocess
import termios
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from functools import wraps
from pathlib import Path

from flask import (Flask, jsonify, redirect, render_template, request, abort,
                   send_file, session as flask_session, url_for)
from flask_socketio import SocketIO, emit, join_room, leave_room


# ---------- .env loader (no extra dep) ----------

def _load_dotenv(path):
    if not os.path.isfile(path):
        return
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith('#') or '=' not in line:
                    continue
                k, v = line.split('=', 1)
                k = k.strip()
                v = v.strip()
                if (v.startswith('"') and v.endswith('"')) or \
                   (v.startswith("'") and v.endswith("'")):
                    v = v[1:-1]
                os.environ.setdefault(k, v)
    except OSError:
        pass


_APP_DIR = os.path.dirname(os.path.abspath(__file__))
_load_dotenv(os.path.join(_APP_DIR, '.env'))

WEBUI_PASSWORD = os.environ.get('WEBUI_PASSWORD') or 'loldongs'


# ---------- persistent secret key (so restarts don't log everyone out) ----------

_SECRET_FILE = os.path.join(_APP_DIR, '.webui-secret')
if os.path.isfile(_SECRET_FILE):
    with open(_SECRET_FILE) as f:
        _secret = f.read().strip()
else:
    _secret = os.urandom(32).hex()
    with open(_SECRET_FILE, 'w') as f:
        f.write(_secret)
    try:
        os.chmod(_SECRET_FILE, 0o600)
    except OSError:
        pass


app = Flask(__name__)
app.config['SECRET_KEY'] = _secret
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE='Lax',
    PERMANENT_SESSION_LIFETIME=timedelta(days=30),
)
socketio = SocketIO(app, async_mode='threading', cors_allowed_origins='*',
                    logger=False, engineio_logger=False,
                    manage_session=False)


# ---------- auth ----------

def _is_authed():
    return bool(flask_session.get('auth'))


@app.before_request
def _require_auth():
    # Allow login flow + static assets
    p = request.path
    if p == '/login' or p == '/logout' or p.startswith('/static/') or p == '/favicon.ico':
        return None
    # Socket.IO transport handshake also goes through HTTP — auth is enforced
    # in the @socketio.on('connect') handler below.
    if p.startswith('/socket.io'):
        return None
    if _is_authed():
        return None
    if p.startswith('/api/'):
        return jsonify({'error': 'unauthorized'}), 401
    return redirect(url_for('login', next=p))


@app.route('/login', methods=['GET', 'POST'])
def login():
    error = None
    if request.method == 'POST':
        pw = request.form.get('password', '')
        if hmac.compare_digest(pw, WEBUI_PASSWORD):
            flask_session.permanent = True
            flask_session['auth'] = True
            nxt = request.args.get('next') or '/'
            if not nxt.startswith('/'):
                nxt = '/'
            return redirect(nxt)
        error = 'Incorrect password.'
    return render_template('login.html', error=error), (401 if error else 200)


@app.route('/logout')
def logout():
    flask_session.clear()
    return redirect(url_for('login'))

sessions = {}

SKIP_NAMES = frozenset({
    'node_modules', '__pycache__', '.git', 'venv', '.venv',
    'dist', 'build', '.next', '.nuxt', 'target', '.mypy_cache',
    '.pytest_cache', '.ruff_cache', 'coverage', '.tox',
})


class Session:
    def __init__(self, session_id, cwd):
        self.id = session_id
        self.cwd = cwd
        self.proc = None
        self.master_fd = None
        self.status = 'idle'
        self.output_buffer = []
        self._lock = threading.Lock()
        self.start_time = time.time()
        self.jsonl_path = None
        self.claude_session_id = None  # set for resumed sessions
        self.is_shell = False           # plain shell PTY, not a claude session

    def to_dict(self):
        return {'id': self.id, 'cwd': self.cwd, 'status': self.status,
                'claude_session_id': self.claude_session_id,
                'is_shell': self.is_shell}


def _start_pty(session_id, cwd, args=None, cmd=None):
    session = sessions.get(session_id)
    if not session:
        return

    if session.proc and session.proc.poll() is None:
        try:
            session.proc.terminate()
        except OSError:
            pass

    master_fd, slave_fd = pty.openpty()
    fcntl.ioctl(slave_fd, termios.TIOCSWINSZ, struct.pack('HHHH', 50, 220, 0, 0))

    env = dict(os.environ)
    env.update({
        'TERM': 'xterm-256color',
        'COLORTERM': 'truecolor',
    })
    env.pop('NO_COLOR', None)
    env.pop('FORCE_COLOR', None)

    if session.is_shell:
        env['PROMPT_EOL_MARK'] = ''

    argv = list(cmd) if cmd else (['claude'] + (args or []))

    try:
        proc = subprocess.Popen(
            argv,
            stdin=slave_fd, stdout=slave_fd, stderr=slave_fd,
            close_fds=True, cwd=cwd, env=env,
        )
        os.close(slave_fd)
    except Exception as exc:
        os.close(slave_fd)
        os.close(master_fd)
        session.status = 'error'
        socketio.emit('session_status', {
            'session_id': session_id, 'status': 'error', 'error': str(exc)
        }, room=session_id)
        return

    session.proc = proc
    session.master_fd = master_fd
    session.status = 'running'

    def _reader():
        try:
            while proc.poll() is None:
                r, _, _ = select.select([master_fd], [], [], 0.05)
                if r:
                    try:
                        data = os.read(master_fd, 4096)
                    except OSError:
                        break
                    if data:
                        text = data.decode('utf-8', errors='replace')
                        with session._lock:
                            session.output_buffer.append(text)
                        socketio.emit('output', {
                            'session_id': session_id, 'data': text
                        }, room=session_id)
        finally:
            try:
                os.close(master_fd)
            except OSError:
                pass
            session.master_fd = None
            session.status = 'done'
            socketio.emit('session_status', {
                'session_id': session_id,
                'status': 'done',
                'exit_code': proc.returncode,
            }, room=session_id)

    threading.Thread(target=_reader, daemon=True).start()


# ---------- REST API ----------

@app.route('/')
def index():
    home = os.path.expanduser('~')
    return render_template('index.html', default_cwd=home, home_dir=home,
                           cache_bust=int(time.time()))


@app.route('/api/sessions', methods=['GET'])
def list_sessions():
    return jsonify([s.to_dict() for s in sessions.values() if not s.is_shell])


@app.route('/api/shell-session', methods=['POST'])
def create_shell_session():
    data = request.get_json() or {}
    cwd = os.path.realpath(data.get('cwd', os.path.expanduser('~')))
    if not os.path.isdir(cwd):
        return jsonify({'error': 'Invalid directory'}), 400

    sid = 'shell-' + str(uuid.uuid4())[:8]
    session = Session(sid, cwd)
    session.is_shell = True
    sessions[sid] = session

    shell = os.environ.get('SHELL') or '/bin/bash'
    _start_pty(sid, cwd, cmd=[shell, '-i', '-l'])
    return jsonify(session.to_dict()), 201


@app.route('/api/shell-session/<sid>', methods=['DELETE'])
def delete_shell_session(sid):
    session = sessions.get(sid)
    if not session or not session.is_shell:
        abort(404)
    if session.proc and session.proc.poll() is None:
        try:
            session.proc.terminate()
        except OSError:
            pass
    del sessions[sid]
    return jsonify({'ok': True})


@app.route('/api/sessions', methods=['POST'])
def create_session():
    data = request.get_json() or {}
    cwd = os.path.realpath(data.get('cwd', os.path.expanduser('~')))
    if not os.path.isdir(cwd):
        return jsonify({'error': 'Invalid directory'}), 400

    sid = str(uuid.uuid4())[:8]
    session = Session(sid, cwd)
    sessions[sid] = session

    args = []
    prompt = (data.get('prompt') or '').strip()
    if prompt:
        args = ['-p', prompt]

    _start_pty(sid, cwd, args)
    return jsonify(session.to_dict()), 201


@app.route('/api/sessions/<sid>', methods=['DELETE'])
def delete_session(sid):
    session = sessions.get(sid)
    if not session:
        abort(404)
    if session.proc and session.proc.poll() is None:
        session.proc.terminate()
    del sessions[sid]
    return jsonify({'ok': True})


@app.route('/api/sessions/<sid>/output')
def session_output(sid):
    session = sessions.get(sid)
    if not session:
        abort(404)
    with session._lock:
        output = ''.join(session.output_buffer)
    return jsonify({'output': output, 'session': session.to_dict()})


@app.route('/api/tree')
def file_tree():
    path = os.path.realpath(request.args.get('path', os.path.expanduser('~')))

    def build(p, depth=0):
        if depth > 5:
            return []
        try:
            entries = sorted(os.scandir(p), key=lambda e: (not e.is_dir(), e.name.lower()))
        except PermissionError:
            return []
        result = []
        for e in entries:
            item = {
                'name': e.name,
                'path': e.path,
                'type': 'dir' if e.is_dir() else 'file',
                'ext': Path(e.name).suffix.lstrip('.') if e.is_file() else '',
            }
            if e.is_dir():
                item['children'] = build(e.path, depth + 1)
            result.append(item)
        return result

    return jsonify(build(path))


@app.route('/api/file', methods=['GET'])
def read_file():
    path = request.args.get('path', '')
    if not path or not os.path.isfile(path):
        return jsonify({'error': 'File not found'}), 404
    try:
        with open(path, errors='replace') as f:
            return jsonify({'content': f.read(), 'path': path})
    except Exception as exc:
        return jsonify({'error': str(exc)}), 400


@app.route('/api/stat', methods=['GET', 'POST'])
def stat_file():
    if request.method == 'POST':
        data = request.get_json(silent=True) or {}
        path = data.get('path', '')
    else:
        path = request.args.get('path', '')
    if not path or not os.path.isfile(path):
        return jsonify({'error': 'File not found'}), 404
    try:
        st = os.stat(path)
        return jsonify({'size': st.st_size, 'mtime': st.st_mtime,
                        'path': path})
    except OSError as exc:
        return jsonify({'error': str(exc)}), 400


@app.route('/api/raw/<path:filename>')
@app.route('/api/raw')
def raw_file(filename=None):
    # Path can be supplied either via ?path= or as the trailing path segment.
    # The trailing-segment form ("/api/raw/home/.../foo.png") is friendlier to
    # ad-blockers / proxies that filter on query strings.
    path = request.args.get('path') or (('/' + filename) if filename else '')
    if not path or not os.path.isfile(path):
        abort(404)
    try:
        return send_file(path, conditional=True)
    except OSError:
        abort(404)


@app.route('/api/file', methods=['PUT'])
def write_file():
    data = request.get_json() or {}
    path = data.get('path', '')
    if not path:
        return jsonify({'error': 'No path'}), 400
    try:
        parent = os.path.dirname(path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        with open(path, 'w') as f:
            f.write(data.get('content', ''))
        return jsonify({'ok': True})
    except Exception as exc:
        return jsonify({'error': str(exc)}), 400


@app.route('/api/delete', methods=['POST'])
def delete_paths():
    data = request.get_json() or {}
    paths = data.get('paths') or []
    if not isinstance(paths, list) or not paths:
        return jsonify({'error': 'paths required'}), 400
    deleted, errors = [], []
    for p in paths:
        try:
            if os.path.isdir(p) and not os.path.islink(p):
                shutil.rmtree(p)
            elif os.path.exists(p) or os.path.islink(p):
                os.remove(p)
            else:
                errors.append({'path': p, 'error': 'not found'})
                continue
            deleted.append(p)
        except Exception as exc:
            errors.append({'path': p, 'error': str(exc)})
    return jsonify({'deleted': deleted, 'errors': errors})


@app.route('/api/mkdir', methods=['POST'])
def mkdir():
    data = request.get_json() or {}
    path = data.get('path', '')
    if not path:
        return jsonify({'error': 'No path'}), 400
    if os.path.exists(path):
        return jsonify({'error': 'Already exists'}), 400
    try:
        os.makedirs(path)
        return jsonify({'ok': True, 'path': path})
    except Exception as exc:
        return jsonify({'error': str(exc)}), 400


def _duplicate_dest(src):
    """Return an unused 'foo copy.ext' / 'foo copy 2.ext' next to src."""
    parent = os.path.dirname(src)
    base = os.path.basename(src)
    if os.path.isdir(src):
        stem, ext = base, ''
    else:
        dot = base.rfind('.')
        if dot > 0:
            stem, ext = base[:dot], base[dot:]
        else:
            stem, ext = base, ''
    cand = os.path.join(parent, f'{stem} copy{ext}')
    if not os.path.exists(cand):
        return cand
    i = 2
    while True:
        cand = os.path.join(parent, f'{stem} copy {i}{ext}')
        if not os.path.exists(cand):
            return cand
        i += 1


@app.route('/api/copy', methods=['POST'])
def copy_path():
    data = request.get_json() or {}
    src = data.get('src', '')
    if not src or not os.path.exists(src):
        return jsonify({'error': 'src does not exist'}), 404
    dst = data.get('dst') or _duplicate_dest(src)
    if os.path.exists(dst):
        return jsonify({'error': 'destination already exists'}), 400
    try:
        if os.path.isdir(src) and not os.path.islink(src):
            shutil.copytree(src, dst, symlinks=True)
        else:
            shutil.copy2(src, dst, follow_symlinks=False)
        return jsonify({'ok': True, 'src': src, 'dst': dst})
    except Exception as exc:
        return jsonify({'error': str(exc)}), 400


@app.route('/api/move', methods=['POST'])
def move_path():
    data = request.get_json() or {}
    src = data.get('src', '')
    dst = data.get('dst', '')
    if not src or not dst:
        return jsonify({'error': 'src and dst required'}), 400
    if not os.path.exists(src):
        return jsonify({'error': 'src does not exist'}), 404
    if os.path.exists(dst):
        return jsonify({'error': 'destination already exists'}), 400
    try:
        parent = os.path.dirname(dst)
        if parent:
            os.makedirs(parent, exist_ok=True)
        os.rename(src, dst)
        return jsonify({'ok': True, 'src': src, 'dst': dst})
    except Exception as exc:
        return jsonify({'error': str(exc)}), 400


@app.route('/api/git/info')
def git_info():
    path = request.args.get('path', '.')
    if not os.path.isdir(path):
        return jsonify({'is_git': False})

    def run(cmd, **kw):
        try:
            r = subprocess.run(cmd, cwd=path, capture_output=True, text=True, timeout=5, **kw)
            return r.stdout if r.returncode == 0 else ''
        except (OSError, subprocess.SubprocessError):
            return ''

    # Is this a git repo?
    inside = run(['git', 'rev-parse', '--is-inside-work-tree']).strip()
    if inside != 'true':
        return jsonify({'is_git': False})

    branch     = run(['git', 'rev-parse', '--abbrev-ref', 'HEAD']).strip()
    head_sha   = run(['git', 'rev-parse', 'HEAD']).strip()
    head_short = head_sha[:7] if head_sha else ''
    remote_url = run(['git', 'config', '--get', 'remote.origin.url']).strip()

    # Local branches with current marker
    branches = []
    for line in run(['git', 'branch', '--list']).splitlines():
        line = line.rstrip()
        if not line:
            continue
        is_current = line.startswith('*')
        name = line.lstrip('* ').strip()
        if name:
            branches.append({'name': name, 'current': is_current})

    # Tags (most recent first)
    tags = [t for t in run(['git', 'tag', '--sort=-creatordate']).splitlines() if t][:25]

    # Commits with per-commit shortstat (files / +adds / -dels).
    sep = '\x1f'
    marker = '__COMMIT__'
    fmt = marker + sep.join(['%H', '%h', '%an', '%ar', '%aI', '%s'])
    raw = run(['git', 'log', f'--pretty=format:{fmt}', '--shortstat', '-n', '50'])
    commits = []
    cur = None
    for line in raw.splitlines():
        if line.startswith(marker):
            parts = line[len(marker):].split(sep)
            if len(parts) == 6:
                cur = {
                    'hash':       parts[0],
                    'short_hash': parts[1],
                    'author':     parts[2],
                    'date_rel':   parts[3],
                    'date_iso':   parts[4],
                    'subject':    parts[5],
                    'files':      0, 'add': 0, 'del': 0,
                }
                commits.append(cur)
            continue
        if cur and line.startswith(' ') and 'changed' in line:
            m = re.search(r'(\d+) files? changed', line)
            if m: cur['files'] = int(m.group(1))
            m = re.search(r'(\d+) insertions?', line)
            if m: cur['add'] = int(m.group(1))
            m = re.search(r'(\d+) deletions?', line)
            if m: cur['del'] = int(m.group(1))

    # Status summary
    status_raw = run(['git', 'status', '--porcelain=v1', '--branch'])
    staged = modified = untracked = 0
    ahead = behind = 0
    for line in status_raw.splitlines():
        if line.startswith('##'):
            m = re.search(r'ahead (\d+)', line)
            if m: ahead = int(m.group(1))
            m = re.search(r'behind (\d+)', line)
            if m: behind = int(m.group(1))
            continue
        if not line:
            continue
        x, y = line[0], line[1]
        if x in 'MADRC':
            staged += 1
        if y in 'MD':
            modified += 1
        if x == '?' and y == '?':
            untracked += 1

    return jsonify({
        'is_git':     True,
        'branch':     branch,
        'head_sha':   head_sha,
        'head_short': head_short,
        'remote_url': remote_url,
        'branches':   branches,
        'tags':       tags,
        'commits':    commits,
        'status':     {
            'staged': staged, 'modified': modified, 'untracked': untracked,
            'ahead':  ahead,  'behind':   behind,
        },
    })


@app.route('/api/git/show')
def git_show():
    path = request.args.get('path', '.')
    rev  = request.args.get('rev', '')
    if not rev or not re.match(r'^[A-Za-z0-9_./-]+$', rev):
        return jsonify({'error': 'invalid rev'}), 400
    try:
        sep = '\x1f'
        fmt = sep.join(['%H', '%h', '%an', '%ae', '%aI', '%cn', '%ce', '%cI', '%s', '%b'])
        meta = subprocess.run(['git', 'show', '-s', f'--format={fmt}', rev],
                              cwd=path, capture_output=True, text=True, timeout=5)
        if meta.returncode != 0:
            return jsonify({'error': meta.stderr.strip() or 'invalid rev'}), 400
        parts = meta.stdout.rstrip('\n').split(sep, 9)
        if len(parts) < 10:
            parts += [''] * (10 - len(parts))
        hash_, short, an, ae, ad, cn, ce, cd, subject, body = parts

        # Per-file additions/deletions
        ns = subprocess.run(['git', 'show', '--format=', '--numstat', rev],
                            cwd=path, capture_output=True, text=True, timeout=5)
        numstat = {}
        for ln in ns.stdout.splitlines():
            if not ln.strip():
                continue
            try:
                a, d, p = ln.split('\t', 2)
                numstat[p] = (int(a) if a != '-' else 0, int(d) if d != '-' else 0)
            except ValueError:
                pass

        # Full patch, then split by file boundary
        pp = subprocess.run(['git', 'show', '--format=', '--patch', rev],
                            cwd=path, capture_output=True, text=True, timeout=15)
        patch = pp.stdout or ''
        chunks = [c for c in re.split(r'(?=^diff --git )', patch, flags=re.MULTILINE) if c.strip()]

        FILE_LIMIT = 25
        LINE_LIMIT = 2000
        files = []
        for i, chunk in enumerate(chunks):
            if i >= FILE_LIMIT:
                break
            line_count = chunk.count('\n')
            m = re.match(r'^diff --git a/(\S+) b/(\S+)', chunk)
            fpath = m.group(2) if m else ''
            adds, dels = numstat.get(fpath, (0, 0))
            too_large = line_count > LINE_LIMIT
            files.append({
                'path':       fpath,
                'add':        adds,
                'del':        dels,
                'line_count': line_count,
                'too_large':  too_large,
                'patch':      '' if too_large else chunk,
            })
        files_truncated = max(0, len(chunks) - FILE_LIMIT)

        return jsonify({
            'hash':            hash_,
            'short_hash':      short,
            'subject':         subject,
            'body':            body,
            'author':          {'name': an, 'email': ae, 'date': ad},
            'committer':       {'name': cn, 'email': ce, 'date': cd},
            'files':           files,
            'files_truncated': files_truncated,
        })
    except (OSError, subprocess.SubprocessError) as exc:
        return jsonify({'error': str(exc)}), 400


@app.route('/api/diff')
def get_diff():
    path = request.args.get('path', '.')
    try:
        r = subprocess.run(['git', 'diff', 'HEAD'], cwd=path,
                           capture_output=True, text=True, timeout=5)
        diff = r.stdout or ''
        if not diff:
            r = subprocess.run(['git', 'diff'], cwd=path,
                               capture_output=True, text=True, timeout=5)
            diff = r.stdout or ''
        return jsonify({'diff': diff})
    except Exception as exc:
        return jsonify({'error': str(exc)}), 400


def _find_session_jsonl(session):
    if session.jsonl_path and os.path.exists(session.jsonl_path):
        return session.jsonl_path

    projects_dir = os.path.expanduser('~/.claude/projects')

    # Resumed sessions: Claude Code appends to the ORIGINAL file (old mtime),
    # so look it up directly by the known claude session ID.
    if session.claude_session_id:
        for f in glob.glob(f'{projects_dir}/**/{session.claude_session_id}.jsonl', recursive=True):
            if os.path.exists(f):
                session.jsonl_path = f
                return f

    # New sessions: find the newest JSONL in the cwd project dir created after we started.
    slug = re.sub(r'[^a-zA-Z0-9]', '-', session.cwd)
    session_dir = os.path.join(projects_dir, slug)
    if not os.path.isdir(session_dir):
        return None
    best, best_mtime = None, 0
    for f in glob.glob(f'{session_dir}/*.jsonl'):
        try:
            mtime = os.path.getmtime(f)
            if mtime >= session.start_time - 10 and mtime > best_mtime:
                best, best_mtime = f, mtime
        except OSError:
            pass
    if best:
        session.jsonl_path = best
    return best


@app.route('/api/sessions/<sid>/stats')
def session_stats(sid):
    session = sessions.get(sid)
    if not session:
        abort(404)
    jsonl_path = _find_session_jsonl(session)
    if not jsonl_path:
        return jsonify({'found': False})

    inp = out = cache_read = cache_write = turns = 0
    last_ctx = 0
    last_model = ''
    last_speed = ''
    try:
        with open(jsonl_path) as f:
            for line in f:
                try:
                    obj = json.loads(line)
                    if obj.get('type') != 'assistant':
                        continue
                    msg   = obj.get('message', {})
                    usage = msg.get('usage', {})
                    if not usage:
                        continue
                    i  = usage.get('input_tokens', 0)
                    o  = usage.get('output_tokens', 0)
                    cr = usage.get('cache_read_input_tokens', 0)
                    cw = usage.get('cache_creation_input_tokens', 0)
                    inp        += i
                    out        += o
                    cache_read += cr
                    cache_write += cw
                    turns      += 1
                    last_ctx    = i + cr + cw
                    m = msg.get('model', '')
                    if m and m != '<synthetic>':
                        last_model = m
                        last_speed = usage.get('speed') or ''
                except (json.JSONDecodeError, AttributeError):
                    continue
    except OSError:
        return jsonify({'found': False})

    # Sonnet 4.x pricing (per million tokens)
    cost    = (inp * 3.00 + out * 15.00 + cache_read * 0.30 + cache_write * 3.75) / 1_000_000
    cost_in = inp        * 3.00  / 1_000_000
    cost_out= out        * 15.00 / 1_000_000
    cost_cr = cache_read * 0.30  / 1_000_000
    cost_cw = cache_write* 3.75  / 1_000_000
    return jsonify({
        'found':              True,
        'input_tokens':       inp,
        'output_tokens':      out,
        'cache_read_tokens':  cache_read,
        'cache_write_tokens': cache_write,
        'turns':              turns,
        'last_ctx_tokens':    last_ctx,
        'context_max':        200_000,
        'cost_usd':           round(cost, 6),
        'cost_input':         round(cost_in, 6),
        'cost_output':        round(cost_out, 6),
        'cost_cache_read':    round(cost_cr, 6),
        'cost_cache_write':   round(cost_cw, 6),
        'model':              last_model,
        'speed':              last_speed,
    })


@app.route('/api/stats/daily')
def daily_stats():
    projects_dir = os.path.expanduser('~/.claude/projects')
    today_start = datetime.now(timezone.utc).replace(
        hour=0, minute=0, second=0, microsecond=0).timestamp()

    inp = out = cache_read = cache_write = turns = prompts = 0

    for jsonl_file in glob.glob(f'{projects_dir}/**/*.jsonl', recursive=True):
        try:
            with open(jsonl_file) as f:
                for line in f:
                    try:
                        d = json.loads(line)
                        ts = d.get('timestamp', '')
                        if ts:
                            t = datetime.fromisoformat(ts.replace('Z', '+00:00')).timestamp()
                            if t < today_start:
                                continue
                        dtype = d.get('type')
                        if dtype == 'user' and not d.get('isMeta') and d.get('userType') == 'external':
                            prompts += 1
                        elif dtype == 'assistant':
                            usage = d.get('message', {}).get('usage', {})
                            if usage and usage.get('input_tokens', 0) > 0:
                                inp        += usage.get('input_tokens', 0)
                                out        += usage.get('output_tokens', 0)
                                cache_read += usage.get('cache_read_input_tokens', 0)
                                cache_write += usage.get('cache_creation_input_tokens', 0)
                                turns      += 1
                    except (json.JSONDecodeError, AttributeError, ValueError):
                        continue
        except OSError:
            pass

    cost = (inp * 3.00 + out * 15.00 + cache_read * 0.30 + cache_write * 3.75) / 1_000_000
    cost_in    = inp        * 3.00   / 1_000_000
    cost_out   = out        * 15.00  / 1_000_000
    cost_cr    = cache_read * 0.30   / 1_000_000
    cost_cw    = cache_write * 3.75  / 1_000_000

    now = datetime.now()
    midnight = (now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    reset_secs = int((midnight - now).total_seconds())

    return jsonify({
        'input_tokens':       inp,
        'output_tokens':      out,
        'cache_read_tokens':  cache_read,
        'cache_write_tokens': cache_write,
        'turns':              turns,
        'prompts':            prompts,
        'cost_usd':           round(cost, 4),
        'cost_input':         round(cost_in, 4),
        'cost_output':        round(cost_out, 4),
        'cost_cache_read':    round(cost_cr, 4),
        'cost_cache_write':   round(cost_cw, 4),
        'reset_seconds':      reset_secs,
    })


@app.route('/api/git/file-diff')
def file_diff():
    """Return list of line numbers (in the working-copy file) that have
    unstaged modifications, parsed from `git diff --unified=0` hunk headers."""
    path = request.args.get('path', '')
    if not path or not os.path.isfile(path):
        return jsonify({'lines': []})
    repo_dir = os.path.dirname(os.path.realpath(path))
    try:
        r = subprocess.run(['git', 'diff', '--unified=0', '--', path],
                           cwd=repo_dir, capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.SubprocessError):
        return jsonify({'lines': []})
    if r.returncode != 0:
        return jsonify({'lines': []})

    modified = []
    for line in r.stdout.splitlines():
        m = re.match(r'^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@', line)
        if not m:
            continue
        start = int(m.group(1))
        count = int(m.group(2)) if m.group(2) else 1
        if count == 0:
            continue  # pure deletion — no line in current file to mark
        for i in range(count):
            modified.append(start + i)
    return jsonify({'lines': modified})


def _read_gitignore_patterns(path):
    gi = os.path.join(path, '.gitignore')
    if not os.path.isfile(gi):
        return []
    pats = []
    try:
        with open(gi) as f:
            for raw in f:
                line = raw.strip()
                if not line or line.startswith('#'):
                    continue
                if line.startswith('!'):
                    continue  # negations not supported in fallback
                pats.append(line)
    except OSError:
        return []
    return pats


def _match_gitignore(rel_path, is_dir, patterns):
    import fnmatch
    base = os.path.basename(rel_path)
    for pat in patterns:
        anchored = pat.startswith('/')
        dir_only = pat.endswith('/')
        p = pat.lstrip('/').rstrip('/')
        if not p:
            continue
        if dir_only and not is_dir:
            continue
        if anchored:
            if fnmatch.fnmatch(rel_path, p) or rel_path.startswith(p + '/'):
                return True
        else:
            if fnmatch.fnmatch(base, p):
                return True
            if '/' in p and fnmatch.fnmatch(rel_path, p):
                return True
            if rel_path.startswith(p + '/') or ('/' + p + '/') in ('/' + rel_path + '/'):
                return True
    return False


def _collect_gitignored(root, patterns, max_entries=2000):
    out = []
    if not patterns:
        return out
    for cur, dirs, files in os.walk(root):
        rel_dir = os.path.relpath(cur, root)
        # check dirs (in place so we can prune)
        keep = []
        for d in dirs:
            rel = d if rel_dir == '.' else os.path.join(rel_dir, d)
            if _match_gitignore(rel, True, patterns):
                out.append(rel)
                # don't descend further; everything inside is implicitly ignored
            else:
                keep.append(d)
        dirs[:] = keep
        for f in files:
            rel = f if rel_dir == '.' else os.path.join(rel_dir, f)
            if _match_gitignore(rel, False, patterns):
                out.append(rel)
        if len(out) >= max_entries:
            break
    return out


def _collect_repo_data(root, max_depth=6):
    """Walk root looking for nested git repos and stand-alone .gitignore files,
    so opening a parent dir that contains multiple repos still greys out each
    repo's ignored entries and surfaces each repo's working-tree changes.

    Returns (status_files, ignored_paths). Both are keyed/relative to root."""
    files = {}
    ignored = set()

    for cur, dirs, in_files in os.walk(root):
        rel = os.path.relpath(cur, root)
        if rel == '.':
            rel = ''
        depth = (rel.count(os.sep) + 1) if rel else 0
        if depth > max_depth:
            dirs[:] = []
            continue

        if '.git' in dirs or '.git' in in_files:
            try:
                ig = subprocess.run(
                    ['git', 'ls-files', '--others', '--ignored',
                     '--exclude-standard', '--directory'],
                    cwd=cur, capture_output=True, text=True, timeout=5,
                )
                for ln in ig.stdout.splitlines():
                    ln = ln.rstrip('/').strip()
                    if not ln:
                        continue
                    ignored.add(os.path.join(rel, ln) if rel else ln)
            except (OSError, subprocess.SubprocessError):
                pass
            try:
                st = subprocess.run(
                    ['git', 'status', '--porcelain'],
                    cwd=cur, capture_output=True, text=True, timeout=5,
                )
                if st.returncode == 0:
                    for line in st.stdout.splitlines():
                        if len(line) <= 3:
                            continue
                        xy = line[:2].strip()
                        name = line[3:].strip()
                        if ' -> ' in name:
                            name = name.split(' -> ')[1]
                        full = os.path.join(rel, name) if rel else name
                        files[full] = xy or '?'
            except (OSError, subprocess.SubprocessError):
                pass
            dirs[:] = []  # nested repo handles its own subtree
            continue

        if '.gitignore' in in_files:
            patterns = _read_gitignore_patterns(cur)
            for p in _collect_gitignored(cur, patterns):
                ignored.add(os.path.join(rel, p) if rel else p)

        dirs[:] = [d for d in dirs if d not in SKIP_NAMES]

    return files, list(ignored)


@app.route('/api/git/status')
def git_status():
    path = request.args.get('path', '.')
    files, ignored = _collect_repo_data(path)
    is_git = False
    try:
        r = subprocess.run(['git', 'rev-parse', '--is-inside-work-tree'],
                           cwd=path, capture_output=True, text=True, timeout=5)
        is_git = r.returncode == 0 and r.stdout.strip() == 'true'
    except (OSError, subprocess.SubprocessError):
        pass
    return jsonify({'files': files, 'ignored': ignored, 'is_git': is_git})


@app.route('/api/search')
def search_code():
    path = request.args.get('path', '.')
    query = request.args.get('q', '')
    include = request.args.get('include', '')
    exclude = request.args.get('exclude', '')
    if not query or len(query) < 2:
        return jsonify({'results': []})
    if not os.path.isdir(path):
        return jsonify({'results': []})
    try:
        cmd = ['rg', '--json', '--max-count', '20', '--max-filesize', '2M',
               '--smart-case', '--no-heading']
        for pat in re.split(r'[,\s]+', include):
            pat = pat.strip()
            if pat:
                cmd += ['-g', pat]
        for pat in re.split(r'[,\s]+', exclude):
            pat = pat.strip()
            if pat:
                cmd += ['-g', '!' + pat]
        cmd += ['--', query, path]
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
        results = {}
        total = 0
        for line in r.stdout.splitlines():
            if total >= 200:
                break
            try:
                obj = json.loads(line)
            except Exception:
                continue
            if obj.get('type') != 'match':
                continue
            data = obj.get('data', {})
            fp = data.get('path', {}).get('text') or ''
            if not fp:
                continue
            ln = data.get('line_number')
            text = (data.get('lines', {}).get('text') or '').rstrip('\n')
            if len(text) > 200:
                text = text[:200]
            rel = os.path.relpath(fp, path)
            results.setdefault(fp, {'path': fp, 'rel': rel, 'matches': []})
            results[fp]['matches'].append({'line': ln, 'text': text})
            total += 1
        return jsonify({'results': list(results.values()), 'truncated': total >= 200})
    except FileNotFoundError:
        return jsonify({'results': [], 'error': 'ripgrep not installed'})
    except subprocess.TimeoutExpired:
        return jsonify({'results': [], 'error': 'search timed out'})
    except Exception as e:
        return jsonify({'results': [], 'error': str(e)})


# ---------- SocketIO events ----------

@socketio.on('connect')
def on_socket_connect():
    if not _is_authed():
        return False  # rejects the connection
    return None


@socketio.on('join_session')
def on_join(data):
    sid = data.get('session_id')
    if sid and sid in sessions:
        join_room(sid)
        session = sessions[sid]
        with session._lock:
            replay = ''.join(session.output_buffer)
        if replay:
            emit('output', {'session_id': sid, 'data': replay})
        emit('session_status', {'session_id': sid, 'status': session.status})


@socketio.on('leave_session')
def on_leave(data):
    sid = data.get('session_id')
    if sid:
        leave_room(sid)


@socketio.on('send_input')
def on_input(data):
    sid = data.get('session_id')
    text = data.get('text', '')
    session = sessions.get(sid)
    if session and session.master_fd is not None:
        try:
            os.write(session.master_fd, text.encode())
        except OSError:
            pass


@socketio.on('resize')
def on_resize(data):
    sid = data.get('session_id')
    cols = max(20, int(data.get('cols', 80)))
    rows = max(5, int(data.get('rows', 24)))
    session = sessions.get(sid)
    if session and session.master_fd is not None:
        try:
            fcntl.ioctl(session.master_fd, termios.TIOCSWINSZ,
                        struct.pack('HHHH', rows, cols, 0, 0))
        except OSError:
            pass
        # TIOCSWINSZ on the master fd updates the size but does not always
        # deliver SIGWINCH to the child — send it explicitly so Claude redraws.
        if session.proc and session.proc.poll() is None:
            try:
                os.killpg(os.getpgid(session.proc.pid), signal.SIGWINCH)
            except (OSError, ProcessLookupError):
                try:
                    os.kill(session.proc.pid, signal.SIGWINCH)
                except (OSError, ProcessLookupError):
                    pass


@app.route('/api/claude-sessions')
def claude_sessions():
    projects_dir = os.path.expanduser('~/.claude/projects')
    results = []

    for jsonl_path in glob.glob(f'{projects_dir}/**/*.jsonl', recursive=True):
        # Skip subagent task records — they aren't user-resumable sessions
        if '/subagents/' in jsonl_path:
            continue
        try:
            lines = open(jsonl_path).readlines()
        except OSError:
            continue

        if len(lines) < 3:
            continue

        session_id = Path(jsonl_path).stem
        cwd = None
        first_msg = None
        timestamp = None
        custom_title = None  # latest /title rename if any

        for line in lines:
            try:
                obj = json.loads(line)
                t = obj.get('type')

                # Latest custom title wins
                if t == 'custom-title' and obj.get('customTitle'):
                    custom_title = obj['customTitle']
                    continue

                if t != 'user':
                    continue
                if not cwd and obj.get('cwd'):
                    cwd = obj['cwd']
                    timestamp = obj.get('timestamp')
                if obj.get('isMeta'):
                    continue
                if first_msg:
                    continue
                msg = obj.get('message', {})
                content = msg.get('content', '') if isinstance(msg, dict) else ''
                text = ''
                if isinstance(content, list):
                    for c in content:
                        if isinstance(c, dict) and c.get('type') == 'text':
                            text = c['text'].strip()
                            break
                elif isinstance(content, str):
                    text = content.strip()
                if text and not text.startswith('<'):
                    first_msg = text[:120]
            except (json.JSONDecodeError, AttributeError):
                continue

        if not cwd:
            continue

        results.append({
            'id': session_id,
            'cwd': cwd,
            'timestamp': timestamp,
            'first_msg': first_msg or '(no message preview)',
            'custom_title': custom_title,
            'message_count': len(lines),
        })

    results.sort(key=lambda s: s['timestamp'] or '', reverse=True)
    return jsonify(results[:60])


@app.route('/api/claude-sessions/<session_id>', methods=['DELETE'])
def delete_claude_session(session_id):
    """Delete a Claude session by removing its JSONL file."""
    if not re.fullmatch(r'[a-fA-F0-9-]{6,40}', session_id):
        return jsonify({'error': 'Invalid session id'}), 400
    projects_dir = os.path.expanduser('~/.claude/projects')
    targets = glob.glob(f'{projects_dir}/**/{session_id}.jsonl', recursive=True)
    if not targets:
        return jsonify({'error': 'Not found'}), 404
    deleted = 0
    for t in targets:
        try:
            os.remove(t)
            deleted += 1
        except OSError:
            pass
    return jsonify({'ok': deleted > 0, 'deleted': deleted})


@app.route('/api/config')
def get_config():
    cwd = os.path.realpath(request.args.get('cwd', os.path.expanduser('~')))
    claude_dir = os.path.expanduser('~/.claude')

    def file_entry(scope, path, default=''):
        return {'scope': scope, 'path': path,
                'exists': os.path.isfile(path),
                'default_content': default}

    claude_md = [
        file_entry('Global',  f'{claude_dir}/CLAUDE.md',          '# Claude Instructions\n\n'),
        file_entry('Project', f'{cwd}/CLAUDE.md',                 '# Project Instructions\n\n'),
    ]
    settings = [
        file_entry('Global',  f'{claude_dir}/settings.json',      '{\n  "hooks": {}\n}\n'),
        file_entry('Project', f'{cwd}/.claude/settings.json',     '{\n  "hooks": {}\n}\n'),
    ]

    # Skills: ~/.claude/commands/ (global) + <cwd>/.claude/commands/ (project)
    skills = []
    for scope, sd in [('Global', f'{claude_dir}/commands'),
                      ('Project', f'{cwd}/.claude/commands')]:
        if os.path.isdir(sd):
            for f in sorted(glob.glob(f'{sd}/*.md')):
                skills.append({'name': Path(f).stem, 'path': f, 'scope': scope})

    # Hooks: parse settings.json files for the `hooks` object.
    hooks = []
    for ent in settings:
        if not ent['exists']:
            continue
        try:
            with open(ent['path']) as f:
                cfg = json.load(f)
        except (OSError, json.JSONDecodeError):
            continue
        for event_name, configs in (cfg.get('hooks') or {}).items():
            if not isinstance(configs, list):
                continue
            for i, c in enumerate(configs):
                matcher = c.get('matcher', '*') if isinstance(c, dict) else ''
                hook_list = c.get('hooks', []) if isinstance(c, dict) else []
                cmds = []
                for h in hook_list:
                    if isinstance(h, dict) and h.get('command'):
                        cmds.append(h['command'])
                hooks.append({
                    'event':   event_name,
                    'matcher': matcher,
                    'commands': cmds,
                    'scope':   ent['scope'],
                    'path':    ent['path'],
                    'index':   i,
                })

    return jsonify({
        'claude_md':     claude_md,
        'settings':      settings,
        'skills':        skills,
        'hooks':         hooks,
        'global_commands_dir':  f'{claude_dir}/commands',
        'project_commands_dir': f'{cwd}/.claude/commands',
    })


@app.route('/api/sessions/resume', methods=['POST'])
def resume_session():
    data = request.get_json() or {}
    claude_id = data.get('claude_session_id', '').strip()
    cwd = os.path.realpath(data.get('cwd', os.path.expanduser('~')))

    if not claude_id:
        return jsonify({'error': 'No session ID'}), 400
    if not os.path.isdir(cwd):
        cwd = os.path.expanduser('~')

    # Dedup: if this Claude session is already attached to a live webui
    # session, return that one instead of spawning a duplicate.
    for existing in sessions.values():
        if existing.claude_session_id == claude_id and \
           existing.proc and existing.proc.poll() is None:
            return jsonify(existing.to_dict()), 200

    sid = str(uuid.uuid4())[:8]
    session = Session(sid, cwd)
    session.claude_session_id = claude_id  # remember so we can find its JSONL
    sessions[sid] = session
    _start_pty(sid, cwd, ['--resume', claude_id])
    return jsonify(session.to_dict()), 201


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 61234))
    host = os.environ.get('HOST', '0.0.0.0')
    print(f'Claude Code Web IDE → http://{host}:{port}')
    socketio.run(app, host=host, port=port, debug=False, allow_unsafe_werkzeug=True)
