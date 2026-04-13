#!/usr/bin/env python3
"""
FixIt Backend — Pure Python stdlib, zero dependencies
HTTP API + WebSocket server + SQLite database
"""
import http.server, socketserver, sqlite3, json, threading, hashlib
import base64, struct, os, sys, time, uuid, hmac, re, io
from urllib.parse import urlparse, parse_qs

PORT     = int(os.environ.get("PORT", 3001))
DB_PATH  = os.path.join(os.path.dirname(__file__), "db", "fixit.db")
ANTHROPIC_KEY = os.environ.get("ANTHROPIC_API_KEY", "")

# ─── ANSI colours for pretty logs ────────────────────────────────────────────
R="\033[91m"; G="\033[92m"; Y="\033[93m"; B="\033[94m"; M="\033[95m"; C="\033[96m"; W="\033[0m"
def log(colour, tag, msg): print(f"{colour}[{tag}]{W} {msg}")

# ═══════════════════════════════════════════════════════════════════════════════
# DATABASE — SQLite
# ═══════════════════════════════════════════════════════════════════════════════
def get_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn

def init_db():
    conn = get_db()
    conn.executescript("""
    CREATE TABLE IF NOT EXISTS users (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        uuid        TEXT UNIQUE DEFAULT (lower(hex(randomblob(16)))),
        email       TEXT UNIQUE NOT NULL,
        phone       TEXT,
        first_name  TEXT NOT NULL,
        last_name   TEXT NOT NULL,
        role        TEXT NOT NULL CHECK(role IN ('homeowner','contractor','admin')),
        password_hash TEXT,
        created_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS contractors (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_user_id   INTEGER REFERENCES users(id),
        business_name   TEXT NOT NULL,
        avatar          TEXT NOT NULL,
        specialties     TEXT NOT NULL,   -- JSON array
        base_price      REAL DEFAULT 150,
        lat             REAL NOT NULL,
        lng             REAL NOT NULL,
        service_miles   REAL DEFAULT 10,
        verified        INTEGER DEFAULT 0,
        licensed        INTEGER DEFAULT 0,
        rating          REAL DEFAULT 4.5,
        review_count    INTEGER DEFAULT 0,
        jobs_done       INTEGER DEFAULT 0,
        status          TEXT DEFAULT 'available',
        stripe_account  TEXT,
        created_at      TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS bookings (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        homeowner_id    INTEGER REFERENCES users(id),
        contractor_id   INTEGER REFERENCES contractors(id),
        category        TEXT,
        description     TEXT,
        photo_url       TEXT,
        est_price       REAL,
        final_price     REAL,
        status          TEXT DEFAULT 'pending',
        stripe_intent   TEXT,
        scheduled_at    TEXT,
        paid_at         TEXT,
        created_at      TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS chat_rooms (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        booking_id      INTEGER REFERENCES bookings(id),
        homeowner_id    INTEGER REFERENCES users(id),
        contractor_id   INTEGER REFERENCES users(id),
        created_at      TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS messages (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id         INTEGER REFERENCES chat_rooms(id),
        sender_id       INTEGER REFERENCES users(id),
        text            TEXT,
        msg_type        TEXT DEFAULT 'text',
        read_at         TEXT,
        created_at      TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS push_subs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     INTEGER REFERENCES users(id),
        endpoint    TEXT UNIQUE,
        p256dh      TEXT,
        auth        TEXT,
        created_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS reviews (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        booking_id      INTEGER REFERENCES bookings(id),
        contractor_id   INTEGER REFERENCES contractors(id),
        homeowner_id    INTEGER REFERENCES users(id),
        rating          INTEGER,
        comment         TEXT,
        created_at      TEXT DEFAULT (datetime('now'))
    );

    -- Seed contractors if empty
    INSERT OR IGNORE INTO users (id,email,first_name,last_name,role)
    VALUES
      (1,'mario@mp.com','Mario','Martinez','contractor'),
      (2,'bob@br.com','Bob','Ridge','contractor'),
      (3,'quinn@qf.com','Quinn','Fix','contractor'),
      (4,'alex@home.com','Alex','Johnson','homeowner');

    INSERT OR IGNORE INTO contractors (id,owner_user_id,business_name,avatar,specialties,base_price,lat,lng,verified,licensed,rating,review_count,jobs_done,status)
    VALUES
      (1,1,'Martinez Pro Plumbing','MP','["Plumbing","Leak Repair","Water Heater"]',185,34.0522,-118.2437,1,1,4.9,312,47,'available'),
      (2,2,'BlueRidge Electric','BR','["Electrical","Wiring","Panel Upgrade"]',210,34.0560,-118.2510,1,1,4.7,194,31,'busy'),
      (3,3,'QuickFix Handyman','QF','["Drywall","General Repair","Painting"]',140,34.0480,-118.2380,0,0,4.5,87,22,'available');
    """)
    conn.commit()
    conn.close()
    log(G, "DB", f"SQLite ready → {DB_PATH}")

