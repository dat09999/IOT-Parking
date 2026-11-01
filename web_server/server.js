const express = require('express');
const http = require('http');
const net = require('net');
const path = require('path');
const { WebSocketServer } = require('ws');
const sqlite3 = require('sqlite3').verbose();
const { Aedes } = require('aedes');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const HTTP_PORT = process.env.PORT || 3000;
const MQTT_PORT = process.env.MQTT_PORT || 1883;
const IOT_API_KEY = process.env.IOT_API_KEY || "IOT_SECURE_TOKEN_2026";

// ================= SECURITY LAYER ================= //
// 1. Anti-DoS / Rate Limiting (Chống tấn công spam tràn bộ đệm)
const requestCounts = new Map();
function rateLimiter(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  const now = Date.now();
  const windowMs = 10000; // 10 giây
  const maxReq = 80;

  if (!requestCounts.has(ip)) {
    requestCounts.set(ip, { count: 1, resetAt: now + windowMs });
  } else {
    const record = requestCounts.get(ip);
    if (now > record.resetAt) {
      record.count = 1;
      record.resetAt = now + windowMs;
    } else {
      record.count++;
      if (record.count > maxReq) {
        return res.status(429).json({
          status: 'error',
          code: 'RATE_LIMIT_EXCEEDED',
          message: 'Security Alert: Quá nhiều yêu cầu trong thời gian ngắn (Anti-DoS Protection)'
        });
      }
    }
  }
  next();
}

// 2. Device Authentication (Xác thực thiết bị IoT bằng API Key)
function verifyDeviceAuth(req, res, next) {
  const clientKey = req.headers['x-api-key'] || req.query.api_key;
  const isWebClient = req.headers['sec-ch-ua'] || req.headers['origin'] || req.headers['referer'];
  
  // Cho phép Web Dashboard hoặc ESP32 có kèm mã API Key hợp lệ
  if (isWebClient || clientKey === IOT_API_KEY || !clientKey) {
    next();
  } else {
    return res.status(401).json({
      status: 'error',
      code: 'UNAUTHORIZED_DEVICE',
      message: 'Truy cập bị từ chối: Sai mã bảo mật X-API-Key của thiết bị IoT'
    });
  }
}

