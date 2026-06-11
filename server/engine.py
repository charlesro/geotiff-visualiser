#!/usr/bin/env python3
"""Local DuckDB engine for Polygon Time-Series PCA.

Serves the SQL endpoint the app's "Database" tab talks to:

    GET  /api/status   -> {"status": "online", ...}
    POST /query        -> {"status": "success", "columns": [...], "rows": [...]}
                          body: {"query": "<sql>"} (multi-statement supported;
                          rows come from the last statement)

Only needs the Python stdlib + duckdb:

    pip install duckdb
    python3 server/engine.py            # listens on http://localhost:8080
    PORT=9000 python3 server/engine.py  # custom port
"""

import json
import math
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import duckdb

PORT = int(os.environ.get("PORT", "8080"))

db = duckdb.connect()  # in-memory; temp tables live for the process lifetime
db_lock = threading.Lock()


def clean_value(val):
    if isinstance(val, (int, str, bool, type(None))):
        return val
    if isinstance(val, float):
        return None if (math.isnan(val) or math.isinf(val)) else val
    return str(val)


class Handler(BaseHTTPRequestHandler):
    def _send_json(self, payload, status=200):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()

    def do_GET(self):
        if self.path.split("?")[0] == "/api/status":
            self._send_json({
                "status": "online",
                "has_duckdb": True,
                "duckdb_version": duckdb.__version__,
            })
        else:
            self._send_json({"status": "error", "message": "Not found"}, 404)

    def do_POST(self):
        if self.path.split("?")[0] != "/query":
            self._send_json({"status": "error", "message": "Not found"}, 404)
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
            data = json.loads(self.rfile.read(length) or b"{}")
            sql = data.get("query")
            if not sql:
                self._send_json({"status": "error", "message": "No query provided"}, 400)
                return

            with db_lock:
                res = db.execute(sql)
                columns = [d[0] for d in res.description] if res.description else []
                rows = [
                    {col: clean_value(row[i]) for i, col in enumerate(columns)}
                    for row in res.fetchall()
                ]

            self._send_json({"status": "success", "columns": columns, "rows": rows})
        except Exception as e:  # surfaced verbatim in the app's error note
            self._send_json({"status": "error", "message": str(e)}, 500)

    def log_message(self, fmt, *args):
        print(f"[engine] {self.address_string()} {fmt % args}")


if __name__ == "__main__":
    print(f"DuckDB engine (duckdb {duckdb.__version__}) listening on http://localhost:{PORT}")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