# ─── Haversine distance (miles) ───────────────────────────────────────────────
import math
def haversine(lat1, lng1, lat2, lng2):
    R = 3958.8
    dlat = math.radians(lat2 - lat1)
    dlng = math.radians(lng2 - lng1)
    a = math.sin(dlat/2)**2 + math.cos(math.radians(lat1))*math.cos(math.radians(lat2))*math.sin(dlng/2)**2
    return R * 2 * math.asin(math.sqrt(a))

# ═══════════════════════════════════════════════════════════════════════════════
# WEBSOCKET SERVER (RFC 6455) — Pure Python
# ═══════════════════════════════════════════════════════════════════════════════
import socket as _socket

# user_id → list of socket objects
ws_clients = {}
ws_lock = threading.Lock()

def ws_accept(sock, headers):
    """Complete WebSocket handshake."""
    key = headers.get("Sec-WebSocket-Key","").strip()
    magic = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
    accept = base64.b64encode(hashlib.sha1((key+magic).encode()).digest()).decode()
    resp = (
        "HTTP/1.1 101 Switching Protocols\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Accept: {accept}\r\n\r\n"
    )
    sock.sendall(resp.encode())

def ws_recv_frame(sock):
    """Read one WebSocket frame. Returns (opcode, payload) or None on close."""
    try:
        h = b""
        while len(h) < 2:
            chunk = sock.recv(2 - len(h))
            if not chunk: return None
            h += chunk
        fin = (h[0] & 0x80) != 0
        opcode = h[0] & 0x0F
        masked = (h[1] & 0x80) != 0
        length = h[1] & 0x7F

        if length == 126:
            ext = sock.recv(2)
            length = struct.unpack(">H", ext)[0]
        elif length == 127:
            ext = sock.recv(8)
            length = struct.unpack(">Q", ext)[0]

        mask = sock.recv(4) if masked else b"\x00\x00\x00\x00"
        raw = b""
        while len(raw) < length:
            chunk = sock.recv(length - len(raw))
            if not chunk: return None
            raw += chunk

        payload = bytes(b ^ mask[i % 4] for i, b in enumerate(raw))
        return (opcode, payload)
    except Exception:
        return None

def ws_send(sock, data: str):
    """Send a text WebSocket frame (unmasked, server→client)."""
    try:
        payload = data.encode("utf-8")
        n = len(payload)
        if n <= 125:
            header = bytes([0x81, n])
        elif n <= 65535:
            header = bytes([0x81, 126]) + struct.pack(">H", n)
        else:
            header = bytes([0x81, 127]) + struct.pack(">Q", n)
        sock.sendall(header + payload)
    except Exception:
        pass

def broadcast_to_user(user_id, payload: dict):
    """Send JSON payload to all sockets for user_id."""
    msg = json.dumps(payload)
    with ws_lock:
        for sock in list(ws_clients.get(str(user_id), [])):
            ws_send(sock, msg)