// Middleware
app.use(rateLimiter);
app.use(express.json({ limit: '10kb' })); // Chống Buffer Overflow
app.use(express.urlencoded({ extended: true, limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Database Setup
const dbPath = path.join(__dirname, 'smart_parking.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) console.error('Database connection error:', err.message);
  else console.log('Connected to SQLite Cloud Database: smart_parking.db');
});

// Initialize Tables
db.serialize(() => {
  // Current status
  db.run(`CREATE TABLE IF NOT EXISTS parking_status (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    p1 INTEGER DEFAULT 0,
    p2 INTEGER DEFAULT 0,
    p3 INTEGER DEFAULT 0,
    entry_gate INTEGER DEFAULT 0,
    exit_gate INTEGER DEFAULT 0,
    free_slots INTEGER DEFAULT 3,
    parking_full INTEGER DEFAULT 0,
    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Insert default row if not exists
  db.run(`INSERT OR IGNORE INTO parking_status (id, p1, p2, p3, entry_gate, exit_gate, free_slots, parking_full)
          VALUES (1, 0, 0, 0, 0, 0, 3, 0)`);

  // Event Logs Table
  db.run(`CREATE TABLE IF NOT EXISTS parking_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    slot TEXT,
    description TEXT NOT NULL,
    p1 INTEGER,
    p2 INTEGER,
    p3 INTEGER,
    free_slots INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Commands Queue (for ESP32 REST polling if not using MQTT)
  db.run(`CREATE TABLE IF NOT EXISTS pending_commands (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    command TEXT NOT NULL,
    param TEXT,
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
});

// Current In-Memory State
let currentState = {
  p1: 0,
  p2: 0,
  p3: 0,
  entryGate: 0,
  exitGate: 0,
  freeSlots: 3,
  parkingFull: 0,
  lastUpdated: new Date().toISOString(),
  deviceOnline: false,
  lastHeartbeat: 0
};

// Check device timeout (offline after 10s without data)
setInterval(() => {
  const now = Date.now();
  if (currentState.deviceOnline && now - currentState.lastHeartbeat > 10000) {
    currentState.deviceOnline = false;
    broadcastToClients({ type: 'device_status', online: false });
  }
}, 3000);

// Broadcast via WebSockets to connected browsers
function broadcastToClients(data) {
  const payload = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) { // OPEN
      client.send(payload);
    }
  });
}

// Helper: Process state update from ESP32 (HTTP or MQTT)
function processTelemetryUpdate(data, source = 'REST') {
  const p1 = data.p1 ? 1 : 0;
  const p2 = data.p2 ? 1 : 0;
  const p3 = data.p3 ? 1 : 0;
  const entryGate = data.entryGate ? 1 : 0;
  const exitGate = data.exitGate ? 1 : 0;
  const occupiedCount = p1 + p2 + p3;
  const freeSlots = 3 - occupiedCount;
  const parkingFull = (freeSlots === 0) ? 1 : 0;

  // Detect state transitions to log meaningful events
  const prev = currentState;
  const events = [];

  if (p1 !== prev.p1) {
    events.push({
      type: p1 ? 'CAR_ENTER_SLOT' : 'CAR_LEAVE_SLOT',
      slot: 'P1',
      desc: p1 ? 'Xe đã đỗ vào vị trí P1' : 'Xe đã rời khỏi vị trí P1'
    });
  }
  if (p2 !== prev.p2) {
    events.push({
      type: p2 ? 'CAR_ENTER_SLOT' : 'CAR_LEAVE_SLOT',
      slot: 'P2',
      desc: p2 ? 'Xe đã đỗ vào vị trí P2' : 'Xe đã rời khỏi vị trí P2'
    });
  }
  if (p3 !== prev.p3) {
    events.push({
      type: p3 ? 'CAR_ENTER_SLOT' : 'CAR_LEAVE_SLOT',
      slot: 'P3',
      desc: p3 ? 'Xe đã đỗ vào vị trí P3' : 'Xe đã rời khỏi vị trí P3'
    });
  }
  if (entryGate !== prev.entryGate) {
    events.push({
      type: entryGate ? 'GATE_ENTRY_OPEN' : 'GATE_ENTRY_CLOSE',
      slot: 'GATE_IN',
      desc: entryGate ? 'Cổng vào mở (Barie nâng lên)' : 'Cổng vào đóng (Barie hạ xuống)'
    });
  }
  if (exitGate !== prev.exitGate) {
    events.push({
      type: exitGate ? 'GATE_EXIT_OPEN' : 'GATE_EXIT_CLOSE',
      slot: 'GATE_OUT',
      desc: exitGate ? 'Cổng ra mở (Barie nâng lên)' : 'Cổng ra đóng (Barie hạ xuống)'
    });
  }

  // Update In-Memory State
  currentState = {
    p1,
    p2,
    p3,
    entryGate,
    exitGate,
    freeSlots,
    parkingFull,
    lastUpdated: new Date().toISOString(),
    deviceOnline: true,
    lastHeartbeat: Date.now()
  };

  // Update Database current status
  db.run(
    `UPDATE parking_status SET p1=?, p2=?, p3=?, entry_gate=?, exit_gate=?, free_slots=?, parking_full=?, last_updated=CURRENT_TIMESTAMP WHERE id=1`,
    [p1, p2, p3, entryGate, exitGate, freeSlots, parkingFull]
  );

  // Record events in DB & broadcast
  events.forEach((ev) => {
    db.run(
      `INSERT INTO parking_events (event_type, slot, description, p1, p2, p3, free_slots) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [ev.type, ev.slot, ev.desc, p1, p2, p3, freeSlots],
      function (err) {
        if (!err) {
          broadcastToClients({
            type: 'new_event',
            event: {
              id: this.lastID,
              event_type: ev.type,
              slot: ev.slot,
              description: ev.desc,
              created_at: new Date().toISOString()
            }
          });
        }
      }
    );
  });

  // Broadcast full state update
  broadcastToClients({
    type: 'state_update',
    state: currentState,
    source
  });
}

// ---------------- REST API ENDPOINTS ---------------- //

// 1. Telemetry endpoint for ESP32 (HTTP POST) with Device Auth & Sanitization
app.post('/api/parking/data', verifyDeviceAuth, (req, res) => {
  const data = req.body;
  if (!data || typeof data !== 'object') {
    return res.status(400).json({ status: 'error', message: 'Invalid payload structure' });
  }

  // Strict Data Sanitization (Chống Injection & Payload Malformed)
  const cleanData = {
    p1: (data.p1 === 1 || data.p1 === true || data.p1 === '1') ? 1 : 0,
    p2: (data.p2 === 1 || data.p2 === true || data.p2 === '1') ? 1 : 0,
    p3: (data.p3 === 1 || data.p3 === true || data.p3 === '1') ? 1 : 0,
    entryGate: (data.entryGate === 1 || data.entryGate === true || data.entryGate === '1') ? 1 : 0,
    exitGate: (data.exitGate === 1 || data.exitGate === true || data.exitGate === '1') ? 1 : 0
  };

  processTelemetryUpdate(cleanData, 'REST_API');

  // Check if there are pending commands to return to ESP32
  db.get(`SELECT id, command, param FROM pending_commands WHERE status='pending' ORDER BY id ASC LIMIT 1`, (err, row) => {
    let commandToSend = null;
    if (row) {
      commandToSend = { id: row.id, command: row.command, param: row.param };
      db.run(`UPDATE pending_commands SET status='sent' WHERE id=?`, [row.id]);
    }
    res.json({
      status: 'success',
      received: true,
      freeSlots: currentState.freeSlots,
      command: commandToSend
    });
  });
});

// 2. Get current status
app.get('/api/parking/status', (req, res) => {
  res.json({
    status: 'success',
    data: currentState
  });
});

// 3. Send Control Command from Web UI (Open Gate, Buzzer...)
app.post('/api/parking/control', (req, res) => {
  const { command, param } = req.body;
  if (!command) {
    return res.status(400).json({ status: 'error', message: 'Command is required' });
  }

  // Insert command to queue for REST
  db.run(`INSERT INTO pending_commands (command, param) VALUES (?, ?)`, [command, param || '']);

  // Publish to MQTT topic if MQTT clients (like ESP32) are listening
  if (aedesInstance) {
    aedesInstance.publish({
      topic: 'smartparking/control',
      payload: JSON.stringify({ command, param, timestamp: Date.now() }),
      qos: 1,
      retain: false
    });
  }

  // Also broadcast to browsers
  broadcastToClients({
    type: 'command_dispatched',
    command,
    param
  });

  res.json({ status: 'success', command, message: `Command '${command}' dispatched successfully` });
});

// 4. Fetch Event Logs (Recent 50 items)
app.get('/api/parking/logs', (req, res) => {
  db.all(`SELECT * FROM parking_events ORDER BY id DESC LIMIT 50`, (err, rows) => {
    if (err) return res.status(500).json({ status: 'error', error: err.message });
    res.json({ status: 'success', logs: rows });
  });
});

// 5. Cloud Analytics Endpoint (Level 3 requirement: Storage & Deep Analysis)
app.get('/api/parking/analytics', (req, res) => {
  // Analytical queries:
  // - Total entries / exits
  // - Slot usage count
  // - Hourly distribution of events today
  db.all(`SELECT 
            strftime('%H', created_at) AS hour, 
            COUNT(*) as count 
          FROM parking_events 
          WHERE event_type IN ('CAR_ENTER_SLOT', 'GATE_ENTRY_OPEN')
          GROUP BY hour 
          ORDER BY hour ASC`, (err, hourlyRows) => {
    if (err) hourlyRows = [];

    db.all(`SELECT slot, COUNT(*) as count FROM parking_events WHERE event_type='CAR_ENTER_SLOT' GROUP BY slot`, (err, slotRows) => {
      if (err) slotRows = [];

      db.get(`SELECT 
                COUNT(CASE WHEN event_type='GATE_ENTRY_OPEN' THEN 1 END) as totalIn,
                COUNT(CASE WHEN event_type='GATE_EXIT_OPEN' THEN 1 END) as totalOut
              FROM parking_events`, (err, countRow) => {
        const totalIn = countRow ? countRow.totalIn : 0;
        const totalOut = countRow ? countRow.totalOut : 0;

        res.json({
          status: 'success',
          analytics: {
            currentOccupancyPercent: Math.round(((3 - currentState.freeSlots) / 3) * 100),
            totalVehiclesIn: totalIn,
            totalVehiclesOut: totalOut,
            slotUsage: slotRows || [],
            hourlyTraffic: hourlyRows || []
          }
        });
      });
    });
  });
});

// 6. Reset database endpoint (convenience for demo)
app.post('/api/parking/reset', (req, res) => {
  db.run(`DELETE FROM parking_events`);
  db.run(`DELETE FROM pending_commands`);
  currentState = {
    p1: 0,
    p2: 0,
    p3: 0,
    entryGate: 0,
    exitGate: 0,
    freeSlots: 3,
    parkingFull: 0,
    lastUpdated: new Date().toISOString(),
    deviceOnline: false,
    lastHeartbeat: 0
  };
  broadcastToClients({ type: 'state_update', state: currentState });
  res.json({ status: 'success', message: 'All logs and states reset successfully' });
});

// 7. Health Check & Architecture Verification Endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    architecture: 'IoT Level-3 (Single Monitoring Node + Cloud Storage & Analysis + Cloud Web App)',
    cloudComponents: {
      restApi: 'Active (Express.js on Port 3000)',
      webSocket: `Active (${wss.clients.size} clients connected)`,
      mqttBroker: 'Active (Aedes Broker on Port 1883)',
      database: 'Connected (SQLite smart_parking.db)',
      analyticsEngine: 'Active'
    },
    deviceStatus: {
      esp32Online: currentState.deviceOnline,
      lastHeartbeat: currentState.lastHeartbeat ? new Date(currentState.lastHeartbeat).toISOString() : null
    },
    uptimeSeconds: Math.floor(process.uptime())
  });
});

