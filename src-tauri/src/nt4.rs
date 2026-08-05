//! NetworkTables 4 client.
//!
//! NT4 is a WebSocket protocol with two channels sharing one socket: JSON text frames carry control
//! messages (announce / subscribe / publish), and msgpack binary frames carry the actual values. This
//! implements enough of it to be a dashboard: connect, subscribe to everything, decode values, and
//! hand them upstairs.
//!
//! Two things matter for a driver station and are easy to get wrong:
//!
//! * **Never block the UI.** A disconnected robot is the normal state for most of the day. The client
//!   reconnects forever in the background and the dashboard keeps rendering the last known values with
//!   a stale marker, rather than freezing or clearing.
//! * **Never emit at wire rate.** The robot publishes at 50 Hz across hundreds of topics. Pushing each
//!   change straight into the webview would spend the whole frame budget in IPC. Values are collected
//!   into a map and flushed on a fixed cadence, so the UI cost is independent of how chatty the robot is.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tokio::sync::mpsc;

use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::json;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;

/// How often decoded values are flushed to the UI. 20 Hz is smoother than the eye needs for numbers
/// and an order of magnitude cheaper than the 50 Hz the robot publishes at.
const FLUSH_HZ: u64 = 20;

/// A value from the robot, flattened into something the webview can use directly.
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "t", content = "v")]
pub enum NtValue {
    #[serde(rename = "bool")]
    Bool(bool),
    #[serde(rename = "num")]
    Num(f64),
    #[serde(rename = "str")]
    Str(String),
    #[serde(rename = "nums")]
    Nums(Vec<f64>),
    #[serde(rename = "bools")]
    Bools(Vec<bool>),
    #[serde(rename = "strs")]
    Strs(Vec<String>),
}

/// Everything the UI needs to know about the link, in one struct so it renders atomically.
#[derive(Clone, Debug, Serialize, Default)]
pub struct NtStatus {
    pub connected: bool,
    pub address: String,
    /// Round-trip time in milliseconds, from the NT4 timestamp handshake.
    pub rtt_ms: f64,
    pub topics: usize,
}

/// A value the dashboard wants to write.
///
/// This is an *ordinary dashboard write* — a tunable, an auto chooser selection — the same thing
/// Shuffleboard and Elastic do. It is not robot control, and it cannot become robot control: enabling
/// a robot happens over the DS protocol on a different socket that this app never opens. `main.rs`
/// additionally refuses to forward writes into the control namespaces.
#[derive(Clone, Debug)]
pub enum SetValue {
    Bool(bool),
    Num(f64),
    Str(String),
}

impl SetValue {
    /// The NT4 type string used in a `publish` control message.
    fn type_name(&self) -> &'static str {
        match self {
            SetValue::Bool(_) => "boolean",
            SetValue::Num(_) => "double",
            SetValue::Str(_) => "string",
        }
    }

    /// The NT4 type id used in a binary value frame.
    fn type_id(&self) -> i64 {
        match self {
            SetValue::Bool(_) => 0,
            SetValue::Num(_) => 1,
            SetValue::Str(_) => 4,
        }
    }

    fn encoded(&self) -> rmpv::Value {
        match self {
            SetValue::Bool(b) => rmpv::Value::Boolean(*b),
            SetValue::Num(n) => rmpv::Value::F64(*n),
            SetValue::Str(s) => rmpv::Value::from(s.as_str()),
        }
    }
}

#[derive(Clone, Debug)]
pub struct SetRequest {
    pub key: String,
    pub value: SetValue,
}

pub struct Nt4Client {
    values: Arc<Mutex<HashMap<String, NtValue>>>,
    status: Arc<Mutex<NtStatus>>,
    /// Set when a flush is worth doing; avoids emitting identical frames while disconnected.
    dirty: Arc<AtomicBool>,
    rtt_us: Arc<AtomicU64>,
    /// Server time minus our time, in microseconds, learned from the timestamp handshake.
    offset_us: Arc<AtomicI64>,
    set_tx: mpsc::UnboundedSender<SetRequest>,
    /// Handed to the session task on `spawn`; `None` afterwards.
    set_rx: Mutex<Option<mpsc::UnboundedReceiver<SetRequest>>>,
    /// Re-read at the top of every connection attempt, so changing the team number takes effect
    /// within a retry cycle instead of needing a restart.
    addresses: Arc<Mutex<Vec<String>>>,
}