def ws_handle_client(sock, user_id, path):
    """Handle one WebSocket client session."""
    uid = str(user_id)
    with ws_lock:
        ws_clients.setdefault(uid, []).append(sock)
    log(C, "WS", f"User {uid} connected ({path})")

    try:
        ws_send(sock, json.dumps({"type": "connected", "userId": user_id}))
        while True:
            frame = ws_recv_frame(sock)
            if frame is None:
                break
            opcode, payload = frame
            if opcode == 8:   # close
                break
            if opcode == 9:   # ping → pong
                ws_send(sock, json.dumps({"type":"pong"}))
                continue
            if opcode == 1:   # text
                try:
                    msg = json.loads(payload.decode())
                    handle_ws_message(sock, uid, msg)
                except Exception as e:
                    ws_send(sock, json.dumps({"type":"error","message":str(e)}))
    except Exception:
        pass
    finally:
        with ws_lock:
            clients = ws_clients.get(uid, [])
            if sock in clients:
                clients.remove(sock)
        log(Y, "WS", f"User {uid} disconnected")
        try: sock.close()
        except: pass

def handle_ws_message(sock, user_id, msg):
    t = msg.get("type")
    if t == "ping":
        ws_send(sock, json.dumps({"type":"pong"}))
    elif t == "typing":
        room_id = msg.get("chatRoomId")
        if room_id:
            db = get_db()
            row = db.execute("SELECT * FROM chat_rooms WHERE id=?", (room_id,)).fetchone()
            db.close()
            if row:
                recipient = row["contractor_id"] if user_id == str(row["homeowner_id"]) else row["homeowner_id"]
                broadcast_to_user(recipient, {"type":"typing","chatRoomId":room_id,"userId":user_id})
    elif t == "mark_read":
        room_id = msg.get("chatRoomId")
        if room_id:
            db = get_db()
            db.execute("UPDATE messages SET read_at=datetime('now') WHERE room_id=? AND sender_id!=? AND read_at IS NULL",
                       (room_id, user_id))
            db.commit()
            db.close()

# ═══════════════════════════════════════════════════════════════════════════════
# HTTP ROUTER
# ═══════════════════════════════════════════════════════════════════════════════
ROUTES = []   # [(method, pattern_regex, handler)]

def route(method, pattern):
    def decorator(fn):
        ROUTES.append((method, re.compile("^" + pattern + "$"), fn))
        return fn
    return decorator

def json_response(handler, data, status=200):
    body = json.dumps(data, default=str).encode()
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.end_headers()
    handler.wfile.write(body)

def read_body(handler):
    length = int(handler.headers.get("Content-Length", 0))
    if length == 0: return {}
    ct = handler.headers.get("Content-Type", "")
    raw = handler.rfile.read(length)
    if "application/json" in ct:
        try: return json.loads(raw)
        except: return {}
    return {}

# ─── Health ──────────────────────────────────────────────────────────────────
@route("GET", r"/")
def index(handler, match, qs, body):
    import os
    path = os.path.join(os.path.dirname(__file__), "..", "public", "index.html")
    with open(path) as f: content = f.read()
    body = content.encode()
    handler.send_response(200)
    handler.send_header("Content-Type", "text/html")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)

@route("GET", r"/icon.png")
def serve_icon(handler, match, qs, body):
    import os
    path = os.path.join(os.path.dirname(__file__), "..", "public", "icon.png")
    with open(path, "rb") as f: data = f.read()
    handler.send_response(200)
    handler.send_header("Content-Type", "image/png")
    handler.send_header("Content-Length", str(len(data)))
    handler.end_headers()
    handler.wfile.write(data)

@route("GET", r"/api/health")
def health(handler, match, qs, body):
    json_response(handler, {"status":"ok","time":time.time(),"ws_users":len(ws_clients)})

