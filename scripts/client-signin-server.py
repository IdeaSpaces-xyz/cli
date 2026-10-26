"""Opt-in local sw_space fixture: real auth/session routes, fake external Google only.
Run by client-signin-check.mjs with a selected checkout, fresh HOME/database and no env file.
"""
import logging
import socket
import secrets
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from sw_space.config import Settings
Settings.model_config["env_file"] = None
from sw_space.api.deps import set_settings
root = Path.cwd()
set_settings(Settings(data_root=str(root / "data"), lancedb_path=str(root / "lance"), billing_bypass=True,
                      environment="development", google_client_id="local-client", google_client_secret="local-fake-secret"))
from fastapi import FastAPI
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sw_space.auth import db as auth_db
from sw_space.auth.models import Base, User, WebSession
from sw_space.api.v1 import auth, desktop_auth
import uvicorn

class FakeGoogle:
    def __init__(self, **kwargs):
        self.token = None
    async def __aenter__(self): return self
    async def __aexit__(self, *args): return False
    async def fetch_token(self, *args, **kwargs): return {"access_token": "local-fake-provider-token"}
    async def get(self, url):
        class Response:
            status_code = 200
            def json(self): return {"email": "one@example.com", "name": "One", "sub": None}
        return Response()

auth.AsyncOAuth2Client = FakeGoogle
auth._auth_entity_sync_disabled = lambda: True
auth.record_google_subject_for_user = lambda *args, **kwargs: None
engine = create_engine(f"sqlite:///{root / 'auth.sqlite'}", connect_args={"check_same_thread": False})
Base.metadata.create_all(engine)
factory = sessionmaker(bind=engine, expire_on_commit=False)
auth_db._SessionLocal = factory
auth_db._SessionLocalWrite = factory
cookie = secrets.token_hex(32)
now = datetime.now(UTC)
with factory.begin() as db:
    db.add(User(id=1, email="one@example.com", name="One", username="one"))
    db.add(WebSession(id=cookie, user_id=1, expires_at=now + timedelta(hours=1), created_at=now, last_active_at=now))
app = FastAPI()
app.include_router(auth.router)
app.include_router(desktop_auth.router)
app.include_router(desktop_auth.account_router, prefix="/api/v1")
sock = socket.socket()
sock.bind(("127.0.0.1", 0))
sock.listen(128)
print(json.dumps({"service": f"http://127.0.0.1:{sock.getsockname()[1]}", "cookie": cookie}), flush=True)
logging.disable(logging.CRITICAL)
uvicorn.Server(uvicorn.Config(app, log_level="critical", access_log=False)).run(sockets=[sock])