impl Nt4Client {
    pub fn new() -> Self {
        let (set_tx, set_rx) = mpsc::unbounded_channel();
        Self {
            values: Arc::new(Mutex::new(HashMap::new())),
            status: Arc::new(Mutex::new(NtStatus::default())),
            dirty: Arc::new(AtomicBool::new(false)),
            rtt_us: Arc::new(AtomicU64::new(0)),
            offset_us: Arc::new(AtomicI64::new(0)),
            set_tx,
            set_rx: Mutex::new(Some(set_rx)),
            addresses: Arc::new(Mutex::new(Vec::new())),
        }
    }

    /// Replace the candidate list. The current attempt is left to finish or time out on its own —
    /// tearing a live socket down mid-match to apply a settings change is not worth it.
    pub fn set_addresses(&self, addresses: Vec<String>) {
        *self.addresses.lock().unwrap() = addresses;
    }

    pub fn dirty(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.dirty)
    }

    /// Queue a write. Never blocks and never fails visibly: with no robot connected the request is
    /// simply dropped by the session loop, because a dashboard that stalls on a missing robot is
    /// exactly the failure this app exists to avoid.
    pub fn set(&self, key: String, value: SetValue) {
        let _ = self.set_tx.send(SetRequest { key, value });
    }

    /// Take everything that has changed since the last call, clearing the dirty flag.
    pub fn snapshot(&self) -> (HashMap<String, NtValue>, NtStatus) {
        let values = self.values.lock().unwrap().clone();
        let mut status = self.status.lock().unwrap().clone();
        status.topics = values.len();
        status.rtt_ms = self.rtt_us.load(Ordering::Relaxed) as f64 / 1000.0;
        (values, status)
    }

    /// Spawn the connect-forever task. Returns immediately; the socket lives on a background thread.
    pub fn spawn(&self, initial: Vec<String>) {
        self.set_addresses(initial);
        let addresses = Arc::clone(&self.addresses);
        let values = Arc::clone(&self.values);
        let status = Arc::clone(&self.status);
        let dirty = Arc::clone(&self.dirty);
        let rtt_us = Arc::clone(&self.rtt_us);
        let offset_us = Arc::clone(&self.offset_us);
        let Some(mut set_rx) = self.set_rx.lock().unwrap().take() else {
            eprintln!("[nt4] spawn called twice — ignoring");
            return;
        };

        std::thread::spawn(move || {
            let rt = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
                Ok(rt) => rt,
                Err(e) => {
                    eprintln!("[nt4] could not start runtime: {e}");
                    return;
                }
            };
            rt.block_on(async move {
                let mut index = 0usize;
                loop {
                    // Cycle the candidate addresses. A robot is reachable by mDNS at the field, by
                    // static IP in the pit, and by localhost in simulation - trying all of them in
                    // turn means the same build works everywhere with no setting to forget.
                    let addr = {
                        let list = addresses.lock().unwrap();
                        if list.is_empty() {
                            drop(list);
                            tokio::time::sleep(Duration::from_millis(500)).await;
                            continue;
                        }
                        let picked = list[index % list.len()].clone();
                        index += 1;
                        picked
                    };

                    {
                        let mut s = status.lock().unwrap();
                        s.address = addr.clone();
                        s.connected = false;
                    }
                    dirty.store(true, Ordering::Relaxed);

                    let session = run_session(
                        &addr, &values, &status, &dirty, &rtt_us, &offset_us, &mut set_rx,
                    );
                    if let Err(e) = session.await {
                        eprintln!("[nt4] {addr}: {e}");
                    }

                    {
                        let mut s = status.lock().unwrap();
                        s.connected = false;
                    }
                    dirty.store(true, Ordering::Relaxed);
                    tokio::time::sleep(Duration::from_millis(600)).await;
                }
            });
        });
    }
}

fn now_micros() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_micros() as u64)
        .unwrap_or(0)
}