# ─── Contractors nearby ───────────────────────────────────────────────────────
@route("GET", r"/api/contractors/nearby")
def contractors_nearby(handler, match, qs, body):
    try:
        lat  = float(qs.get("lat", [34.052])[0])
        lng  = float(qs.get("lng", [-118.248])[0])
        radius = float(qs.get("radius", [10])[0])
        category = qs.get("category", [None])[0]
    except:
        return json_response(handler, {"error":"invalid params"}, 400)

    db = get_db()
    rows = db.execute("SELECT c.*, u.first_name||' '||u.last_name AS owner_name, u.phone FROM contractors c JOIN users u ON c.owner_user_id=u.id WHERE c.status != 'offline'").fetchall()
    db.close()

    results = []
    for r in rows:
        d = haversine(lat, lng, r["lat"], r["lng"])
        if d > radius: continue
        specs = json.loads(r["specialties"])
        if category and category not in specs: continue
        eta_min = max(15, int(d * 2 * 60))  # rough: 30mph
        results.append({
            "id": r["id"], "business_name": r["business_name"],
            "avatar": r["avatar"], "rating": r["rating"],
            "review_count": r["review_count"], "verified": bool(r["verified"]),
            "licensed": bool(r["licensed"]), "status": r["status"],
            "base_price": r["base_price"], "specialties": specs,
            "distance_miles": round(d, 1),
            "eta_human": f"~{eta_min}min" if eta_min < 60 else f"~{eta_min//60}h",
            "owner_name": r["owner_name"], "phone": r["phone"],
            "jobs_done": r["jobs_done"],
        })

    results.sort(key=lambda x: (0 if x["status"]=="available" else 1, x["distance_miles"]))
    json_response(handler, {"contractors": results, "count": len(results)})

# ─── Single contractor ────────────────────────────────────────────────────────
@route("GET", r"/api/contractors/(\d+)")
def contractor_detail(handler, match, qs, body):
    cid = int(match.group(1))
    db = get_db()
    row = db.execute("SELECT c.*, u.first_name||' '||u.last_name AS owner_name FROM contractors c JOIN users u ON c.owner_user_id=u.id WHERE c.id=?", (cid,)).fetchone()
    db.close()
    if not row: return json_response(handler, {"error":"not found"}, 404)
    d = dict(row)
    d["specialties"] = json.loads(d["specialties"])
    json_response(handler, d)

# ─── Create booking ───────────────────────────────────────────────────────────
@route("POST", r"/api/bookings")
def create_booking(handler, match, qs, body):
    db = get_db()
    try:
        cur = db.execute("""
            INSERT INTO bookings (homeowner_id, contractor_id, category, description, est_price, scheduled_at)
            VALUES (?,?,?,?,?,?)
        """, (body.get("homeownerId",4), body.get("contractorId"),
              body.get("category"), body.get("description"),
              body.get("estPrice"), body.get("scheduledAt")))
        booking_id = cur.lastrowid

        # Create chat room
        cur2 = db.execute("""
            INSERT INTO chat_rooms (booking_id, homeowner_id, contractor_id)
            VALUES (?,?,?)
        """, (booking_id, body.get("homeownerId",4),
              # get contractor's owner user_id
              db.execute("SELECT owner_user_id FROM contractors WHERE id=?", (body.get("contractorId"),)).fetchone()["owner_user_id"]))
        room_id = cur2.lastrowid
        db.commit()

        booking = dict(db.execute("SELECT * FROM bookings WHERE id=?", (booking_id,)).fetchone())

        # Notify contractor via WebSocket
        contractor = db.execute("SELECT owner_user_id FROM contractors WHERE id=?", (body.get("contractorId"),)).fetchone()
        if contractor:
            broadcast_to_user(contractor["owner_user_id"], {
                "type": "new_lead",
                "booking": {**booking, "chatRoomId": room_id},
                "message": "New job request!"
            })

        json_response(handler, {"booking": booking, "chatRoomId": room_id}, 201)
    except Exception as e:
        json_response(handler, {"error": str(e)}, 500)
    finally:
        db.close()

