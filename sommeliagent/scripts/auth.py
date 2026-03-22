# /// script
# requires-python = ">=3.11"
# dependencies = ["httpx"]
# ///
"""
Spotify OAuth flow for SommeliAgent.
Opens browser, runs local callback server, saves token.
"""

import html
import http.server
import json
import os
import secrets
import stat
import sys
import threading
import urllib.parse
import webbrowser
from pathlib import Path

import httpx

CONFIG_DIR = Path.home() / ".sommeliagent"
TOKEN_FILE = CONFIG_DIR / "token.json"
REDIRECT_URI = "http://localhost:8888/callback"
SCOPES = "user-top-read user-read-recently-played"


def get_credentials() -> tuple[str, str]:
    client_id = os.environ.get("SPOTIFY_CLIENT_ID", "")
    client_secret = os.environ.get("SPOTIFY_CLIENT_SECRET", "")
    if not client_id or not client_secret:
        print("Error: SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET must be set.", file=sys.stderr)
        print("Get them from https://developer.spotify.com/dashboard", file=sys.stderr)
        sys.exit(1)
    return client_id, client_secret


def save_token(token_data: dict) -> None:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    tmp = TOKEN_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(token_data, indent=2))
    tmp.chmod(stat.S_IRUSR | stat.S_IWUSR)  # 600 — owner only
    tmp.replace(TOKEN_FILE)
    print(f"Token saved to {TOKEN_FILE}")


def load_token() -> dict | None:
    if TOKEN_FILE.exists():
        return json.loads(TOKEN_FILE.read_text())
    return None


def refresh_access_token(refresh_token: str, client_id: str, client_secret: str) -> dict:
    resp = httpx.post(
        "https://accounts.spotify.com/api/token",
        data={
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "client_id": client_id,
            "client_secret": client_secret,
        },
    )
    resp.raise_for_status()
    data = resp.json()
    if "refresh_token" not in data:
        data["refresh_token"] = refresh_token
    return data


def get_access_token() -> str | None:
    """Get a valid access token, refreshing if needed. Returns None if unavailable."""
    import time as _time

    token_data = load_token()

    if token_data and "refresh_token" in token_data:
        # Return existing token if it hasn't expired yet
        expires_at = token_data.get("expires_at", 0)
        if expires_at and _time.time() < expires_at and token_data.get("access_token"):
            return token_data["access_token"]

        # Need to refresh — now we need credentials
        client_id, client_secret = get_credentials()
        try:
            refreshed = refresh_access_token(
                token_data["refresh_token"], client_id, client_secret
            )
            expires_in = refreshed.get("expires_in", 3600)
            refreshed["expires_at"] = _time.time() + expires_in
            save_token(refreshed)
            return refreshed["access_token"]
        except Exception as e:
            print(f"Token refresh failed: {e}", file=sys.stderr)

    return None


def _make_callback_handler(expected_state: str):
    """Create a callback handler that validates the OAuth state parameter."""

    class CallbackHandler(http.server.BaseHTTPRequestHandler):
        auth_code: str | None = None
        error: str | None = None

        def do_GET(self):
            query = urllib.parse.urlparse(self.path).query
            params = urllib.parse.parse_qs(query)

            # Validate state to prevent CSRF
            received_state = params.get("state", [None])[0]
            if received_state != expected_state:
                self.send_response(400)
                self.send_header("Content-Type", "text/html")
                self.end_headers()
                self.wfile.write(b"<html><body><h1>Invalid state parameter</h1></body></html>")
                return

            if "code" in params:
                CallbackHandler.auth_code = params["code"][0]
                self.send_response(200)
                self.send_header("Content-Type", "text/html")
                self.end_headers()
                self.wfile.write(
                    b"<html><body><h1>SommeliAgent connected!</h1>"
                    b"<p>You can close this tab and return to your terminal.</p></body></html>"
                )
            elif "error" in params:
                CallbackHandler.error = params["error"][0]
                self.send_response(400)
                self.send_header("Content-Type", "text/html")
                self.end_headers()
                safe_error = html.escape(params["error"][0])
                self.wfile.write(f"<html><body><h1>Error: {safe_error}</h1></body></html>".encode())
            else:
                self.send_response(400)
                self.end_headers()

        def log_message(self, format, *args):
            pass

    return CallbackHandler


def run_oauth_flow() -> None:
    client_id, client_secret = get_credentials()
    state = secrets.token_urlsafe(16)

    auth_url = (
        "https://accounts.spotify.com/authorize?"
        + urllib.parse.urlencode(
            {
                "response_type": "code",
                "client_id": client_id,
                "scope": SCOPES,
                "redirect_uri": REDIRECT_URI,
                "state": state,
            }
        )
    )

    handler_class = _make_callback_handler(state)

    try:
        server = http.server.HTTPServer(("localhost", 8888), handler_class)
    except OSError as e:
        print(f"Error: Could not start callback server on port 8888: {e}", file=sys.stderr)
        print("Make sure nothing else is using that port.", file=sys.stderr)
        sys.exit(1)

    # Handle up to 3 requests (in case of preflight/favicon/etc hitting first)
    def serve():
        for _ in range(3):
            server.handle_request()
            if handler_class.auth_code or handler_class.error:
                break

    server_thread = threading.Thread(target=serve, daemon=True)
    server_thread.start()

    print("Opening Spotify authorization in your browser...")
    print(f"If it doesn't open, visit: {auth_url}")
    webbrowser.open(auth_url)

    server_thread.join(timeout=120)
    server.server_close()

    if handler_class.error:
        print(f"Error: Spotify returned: {handler_class.error}", file=sys.stderr)
        sys.exit(1)

    if not handler_class.auth_code:
        print("Error: No authorization code received (timed out after 120s).", file=sys.stderr)
        sys.exit(1)

    # Exchange code for token
    resp = httpx.post(
        "https://accounts.spotify.com/api/token",
        data={
            "grant_type": "authorization_code",
            "code": handler_class.auth_code,
            "redirect_uri": REDIRECT_URI,
            "client_id": client_id,
            "client_secret": client_secret,
        },
    )
    resp.raise_for_status()
    token_data = resp.json()
    import time as _time
    token_data["expires_at"] = _time.time() + token_data.get("expires_in", 3600)
    save_token(token_data)
    print("Spotify connected successfully!")


if __name__ == "__main__":
    token = get_access_token()
    if token:
        print("Already authenticated. Token refreshed successfully.")
        print(f"Token file: {TOKEN_FILE}")
    else:
        run_oauth_flow()
