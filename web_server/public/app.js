// Smart Parking IoT Level 3 - High Tech Client Application

let socket;
let trafficChart, slotChart;
let simMode = false;
let soundEnabled = true;
let simState = { p1: 0, p2: 0, p3: 0, entryGate: 0, exitGate: 0 };
let audioCtx = null;

// Web Audio API Sound Effects Synthesizer (Zero external file dependencies)
function getAudioContext() {
  if (!audioCtx) {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (AudioContext) audioCtx = new AudioContext();
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
  return audioCtx;
}

function playTone(freq, type, duration, delay = 0) {
  if (!soundEnabled) return;
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    setTimeout(() => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, ctx.currentTime);
      gain.gain.setValueAtTime(0.08, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + duration);
    }, delay);
  } catch (e) {
    // Audio context not allowed before user gesture
  }
}

function playCarBeep() {
  playTone(880, 'sine', 0.12);
  playTone(1174, 'sine', 0.15, 120);
}

function playGateOpenSound() {
  playTone(440, 'triangle', 0.25);
  playTone(660, 'sine', 0.35, 150);
}

function playAlertFullSound() {
  playTone(700, 'square', 0.2);
  playTone(500, 'square', 0.25, 200);
}

function toggleSoundEffects() {
  soundEnabled = !soundEnabled;
  const icon = document.getElementById('icon-sound');
  const btn = document.getElementById('btn-toggle-sound');
  if (soundEnabled) {
    icon.className = 'fa-solid fa-volume-high text-cyan-400';
    btn.classList.remove('opacity-60');
    getAudioContext();
    playTone(880, 'sine', 0.1);
  } else {
    icon.className = 'fa-solid fa-volume-xmark text-slate-500';
    btn.classList.add('opacity-60');
  }
}

// Digital Realtime Clock
function startClock() {
  const clockEl = document.getElementById('clock-display');
  function update() {
    const now = new Date();
    clockEl.textContent = now.toLocaleTimeString('vi-VN', { hour12: false });
  }
  update();
  setInterval(update, 1000);
}