#[allow(clippy::too_many_arguments)]
async fn run_session(
    address: &str,
    values: &Arc<Mutex<HashMap<String, NtValue>>>,
    status: &Arc<Mutex<NtStatus>>,
    dirty: &Arc<AtomicBool>,
    rtt_us: &Arc<AtomicU64>,
    offset_us: &Arc<AtomicI64>,
    set_rx: &mut mpsc::UnboundedReceiver<SetRequest>,
) -> Result<(), String> {
    let url = format!("ws://{address}:5810/nt/catalyst-console");
    let mut request = url.into_client_request().map_err(|e| e.to_string())?;
    request.headers_mut().insert(
        "Sec-WebSocket-Protocol",
        HeaderValue::from_static("networktables.first.wpi.edu"),
    );

    let connect = tokio_tungstenite::connect_async(request);
    let (stream, _) = tokio::time::timeout(Duration::from_millis(1200), connect)
        .await
        .map_err(|_| "connect timed out".to_string())?
        .map_err(|e| e.to_string())?;

    let (mut write, mut read) = stream.split();

    // Subscribe to the whole tree. A dashboard genuinely wants everything, and the server-side
    // periodic option is what keeps that from being expensive.
    let subscribe = json!([{
        "method": "subscribe",
        "params": { "topics": ["/"], "subuid": 1, "options": { "prefix": true, "periodic": 0.02 } }
    }]);
    write
        .send(Message::Text(subscribe.to_string()))
        .await
        .map_err(|e| e.to_string())?;

    {
        let mut s = status.lock().unwrap();
        s.connected = true;
    }
    dirty.store(true, Ordering::Relaxed);

    let mut topics: HashMap<i64, String> = HashMap::new();
    // Topics we have published on this connection, and the pubuid each was given. Publishing is
    // per-session: a reconnect starts over, which is correct because the server forgot us too.
    let mut published: HashMap<String, i64> = HashMap::new();
    let mut next_pubuid: i64 = 100;
    let mut last_ping = tokio::time::Instant::now() - Duration::from_secs(10);

    loop {
        // Timestamp handshake doubles as a keepalive and gives us a real RTT number for the UI.
        if last_ping.elapsed() > Duration::from_secs(1) {
            last_ping = tokio::time::Instant::now();
            let ping = rmpv::Value::Array(vec![
                rmpv::Value::from(-1i64),
                rmpv::Value::from(0u64),
                rmpv::Value::from(1i64),
                rmpv::Value::from(now_micros()),
            ]);
            let mut buf = Vec::new();
            if rmpv::encode::write_value(&mut buf, &ping).is_ok() {
                let _ = write.send(Message::Binary(buf)).await;
            }
        }

        let msg = tokio::select! {
            biased;

            // Outbound writes get priority: a slider the driver just moved should not wait behind a
            // backlog of inbound telemetry.
            Some(request) = set_rx.recv() => {
                if !published.contains_key(&request.key) {
                    let pubuid = next_pubuid;
                    next_pubuid += 1;
                    let publish = json!([{
                        "method": "publish",
                        "params": {
                            "name": request.key,
                            "pubuid": pubuid,
                            "type": request.value.type_name(),
                            "properties": {}
                        }
                    }]);
                    if write.send(Message::Text(publish.to_string())).await.is_err() {
                        return Err("write failed".into());
                    }
                    published.insert(request.key.clone(), pubuid);
                }

                let pubuid = published[&request.key];
                let stamp = (now_micros() as i64 + offset_us.load(Ordering::Relaxed)).max(0) as u64;
                let frame = rmpv::Value::Array(vec![
                    rmpv::Value::from(pubuid),
                    rmpv::Value::from(stamp),
                    rmpv::Value::from(request.value.type_id()),
                    request.value.encoded(),
                ]);
                let mut buf = Vec::new();
                if rmpv::encode::write_value(&mut buf, &frame).is_ok()
                    && write.send(Message::Binary(buf)).await.is_err()
                {
                    return Err("write failed".into());
                }
                continue;
            }

            incoming = read.next() => match incoming {
                None => return Err("socket closed".into()),
                Some(Err(e)) => return Err(e.to_string()),
                Some(Ok(m)) => m,
            },

            _ = tokio::time::sleep(Duration::from_millis(400)) => continue,
        };

        match msg {
            Message::Text(text) => {
                handle_control(&text, &mut topics);
            }
            Message::Binary(bytes) => {
                if handle_binary(&bytes, &topics, values, rtt_us, offset_us) {
                    dirty.store(true, Ordering::Relaxed);
                }
            }
            Message::Close(_) => return Err("server closed".into()),
            Message::Ping(p) => {
                let _ = write.send(Message::Pong(p)).await;
            }
            _ => {}
        }
    }
}

