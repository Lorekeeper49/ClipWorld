"""An example ClipWorld plugin in Python: exports the clips as a CSV spreadsheet, and imports titles from
one (rows of start seconds, length in seconds, and text)."""
import csv
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from clipworld import api, plugin  # noqa: E402


@plugin.exporter("clipList")
def export_clips(req):
    project = api.get_project()
    media = {m["id"]: m for m in project["media"]}
    with open(req["path"], "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(["start", "end", "length", "type", "name", "file"])
        for c in sorted(project["clips"], key=lambda c: c["start"]):
            name = (c.get("text") or {}).get("content") or c.get("name") or ""
            file = media.get(c.get("mediaId"), {}).get("path", "")
            w.writerow([f"{c['start']:.3f}", f"{c['start'] + c['duration']:.3f}", f"{c['duration']:.3f}", c["type"], name, file])
    n = len(project["clips"])
    return {"message": f"Wrote {n} clip{'' if n == 1 else 's'}"}


@plugin.importer("titles")
def import_titles(req):
    added = []
    with open(req["path"], newline="", encoding="utf-8-sig") as f:
        for row in csv.reader(f):
            if len(row) < 3:
                continue
            try:
                start, length = float(row[0]), float(row[1])
            except ValueError:
                continue  # a heading row
            added.append(api.add_text_clip(start, {"content": row[2]}, length))
    api.set_selection(added)
    return {"message": f"Added {len(added)} title{'' if len(added) == 1 else 's'}"}


plugin.start()