# ─── Get bookings ─────────────────────────────────────────────────────────────
@route("GET", r"/api/bookings")
def get_bookings(handler, match, qs, body):
    role = qs.get("role", ["homeowner"])[0]
    user_id = int(qs.get("userId", [4])[0])
    db = get_db()
    if role == "contractor":
        rows = db.execute("""
            SELECT b.*, c.business_name AS contractor_name,
              u.first_name||' '||u.last_name AS homeowner_name,
              cr.id AS chat_room_id
            FROM bookings b
            JOIN contractors c ON b.contractor_id=c.id
            JOIN users u ON b.homeowner_id=u.id
            LEFT JOIN chat_rooms cr ON cr.booking_id=b.id
            WHERE c.owner_user_id=? ORDER BY b.created_at DESC
        """, (user_id,)).fetchall()
    else:
        rows = db.execute("""
            SELECT b.*, c.business_name AS contractor_name,
              u.first_name||' '||u.last_name AS homeowner_name,
              cr.id AS chat_room_id
            FROM bookings b
            JOIN contractors c ON b.contractor_id=c.id
            JOIN users u ON b.homeowner_id=u.id
            LEFT JOIN chat_rooms cr ON cr.booking_id=b.id
            WHERE b.homeowner_id=? ORDER BY b.created_at DESC
        """, (user_id,)).fetchall()
    db.close()
    json_response(handler, [dict(r) for r in rows])

# ─── Stripe payment (simulated — swap client_secret for real Stripe) ──────────
@route("POST", r"/api/payments/create-intent")
def create_payment_intent(handler, match, qs, body):
    contractor_id = body.get("contractorId")
    booking_id    = body.get("bookingId")
    amount        = body.get("amount", 0)

    if ANTHROPIC_KEY and os.environ.get("STRIPE_SECRET_KEY"):
        # Real Stripe — make actual API call
        import urllib.request
        stripe_key = os.environ["STRIPE_SECRET_KEY"]
        contractor_row = get_db().execute("SELECT stripe_account FROM contractors WHERE id=?", (contractor_id,)).fetchone()
        stripe_acct = contractor_row["stripe_account"] if contractor_row else None
        data = f"amount={amount}&currency=usd&automatic_payment_methods[enabled]=true"
        if stripe_acct:
            data += f"&application_fee_amount=999&transfer_data[destination]={stripe_acct}"
        req = urllib.request.Request(
            "https://api.stripe.com/v1/payment_intents",
            data=data.encode(),
            headers={"Authorization": f"Bearer {stripe_key}", "Content-Type": "application/x-www-form-urlencoded"}
        )
        try:
            with urllib.request.urlopen(req) as resp:
                intent = json.loads(resp.read())
                db = get_db()
                db.execute("UPDATE bookings SET stripe_intent=? WHERE id=?", (intent["id"], booking_id))
                db.commit()
                db.close()
                return json_response(handler, {"clientSecret": intent["client_secret"], "intentId": intent["id"]})
        except Exception as e:
            return json_response(handler, {"error": str(e)}, 500)

    # Simulated intent (no Stripe key set)
    fake_secret = f"pi_demo_{uuid.uuid4().hex[:16]}_secret_{uuid.uuid4().hex[:16]}"
    db = get_db()
    db.execute("UPDATE bookings SET stripe_intent=?, status='paid', paid_at=datetime('now') WHERE id=?",
               (fake_secret.split("_secret_")[0], booking_id))
    db.commit()

    # Notify contractor
    c_row = db.execute("SELECT c.owner_user_id FROM contractors c JOIN bookings b ON b.contractor_id=c.id WHERE b.id=?", (booking_id,)).fetchone()
    db.close()
    if c_row:
        broadcast_to_user(c_row["owner_user_id"], {
            "type": "booking_paid", "bookingId": booking_id,
            "message": "Payment received! Job confirmed.", "amount": amount
        })

    json_response(handler, {"clientSecret": fake_secret, "simulated": True,
                             "note": "Set STRIPE_SECRET_KEY env var for real payments"})