/// JSON control frames. We only care about topic announcements — they are what turn an integer id in
/// a binary frame into a name the dashboard can bind to.
fn handle_control(text: &str, topics: &mut HashMap<i64, String>) {
    let parsed: serde_json::Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => return,
    };
    let Some(items) = parsed.as_array() else { return };

    for item in items {
        let method = item.get("method").and_then(|m| m.as_str()).unwrap_or("");
        let params = item.get("params");
        match method {
            "announce" => {
                if let (Some(name), Some(id)) = (
                    params.and_then(|p| p.get("name")).and_then(|n| n.as_str()),
                    params.and_then(|p| p.get("id")).and_then(|i| i.as_i64()),
                ) {
                    topics.insert(id, name.to_string());
                }
            }
            "unannounce" => {
                if let Some(id) = params.and_then(|p| p.get("id")).and_then(|i| i.as_i64()) {
                    topics.remove(&id);
                }
            }
            _ => {}
        }
    }
}

/// Binary frames: one or more msgpack arrays of `[topicId, timestampMicros, typeId, value]`,
/// concatenated. Topic id -1 is the timestamp handshake reply rather than a value.
fn handle_binary(
    bytes: &[u8],
    topics: &HashMap<i64, String>,
    values: &Arc<Mutex<HashMap<String, NtValue>>>,
    rtt_us: &Arc<AtomicU64>,
    offset_us: &Arc<AtomicI64>,
) -> bool {
    let mut cursor = bytes;
    let mut changed = false;

    while !cursor.is_empty() {
        let value = match rmpv::decode::read_value(&mut cursor) {
            Ok(v) => v,
            Err(_) => break,
        };
        let Some(frame) = value.as_array() else { continue };
        if frame.len() < 4 {
            continue;
        }
        let topic_id = frame[0].as_i64().unwrap_or(i64::MIN);

        if topic_id == -1 {
            // [-1, serverTime, 1, clientTimeWeSent] — the round trip is now minus what we sent.
            if let Some(sent) = frame[3].as_u64() {
                let now = now_micros();
                let rtt = now.saturating_sub(sent);
                rtt_us.store(rtt, Ordering::Relaxed);

                // Server time at the instant we sent is best estimated as halfway through the round
                // trip. That offset is what makes our own writes carry a timestamp the server and
                // every other client agree with.
                if let Some(server) = frame[1].as_u64() {
                    let midpoint = sent as i64 + (rtt as i64 / 2);
                    offset_us.store(server as i64 - midpoint, Ordering::Relaxed);
                }
            }
            continue;
        }

        let Some(name) = topics.get(&topic_id) else { continue };
        if let Some(decoded) = decode_value(&frame[3]) {
            values.lock().unwrap().insert(name.clone(), decoded);
            changed = true;
        }
    }
    changed
}

fn decode_value(v: &rmpv::Value) -> Option<NtValue> {
    match v {
        rmpv::Value::Boolean(b) => Some(NtValue::Bool(*b)),
        rmpv::Value::Integer(i) => i
            .as_f64()
            .map(NtValue::Num)
            .or_else(|| i.as_i64().map(|n| NtValue::Num(n as f64))),
        rmpv::Value::F32(f) => Some(NtValue::Num(*f as f64)),
        rmpv::Value::F64(f) => Some(NtValue::Num(*f)),
        rmpv::Value::String(s) => Some(NtValue::Str(s.as_str().unwrap_or_default().to_string())),
        rmpv::Value::Array(items) => {
            if items.is_empty() {
                return Some(NtValue::Nums(Vec::new()));
            }
            match &items[0] {
                rmpv::Value::Boolean(_) => Some(NtValue::Bools(
                    items.iter().map(|i| i.as_bool().unwrap_or(false)).collect(),
                )),
                rmpv::Value::String(_) => Some(NtValue::Strs(
                    items
                        .iter()
                        .map(|i| i.as_str().unwrap_or_default().to_string())
                        .collect(),
                )),
                _ => Some(NtValue::Nums(
                    items.iter().map(|i| i.as_f64().unwrap_or(0.0)).collect(),
                )),
            }
        }
        _ => None,
    }
}

/// The flush cadence, exposed so `main` can use the same number.
pub const fn flush_interval() -> Duration {
    Duration::from_millis(1000 / FLUSH_HZ)
}
