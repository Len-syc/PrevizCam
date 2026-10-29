"""Serve this workspace on loopback only: python serve.py [--port 8899]."""
import argparse
import json
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

ROOT = Path(__file__).resolve().parent

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def do_GET(self):
        if self.path == '/.well-known/previzcam.json':
            data = json.dumps({'app': 'PrevizCam', 'root': str(ROOT), 'agentBridgeVersion': 1}).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        super().do_GET()

    def list_directory(self, path):
        self.send_error(404, 'Directory listing disabled')

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8899)
    options = parser.parse_args()
    server = ThreadingHTTPServer(('127.0.0.1', options.port), Handler)
    print(f'PrevizCam: http://127.0.0.1:{options.port}/', flush=True)
    server.serve_forever()