# ─── Chat messages ────────────────────────────────────────────────────────────
@route("GET", r"/api/chat/(\d+)/messages")
def get_messages(handler, match, qs, body):
    room_id = int(match.group(1))
    limit = int(qs.get("limit", [50])[0])
    db = get_db()
    rows = db.execute("""
        SELECT m.*, u.first_name||' '||u.last_name AS sender_name
        FROM messages m JOIN users u ON m.sender_id=u.id
        WHERE m.room_id=? ORDER BY m.created_at DESC LIMIT ?
    """, (room_id, limit)).fetchall()
    db.close()
    json_response(handler, list(reversed([dict(r) for r in rows])))

@route("POST", r"/api/chat/(\d+)/messages")
def send_message(handler, match, qs, body):
    room_id = int(match.group(1))
    sender_id = body.get("senderId", 4)
    text = body.get("text","").strip()
    msg_type = body.get("type","text")

    if not text and msg_type == "text":
        return json_response(handler, {"error":"empty message"}, 400)

    db = get_db()
    cur = db.execute("""
        INSERT INTO messages (room_id, sender_id, text, msg_type)
        VALUES (?,?,?,?)
    """, (room_id, sender_id, text, msg_type))
    msg_id = cur.lastrowid
    db.commit()

    row = db.execute("""
        SELECT m.*, u.first_name||' '||u.last_name AS sender_name
        FROM messages m JOIN users u ON m.sender_id=u.id WHERE m.id=?
    """, (msg_id,)).fetchone()
    msg = dict(row)

    # Notify recipient via WS
    room = db.execute("SELECT * FROM chat_rooms WHERE id=?", (room_id,)).fetchone()
    if room:
        recipient = room["contractor_id"] if sender_id == room["homeowner_id"] else room["homeowner_id"]
        broadcast_to_user(recipient, {"type":"new_message","chatRoomId":room_id,"message":msg})

    db.close()
    json_response(handler, msg, 201)

# ─── Push subscriptions ───────────────────────────────────────────────────────
@route("POST", r"/api/push/subscribe")
def push_subscribe(handler, match, qs, body):
    sub = body.get("subscription",{})
    db = get_db()
    db.execute("""
        INSERT OR REPLACE INTO push_subs (user_id, endpoint, p256dh, auth)
        VALUES (?,?,?,?)
    """, (body.get("userId",4), sub.get("endpoint"), sub.get("keys",{}).get("p256dh"), sub.get("keys",{}).get("auth")))
    db.commit()
    db.close()
    json_response(handler, {"success":True})

# ─── AI analysis (calls Claude if key set, else returns mock) ─────────────────
@route("POST", r"/api/analyze")
def analyze(handler, match, qs, body):
    category = body.get("category","General")
    description = body.get("description","")

    if ANTHROPIC_KEY:
        import urllib.request as urlreq
        prompt = f"""You are a home repair AI. Category: {category}. Description: "{description}"
Return ONLY valid JSON (no markdown):
{{"issue":"short title","severity":"Low|Moderate|High|Emergency","description":"2 sentence diagnosis","estimateLow":120,"estimateHigh":280,"timeHours":"1-3","diyDifficulty":"Easy|Moderate|Hard|Professional Only","urgency":"Schedule soon|This week|Today|Emergency","tips":["tip1","tip2"]}}"""
        payload = json.dumps({"model":"claude-sonnet-4-20250514","max_tokens":512,"messages":[{"role":"user","content":prompt}]}).encode()
        req = urlreq.Request("https://api.anthropic.com/v1/messages", data=payload, headers={
            "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "Content-Type":"application/json"
        })
        try:
            with urlreq.urlopen(req, timeout=15) as resp:
                data = json.loads(resp.read())
                text = "".join(b.get("text","") for b in data.get("content",[]))
                result = json.loads(text.strip())
                return json_response(handler, result)
        except Exception as e:
            log(R, "AI", str(e))

    # Fallback mock
    json_response(handler, {
        "issue": f"{category} Issue Detected",
        "severity": "Moderate",
        "description": f"AI analysis of your {category.lower()} issue. Based on typical cases, this appears to be a standard repair requiring a licensed professional.",
        "estimateLow": 120, "estimateHigh": 280,
        "timeHours": "1–3", "diyDifficulty": "Moderate",
        "urgency": "This week",
        "tips": ["Turn off water/power if needed", "Document with photos before repair"],
        "simulated": True
    })