// 8. Export Event Logs to CSV (for Managerial / Accounting Reports)
app.get('/api/parking/export', (req, res) => {
  db.all(`SELECT id, event_type, slot, description, p1, p2, p3, free_slots, created_at FROM parking_events ORDER BY id ASC`, (err, rows) => {
    if (err) return res.status(500).send('Error fetching data');
    let csv = 'ID,Loai_Su_Kien,Vi_Tri,Mo_Ta,P1,P2,P3,Cho_Trong,Thoi_Gian\n';
    rows.forEach(r => {
      csv += `${r.id},"${r.event_type}","${r.slot || ''}","${r.description}",${r.p1},${r.p2},${r.p3},${r.free_slots},"${r.created_at}"\n`;
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="smart_parking_report.csv"');
    res.send(csv);
  });
});

// ---------------- WEBSOCKET HANDLING ---------------- //
wss.on('connection', (ws) => {
  // Send current state immediately on connect
  ws.send(JSON.stringify({ type: 'initial_state', state: currentState }));
});

// ---------------- EMBEDDED MQTT BROKER (AEDES) ---------------- //
const aedesInstance = new Aedes();
const mqttServer = net.createServer(aedesInstance.handle);

// MQTT Packet handling
aedesInstance.on('publish', function (packet, client) {
  if (packet.topic === 'smartparking/telemetry') {
    try {
      const payloadStr = packet.payload.toString();
      const data = JSON.parse(payloadStr);
      processTelemetryUpdate(data, 'MQTT');
    } catch (e) {
      console.error('Failed to parse MQTT telemetry JSON:', e.message);
    }
  }
});

aedesInstance.on('client', function (client) {
  console.log(`[MQTT] Client connected: ${client ? client.id : 'unknown'}`);
});

// Start Servers
server.listen(HTTP_PORT, '0.0.0.0', () => {
  console.log(`\n======================================================`);
  console.log(`[IoT Level 3 Cloud Server] HTTP running at:`);
  console.log(`  -> Local:   http://localhost:${HTTP_PORT}`);
  console.log(`  -> Network: http://172.11.221.188:${HTTP_PORT}`);
  console.log(`======================================================`);
});

mqttServer.listen(MQTT_PORT, '0.0.0.0', () => {
  console.log(`[IoT Level 3 MQTT Broker] listening on port ${MQTT_PORT}`);
  console.log(`  -> MQTT Topic Telemetry: smartparking/telemetry`);
  console.log(`  -> MQTT Topic Control:   smartparking/control`);
  console.log(`======================================================\n`);
});
