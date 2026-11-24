# ClipWorld plugin SDK for Python 3.8+. Copy this file next to your plugin's main file.
#
# SPDX-License-Identifier: MIT
# This SDK is MIT licensed (unlike ClipWorld itself, which is GPL-3.0-or-later), so plugins that use it
# can be under any license. Copyright (C) 2026 Lorekeeper49.
#
#   from clipworld import plugin, api
#
#   @plugin.command("hello")
#   def hello(req):
#       api.show_message("Hello!")
#
#   plugin.start()
#
# Handlers run on their own threads, so they can call api.* (which waits for ClipWorld's answer).
# print() goes to the plugin's messages, not to ClipWorld. See PLUGINS.md for the whole protocol.
import json
import sys
import threading

_out = sys.stdout
# print() would break the protocol: send it to the plugin's messages (stderr) instead.
sys.stdout = sys.stderr
_write_lock = threading.Lock()
_pending = {}
_pending_lock = threading.Lock()
_next_id = [1]


class ClipWorldError(Exception):
    """ClipWorld answered a request with an error."""


def _send(msg):
    msg = dict(jsonrpc="2.0", **msg)
    with _write_lock:
        _out.write(json.dumps(msg, ensure_ascii=False) + "\n")
        _out.flush()


def call(method, params=None):
    """Sends a request to ClipWorld and waits for its answer."""
    with _pending_lock:
        rid = _next_id[0]
        _next_id[0] += 1
        slot = {"event": threading.Event()}
        _pending[rid] = slot
    _send({"id": rid, "method": method, "params": params or {}})
    slot["event"].wait()
    if "error" in slot:
        raise ClipWorldError(slot["error"])
    return slot.get("result")


def notify(method, params=None):
    """Sends a message that needs no answer."""
    _send({"method": method, "params": params or {}})


class _Api:
    """Everything a plugin can ask ClipWorld."""

    def get_project(self): return call("getProject")
    def set_project(self, project): return call("setProject", {"project": project})
    def get_selection(self): return call("getSelection")
    def set_selection(self, ids): return call("setSelection", {"ids": ids})
    def get_playhead(self): return call("getPlayhead")
    def set_playhead(self, time): return call("setPlayhead", {"time": time})
    def import_media(self, paths): return call("importMedia", {"paths": paths})
    def add_media_clip(self, media_id, start=None, track_id=None):
        return call("addMediaClip", {"mediaId": media_id, "start": start, "trackId": track_id})
    def add_text_clip(self, start=None, text=None, duration=None):
        return call("addTextClip", {"start": start, "text": text or {}, "duration": duration})
    def update_clip(self, clip_id, changes): return call("updateClip", {"id": clip_id, "changes": changes})
    def remove_clips(self, ids): return call("removeClips", {"ids": ids})
    def add_effect(self, clip_id, effect_type, params=None):
        return call("addEffect", {"clipId": clip_id, "type": effect_type, "params": params or {}})
    def add_subtitle_track(self, name, cues, language="eng", add_clip=True):
        return call("addSubtitleTrack", {"name": name, "cues": cues, "language": language, "addClip": add_clip})
    def show_message(self, text, kind="info"): return call("showMessage", {"text": text, "kind": kind})
    def ask_user(self, title=None, fields=None, message=None, ok_label=None):
        return call("askUser", {"title": title, "fields": fields or [], "message": message, "okLabel": ok_label})
    def pick_file(self, save=False, title=None, default_name=None, filters=None):
        return call("pickFile", {"save": save, "title": title, "defaultName": default_name, "filters": filters})
    def get_app_info(self): return call("getAppInfo")
    def post_to_panel(self, panel, data): notify("postToPanel", {"panel": panel, "data": data})


api = _Api()


class _Plugin:
    def __init__(self):
        self._handlers = {"command": {}, "import": {}, "export": {}, "effect": {}, "panel": {}}
        self.info = None
        self._on_shutdown = None

    def _register(self, kind, id_):
        def deco(fn):
            self._handlers[kind][id_] = fn
            return fn
        return deco

    def command(self, id_):
        """A command: fn(req) with req["selection"] and req["playhead"]. Return a string to show it."""
        return self._register("command", id_)

    def importer(self, id_):
        """An importer: fn(req) with req["path"]."""
        return self._register("import", id_)

    def exporter(self, id_):
        """An exporter: fn(req) with req["path"]: write the file there."""
        return self._register("export", id_)

    def effect(self, id_):
        """An effect: fn(params, info) returns the ffmpeg filter chain for those settings."""
        return self._register("effect", id_)

    def panel(self, id_):
        """Messages from one of this plugin's windows: fn(data)."""
        return self._register("panel", id_)

    def on_shutdown(self, fn):
        self._on_shutdown = fn
        return fn

    def _pick(self, kind, id_):
        fn = self._handlers[kind].get(id_)
        if fn is None:
            raise ClipWorldError('This plugin has no %s "%s"' % (kind, id_))
        return fn

    def _handle(self, method, p):
        if method == "initialize":
            self.info = p
            return {"ok": True}
        if method == "command":
            return self._pick("command", p.get("command"))(p)
        if method == "import":
            return self._pick("import", p.get("importer"))(p)
        if method == "export":
            return self._pick("export", p.get("exporter"))(p)
        if method == "effectFilter":
            info = {k: v for k, v in p.items() if k not in ("effect", "params")}
            return {"filter": self._pick("effect", p.get("effect"))(p.get("params") or {}, info)}
        raise ClipWorldError('Unknown method "%s"' % method)

    def _serve(self, msg):
        try:
            result = self._handle(msg["method"], msg.get("params") or {})
            _send({"id": msg["id"], "result": result})
        except Exception as err:  # noqa: BLE001 - every error goes back to ClipWorld
            _send({"id": msg["id"], "error": {"code": -32000, "message": str(err) or type(err).__name__}})

    def start(self):
        """Reads ClipWorld's messages until it closes the plugin."""
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except ValueError:
                continue
            method = msg.get("method")
            if method:
                if msg.get("id") is None:
                    p = msg.get("params") or {}
                    if method == "panelMessage":
                        fn = self._handlers["panel"].get(p.get("panel"))
                        if fn:
                            threading.Thread(target=fn, args=(p.get("data"),), daemon=True).start()
                    elif method == "shutdown":
                        if self._on_shutdown:
                            self._on_shutdown()
                        return
                    continue
                threading.Thread(target=self._serve, args=(msg,), daemon=True).start()
            else:
                with _pending_lock:
                    slot = _pending.pop(msg.get("id"), None)
                if slot is not None:
                    if msg.get("error"):
                        slot["error"] = msg["error"].get("message", "Error")
                    else:
                        slot["result"] = msg.get("result")
                    slot["event"].set()


plugin = _Plugin()