# ─── Stats ────────────────────────────────────────────────────────────────────
@route("GET", r"/api/stats")
def stats(handler, match, qs, body):
    db = get_db()
    bookings = db.execute("SELECT COUNT(*) as c FROM bookings").fetchone()["c"]
    msgs     = db.execute("SELECT COUNT(*) as c FROM messages").fetchone()["c"]
    users    = db.execute("SELECT COUNT(*) as c FROM users").fetchone()["c"]
    db.close()
    json_response(handler, {"bookings":bookings,"messages":msgs,"users":users,"ws_connections":sum(len(v) for v in ws_clients.values())})

# ═══════════════════════════════════════════════════════════════════════════════
# REQUEST HANDLER
# ═══════════════════════════════════════════════════════════════════════════════
class FixItHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        status = args[1] if len(args)>1 else "?"
        colour = G if str(status).startswith("2") else (Y if str(status).startswith("3") else R)
        log(colour, "HTTP", f"{self.command} {self.path} → {status}")

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin","*")
        self.send_header("Access-Control-Allow-Methods","GET,POST,PUT,DELETE,OPTIONS")
        self.send_header("Access-Control-Allow-Headers","Content-Type,Authorization")
        self.end_headers()

    def _handle(self, method):
        parsed = urlparse(self.path)
        path   = parsed.path
        qs     = parse_qs(parsed.query)

        # WebSocket upgrade
        if (self.headers.get("Upgrade","").lower() == "websocket" and
                self.headers.get("Connection","").lower().find("upgrade") >= 0):
            user_id = qs.get("userId", ["0"])[0]
            ws_accept(self.connection, self.headers)
            t = threading.Thread(target=ws_handle_client, args=(self.connection, user_id, path), daemon=True)
            t.start()
            t.join()  # keep this thread alive while WS is open
            return

        body = read_body(self) if method in ("POST","PUT","PATCH") else {}

        for m, pattern, handler_fn in ROUTES:
            if m != method: continue
            match = pattern.match(path)
            if match:
                try:
                    handler_fn(self, match, qs, body)
                except Exception as e:
                    log(R, "ERR", str(e))
                    json_response(self, {"error": str(e)}, 500)
                return

        json_response(self, {"error": f"Not found: {method} {path}"}, 404)

    def do_GET(self):  self._handle("GET")
    def do_POST(self): self._handle("POST")
    def do_PUT(self):  self._handle("PUT")
    def do_DELETE(self): self._handle("DELETE")

# ═══════════════════════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════════════════════
if __name__ == "__main__":
    init_db()
    server = socketserver.ThreadingTCPServer(("", PORT), FixItHandler)
    server.allow_reuse_address = True
    log(G, "UP",  f"FixIt backend → http://localhost:{PORT}")
    log(B, "API", f"Health: http://localhost:{PORT}/api/health")
    log(B, "API", f"Contractors: http://localhost:{PORT}/api/contractors/nearby?lat=34.052&lng=-118.248")
    log(Y, "WS",  f"WebSocket: ws://localhost:{PORT}?userId=1")
    if ANTHROPIC_KEY:
        log(M, "AI",  "Claude AI: ENABLED")
    else:
        log(Y, "AI",  "Claude AI: set ANTHROPIC_API_KEY for real analysis (mock mode active)")
    log(W, "---", "Press Ctrl+C to stop\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log(Y, "BYE", "Server stopped")

@route("GET", r"/")
async def index(request):
    with open(os.path.join(os.path.dirname(__file__), "..", "public", "index.html")) as f:
        return Response(f.read(), content_type="text/html")