// Initialize WebSockets
function initWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}`;

  const textWs = document.getElementById('text-ws');
  const badgeWs = document.getElementById('badge-ws');

  socket = new WebSocket(wsUrl);

  socket.onopen = () => {
    textWs.textContent = 'WS: Kết nối';
    badgeWs.className = 'glass-panel px-3 py-1.5 rounded-xl flex items-center gap-2 text-emerald-400 border border-emerald-500/30';
  };

  socket.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'initial_state' || msg.type === 'state_update') {
        renderState(msg.state);
      } else if (msg.type === 'device_status') {
        updateDeviceStatus(msg.online);
      } else if (msg.type === 'new_event') {
        prependEventLog(msg.event);
        fetchAnalytics();
        // Trigger sounds
        if (msg.event.event_type.includes('ENTER_SLOT')) playCarBeep();
        if (msg.event.event_type.includes('GATE_ENTRY_OPEN')) playGateOpenSound();
      } else if (msg.type === 'new_plate_detected') {
        const plateEl = document.getElementById('stat-plate-text');
        const plateSub = document.getElementById('stat-plate-sub');
        const hudPlate = document.getElementById('hud-plate-display');
        const hudConf = document.getElementById('hud-confidence');
        const hudTime = document.getElementById('hud-timestamp');
        const hudAction = document.getElementById('hud-gate-action');

        if (plateEl) {
          plateEl.textContent = msg.plate;
          plateEl.className = 'text-lg font-black text-emerald-400 mt-1.5 font-mono tracking-widest animate-pulse';
        }
        if (plateSub) {
          plateSub.textContent = `Vào lúc: ${new Date().toLocaleTimeString('vi-VN')} (${msg.gate})`;
        }
        if (hudPlate) {
          hudPlate.textContent = msg.plate;
        }
        if (hudConf) {
          hudConf.textContent = '98.5%';
        }
        if (hudTime) {
          hudTime.textContent = new Date().toLocaleTimeString('vi-VN');
        }
        if (hudAction) {
          hudAction.textContent = msg.command === 'OPEN_ENTRY' ? 'Mở cổng vào (Hợp lệ)' : (msg.command === 'OPEN_EXIT' ? 'Mở cổng ra' : 'Từ chối (Bãi đầy)');
        }

        showToast(`AI Camera nhận diện biển số: [${msg.plate}]`);
        playTone(1046, 'sine', 0.2);
        if (msg.event) prependEventLog(msg.event);
        fetchAnalytics();
      }
    } catch (e) {
      console.error('Error parsing WS message:', e);
    }
  };

  socket.onclose = () => {
    textWs.textContent = 'WS: Ngắt (Thử lại...)';
    badgeWs.className = 'glass-panel px-3 py-1.5 rounded-xl flex items-center gap-2 text-rose-400 border border-rose-500/30';
    setTimeout(initWebSocket, 2500);
  };
}

// Live Webcam Stream Directly on Browser
let webcamStream = null;
async function toggleWebcamPreview() {
  const video = document.getElementById('webcam-video');
  const placeholder = document.getElementById('cam-placeholder');
  const btnText = document.getElementById('text-btn-cam');

  if (webcamStream) {
    webcamStream.getTracks().forEach(track => track.stop());
    webcamStream = null;
    video.classList.add('hidden');
    placeholder.classList.remove('hidden');
    btnText.textContent = 'Mở Camera Trên Web';
  } else {
    try {
      // Tìm camera iVCam nếu có nhiều thiết bị
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoDevices = devices.filter(d => d.kind === 'videoinput');
      let targetDeviceId = undefined;
      
      const ivcamDevice = videoDevices.find(d => d.label.toLowerCase().includes('ivcam') || d.label.toLowerCase().includes('e2esoft'));
      if (ivcamDevice) {
        targetDeviceId = { exact: ivcamDevice.deviceId };
      } else if (videoDevices.length > 1) {
        // Neu co tu 2 camera tro len thi uu tien camera phu (thuong la iVCam)
        targetDeviceId = { exact: videoDevices[videoDevices.length - 1].deviceId };
      }

      webcamStream = await navigator.mediaDevices.getUserMedia({ 
        video: targetDeviceId ? { deviceId: targetDeviceId, width: { ideal: 1280 } } : { width: { ideal: 1280 } } 
      });
      video.srcObject = webcamStream;
      video.classList.remove('hidden');
      placeholder.classList.add('hidden');
      btnText.textContent = 'Tắt Camera Trên Web';
    } catch (err) {
      alert('Không thể mở camera trên trình duyệt: ' + err.message + '\nBạn hãy chạy qua file start_ivcam_ai.bat!');
    }
  }
}

// Render System State
let previousFreeSlots = 3;
function renderState(state) {
  if (!state) return;

  updateDeviceStatus(state.deviceOnline);

  const freeEl = document.getElementById('stat-free-slots');
  const occupiedEl = document.getElementById('stat-occupied-slots');
  const progressBar = document.getElementById('stat-progress-bar');
  const bannerCard = document.getElementById('card-status-banner');
  const bannerText = document.getElementById('stat-banner-text');
  const bannerSub = document.getElementById('stat-banner-sub');
  const bannerIcon = document.getElementById('stat-banner-icon');
  const parkingStatusDesc = document.getElementById('stat-parking-status-desc');

  const occupiedCount = (state.p1 ? 1 : 0) + (state.p2 ? 1 : 0) + (state.p3 ? 1 : 0);
  const freeCount = 3 - occupiedCount;
  const isFull = freeCount === 0;

  // Sound alert when parking suddenly gets full
  if (isFull && previousFreeSlots > 0) {
    playAlertFullSound();
  }
  previousFreeSlots = freeCount;

  freeEl.textContent = freeCount;
  occupiedEl.textContent = occupiedCount;
  progressBar.style.width = `${(occupiedCount / 3) * 100}%`;

  if (isFull) {
    bannerCard.className = 'glass-panel rounded-2xl p-4 relative overflow-hidden alert-pulse-full bg-rose-950/30 border border-rose-600';
    bannerText.textContent = 'BÃI XE ĐÃ ĐẦY';
    bannerText.className = 'text-lg font-black text-rose-400 mt-1.5 tracking-wide neon-glow-rose';
    bannerSub.textContent = 'OLED: "BAI XE DAY"';
    bannerIcon.className = 'w-12 h-12 rounded-xl bg-rose-500/20 text-rose-400 flex items-center justify-center text-xl border border-rose-500/40';
    bannerIcon.innerHTML = '<i class="fa-solid fa-triangle-exclamation animate-bounce"></i>';

    parkingStatusDesc.className = 'text-xs text-rose-400 font-semibold mt-3 flex items-center gap-1.5';
    parkingStatusDesc.innerHTML = '<i class="fa-solid fa-ban"></i> Ngừng nhận thêm xe vào';
  } else {
    bannerCard.className = 'glass-panel rounded-2xl p-4 relative overflow-hidden hover:border-slate-600 transition';
    bannerText.textContent = 'CÒN CHỖ TRỐNG';
    bannerText.className = 'text-lg font-black text-emerald-400 mt-1.5 tracking-wide neon-glow-emerald';
    bannerSub.textContent = 'OLED: "Bai do xe"';
    bannerIcon.className = 'w-12 h-12 rounded-xl bg-emerald-500/10 text-emerald-400 flex items-center justify-center text-xl border border-emerald-500/20';
    bannerIcon.innerHTML = '<i class="fa-solid fa-square-check"></i>';

    parkingStatusDesc.className = 'text-xs text-emerald-400 font-semibold mt-3 flex items-center gap-1.5';
    parkingStatusDesc.innerHTML = '<i class="fa-solid fa-door-open"></i> Đang mở nhận xe vào bãi';
  }

  // Render Slots P1, P2, P3
  renderSlot('p1', state.p1);
  renderSlot('p2', state.p2);
  renderSlot('p3', state.p3);

  // Render Barrier Gates
  renderGate('entry', state.entryGate);
  renderGate('exit', state.exitGate);

  // Sync simulator state if active
  simState = {
    p1: state.p1 ? 1 : 0,
    p2: state.p2 ? 1 : 0,
    p3: state.p3 ? 1 : 0,
    entryGate: state.entryGate ? 1 : 0,
    exitGate: state.exitGate ? 1 : 0
  };
  updateSimButtonsUI();
}

function renderSlot(slotId, isOccupied) {
  const card = document.getElementById(`slot-card-${slotId}`);
  const pill = document.getElementById(`${slotId}-status-pill`);
  const timeLabel = document.getElementById(`${slotId}-time-label`);

  if (isOccupied) {
    card.classList.remove('vacant');
    card.classList.add('occupied');
    pill.className = 'text-[10px] font-bold px-2.5 py-0.5 rounded-full bg-rose-500/20 text-rose-300 border border-rose-500/40 shadow-sm';
    pill.textContent = 'CÓ XE ĐỖ';
    timeLabel.textContent = 'Đang đỗ xe';
    timeLabel.className = 'text-[11px] text-rose-300 font-semibold';
  } else {
    card.classList.remove('occupied');
    card.classList.add('vacant');
    pill.className = 'text-[10px] font-bold px-2.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30';
    pill.textContent = 'TRỐNG';
    timeLabel.textContent = 'Sẵn sàng nhận xe';
    timeLabel.className = 'text-[11px] text-slate-400';
  }
}

function renderGate(gateType, isOpen) {
  const arm = document.getElementById(`gate-${gateType}-arm`);
  const badge = document.getElementById(`${gateType}-badge`);
  const carWait = document.getElementById(`car-${gateType}-wait`);
  const sensorStatus = document.getElementById(`${gateType}-sensor-status`);

  if (isOpen) {
    arm.classList.add('open');
    badge.className = 'px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/40';
    badge.textContent = 'MỞ (90°)';
    carWait.classList.remove('opacity-25');
    carWait.classList.add('opacity-100');
    sensorStatus.textContent = 'Phát hiện xe';
    sensorStatus.className = 'font-bold text-amber-400';
  } else {
    arm.classList.remove('open');
    badge.className = 'px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-slate-800 text-slate-300 border border-slate-700';
    badge.textContent = 'ĐÓNG (0°)';
    carWait.classList.remove('opacity-100');
    carWait.classList.add('opacity-25');
    sensorStatus.textContent = 'Thông thoáng';
    sensorStatus.className = 'font-medium text-slate-300';
  }
}

function updateDeviceStatus(online) {
  const ping = document.getElementById('ping-esp32');
  const dot = document.getElementById('dot-esp32');
  const text = document.getElementById('text-esp32');

  if (online) {
    ping.className = 'animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75';
    dot.className = 'relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500';
    text.textContent = 'ESP32: Online';
    text.className = 'font-mono font-semibold text-emerald-300';
  } else {
    ping.className = 'animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75';
    dot.className = 'relative inline-flex rounded-full h-2.5 w-2.5 bg-amber-500';
    text.textContent = 'ESP32: Chờ nối';
    text.className = 'font-mono text-slate-400';
  }
}

// Remote Actuator Control
async function sendRemoteCommand(command) {
  getAudioContext();
  playTone(900, 'sine', 0.1);
  try {
    const res = await fetch('/api/parking/control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command })
    });
    const data = await res.json();
    showToast(`Đã gửi lệnh đám mây: ${command}`);
  } catch (e) {
    console.error('Failed to send remote command:', e);
  }
}

// Simulator Drawer Toggles
document.getElementById('btn-toggle-sim').addEventListener('click', () => {
  const drawer = document.getElementById('sim-drawer');
  simMode = !simMode;
  if (simMode) {
    drawer.classList.remove('hidden');
    document.getElementById('btn-toggle-sim').innerHTML = '<i class="fa-solid fa-xmark"></i> <span>Đóng Bộ Giả Lập</span>';
    document.getElementById('btn-toggle-sim').className = 'btn-neon px-4 py-2 rounded-xl bg-gradient-to-r from-rose-600 to-red-600 text-white text-xs font-bold tracking-wide flex items-center gap-2 shadow-lg shadow-rose-600/30 transition';
  } else {
    drawer.classList.add('hidden');
    document.getElementById('btn-toggle-sim').innerHTML = '<i class="fa-solid fa-gamepad"></i> <span>Bật Bộ Giả Lập Demo</span>';
    document.getElementById('btn-toggle-sim').className = 'btn-neon px-4 py-2 rounded-xl bg-gradient-to-r from-cyan-600 to-blue-600 text-white text-xs font-bold tracking-wide flex items-center gap-2 shadow-lg shadow-cyan-500/20 transition';
  }
});

function toggleSimSensor(slot) {
  getAudioContext();
  simState[slot] = simState[slot] ? 0 : 1;
  pushSimState();
}

function toggleSimGate(gate) {
  getAudioContext();
  simState[gate] = simState[gate] ? 0 : 1;
  pushSimState();
}

function updateSimButtonsUI() {
  ['p1', 'p2', 'p3'].forEach(slot => {
    const label = document.getElementById(`sim-label-${slot}`);
    if (label) {
      label.textContent = simState[slot] ? 'CÓ XE' : 'TRỐNG';
      label.className = simState[slot] ? 'text-rose-400 font-bold' : 'text-emerald-400 font-bold';
    }
  });

  const entryLabel = document.getElementById('sim-label-entry');
  if (entryLabel) {
    entryLabel.textContent = simState.entryGate ? 'MỞ (90°)' : 'ĐÓNG (0°)';
    entryLabel.className = simState.entryGate ? 'text-emerald-400 font-bold' : 'text-slate-400 font-bold';
  }

  const exitLabel = document.getElementById('sim-label-exit');
  if (exitLabel) {
    exitLabel.textContent = simState.exitGate ? 'MỞ (90°)' : 'ĐÓNG (0°)';
    exitLabel.className = simState.exitGate ? 'text-emerald-400 font-bold' : 'text-slate-400 font-bold';
  }
}

async function pushSimState() {
  updateSimButtonsUI();
  try {
    await fetch('/api/parking/data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(simState)
    });
  } catch (e) {
    console.error('Sim push failed:', e);
  }
}

// Event Logs
async function fetchLogs() {
  try {
    const res = await fetch('/api/parking/logs');
    const data = await res.json();
    if (data.status === 'success') {
      const container = document.getElementById('event-logs-container');
      if (data.logs.length === 0) {
        container.innerHTML = '<div class="p-4 text-slate-500 text-center">Chưa có nhật ký sự kiện nào</div>';
        return;
      }
      container.innerHTML = '';
      data.logs.forEach(log => {
        container.appendChild(createLogElement(log));
      });
    }
  } catch (e) {
    console.error('Failed to fetch logs:', e);
  }
}

function prependEventLog(event) {
  const container = document.getElementById('event-logs-container');
  const el = createLogElement(event);
  container.insertBefore(el, container.firstChild);
}

function createLogElement(log) {
  const div = document.createElement('div');
  div.className = 'p-3 rounded-2xl bg-slate-900/80 border border-slate-800 flex items-start gap-3 transition hover:border-slate-700';

  let icon = 'fa-circle-info';
  let color = 'text-cyan-400';
  if (log.event_type.includes('PLATE')) {
    icon = 'fa-camera';
    color = 'text-cyan-300';
  } else if (log.event_type.includes('ENTER')) {
    icon = 'fa-car-side';
    color = 'text-emerald-400';
  } else if (log.event_type.includes('LEAVE')) {
    icon = 'fa-arrow-right-from-bracket';
    color = 'text-amber-400';
  } else if (log.event_type.includes('GATE')) {
    icon = 'fa-torii-gate';
    color = 'text-indigo-400';
  }

  const dateStr = log.created_at ? new Date(log.created_at).toLocaleTimeString('vi-VN') : 'Vừa xong';

  div.innerHTML = `
    <div class="mt-0.5 ${color} text-sm"><i class="fa-solid ${icon}"></i></div>
    <div class="flex-1">
      <div class="flex justify-between items-center">
        <span class="font-bold text-slate-200">${log.description}</span>
        <span class="text-[10px] text-slate-500 font-mono">${dateStr}</span>
      </div>
      <div class="text-[10px] text-slate-400 mt-1 flex gap-2 font-mono">
        <span>Vị trí: <b class="text-slate-200">${log.slot || 'N/A'}</b></span>
        <span>Mã: <code class="text-cyan-300">${log.event_type}</code></span>
      </div>
    </div>
  `;
  return div;
}

// Chart.js Setup with Cyberpunk Neon Palette
function initCharts() {
  const ctxTraffic = document.getElementById('chart-traffic').getContext('2d');
  
  // Create Gradient
  const gradTraffic = ctxTraffic.createLinearGradient(0, 0, 0, 160);
  gradTraffic.addColorStop(0, 'rgba(6, 182, 212, 0.4)');
  gradTraffic.addColorStop(1, 'rgba(6, 182, 212, 0.0)');

  trafficChart = new Chart(ctxTraffic, {
    type: 'line',
    data: {
      labels: ['08:00', '10:00', '12:00', '14:00', '16:00', '18:00'],
      datasets: [{
        label: 'Lượt xe vào',
        data: [0, 0, 0, 0, 0, 0],
        borderColor: '#06b6d4',
        borderWidth: 2.5,
        backgroundColor: gradTraffic,
        fill: true,
        tension: 0.4,
        pointBackgroundColor: '#38bdf8',
        pointRadius: 3
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#94a3b8', font: { size: 10, family: 'JetBrains Mono' } } },
        y: { beginAtZero: true, grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#94a3b8', stepSize: 1, font: { size: 10, family: 'JetBrains Mono' } } }
      }
    }
  });

  const ctxSlot = document.getElementById('chart-slots').getContext('2d');
  slotChart = new Chart(ctxSlot, {
    type: 'bar',
    data: {
      labels: ['Ô P1', 'Ô P2', 'Ô P3'],
      datasets: [{
        label: 'Số lần đỗ',
        data: [0, 0, 0],
        backgroundColor: ['#0284c7', '#4f46e5', '#9333ea'],
        borderRadius: 8,
        borderWidth: 1,
        borderColor: ['#38bdf8', '#818cf8', '#c084fc']
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false }, ticks: { color: '#94a3b8', font: { size: 10, family: 'JetBrains Mono' } } },
        y: { beginAtZero: true, grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#94a3b8', stepSize: 1, font: { size: 10, family: 'JetBrains Mono' } } }
      }
    }
  });
}

async function fetchAnalytics() {
  try {
    const res = await fetch('/api/parking/analytics');
    const data = await res.json();
    if (data.status === 'success' && data.analytics) {
      const an = data.analytics;
      document.getElementById('analytics-total-in').textContent = an.totalVehiclesIn || 0;
      document.getElementById('analytics-total-out').textContent = an.totalVehiclesOut || 0;
      document.getElementById('analytics-peak-rate').textContent = `${an.currentOccupancyPercent || 0}%`;

      const slotCounts = { P1: 0, P2: 0, P3: 0 };
      if (an.slotUsage) {
        an.slotUsage.forEach(row => {
          if (slotCounts.hasOwnProperty(row.slot)) {
            slotCounts[row.slot] = row.count;
          }
        });
      }
      if (slotChart) {
        slotChart.data.datasets[0].data = [slotCounts.P1, slotCounts.P2, slotCounts.P3];
        slotChart.update();
      }

      if (an.hourlyTraffic && an.hourlyTraffic.length > 0 && trafficChart) {
        trafficChart.data.labels = an.hourlyTraffic.map(r => `${r.hour}:00`);
        trafficChart.data.datasets[0].data = an.hourlyTraffic.map(r => r.count);
        trafficChart.update();
      }
    }
  } catch (e) {
    console.error('Failed to fetch analytics:', e);
  }
}

async function resetData() {
  if (confirm('Xác nhận xóa toàn bộ lịch sử dữ liệu kiểm toán trên SQLite Cloud Database?')) {
    await fetch('/api/parking/reset', { method: 'POST' });
    fetchLogs();
    fetchAnalytics();
  }
}

function showToast(msg) {
  const toast = document.createElement('div');
  toast.className = 'fixed bottom-5 right-5 bg-gradient-to-r from-cyan-600 to-blue-600 text-white text-xs font-bold px-4 py-3 rounded-2xl shadow-2xl z-50 flex items-center gap-2.5 animate-bounce border border-cyan-400/40';
  toast.innerHTML = `<i class="fa-solid fa-circle-check text-base"></i> <span>${msg}</span>`;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 2800);
}

document.addEventListener('DOMContentLoaded', () => {
  startClock();
  initWebSocket();
  initCharts();
  fetchLogs();
  fetchAnalytics();
});
