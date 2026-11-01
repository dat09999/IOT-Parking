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

        const isValid = msg.decision === 'VALID';
        const isFull = msg.decision === 'PARKING_FULL';

        if (plateEl) {
          plateEl.textContent = msg.plate;
          plateEl.className = isValid 
            ? 'text-lg font-black text-emerald-400 mt-1.5 font-mono tracking-widest animate-pulse'
            : 'text-lg font-black text-rose-400 mt-1.5 font-mono tracking-widest animate-pulse';
        }
        if (plateSub) {
          plateSub.textContent = `${msg.owner || 'Chưa đăng ký'} (${msg.gate})`;
        }
        if (hudPlate) {
          hudPlate.textContent = msg.plate;
          hudPlate.className = isValid
            ? 'bg-emerald-400 text-slate-950 px-4 py-2.5 rounded-xl font-mono text-center font-black text-2xl tracking-widest shadow-lg shadow-emerald-400/20 border-2 border-emerald-300'
            : 'bg-rose-500 text-white px-4 py-2.5 rounded-xl font-mono text-center font-black text-2xl tracking-widest shadow-lg shadow-rose-500/20 border-2 border-rose-400';
        }
        if (hudConf) {
          hudConf.textContent = isValid ? `HỢP LỆ (${msg.owner})` : 'KHÔNG HỢP LỆ';
          hudConf.className = isValid ? 'font-mono text-emerald-400 font-bold' : 'font-mono text-rose-400 font-bold';
        }
        if (hudTime) {
          hudTime.textContent = new Date().toLocaleTimeString('vi-VN');
        }
        if (hudAction) {
          if (isValid) {
            hudAction.textContent = msg.gate === 'ENTRY' ? 'Mở cổng vào (Barie nâng)' : 'Mở cổng ra (Barie nâng)';
            hudAction.className = 'font-semibold text-emerald-400';
            playTone(1046, 'sine', 0.2);
            showToast(`[HỢP LỆ] ${msg.plate} - ${msg.owner} -> Mở Barie`);
          } else if (isFull) {
            hudAction.textContent = 'Từ chối: Bãi xe đầy!';
            hudAction.className = 'font-semibold text-amber-400';
            playTone(500, 'square', 0.3);
            showToast(`[TỪ CHỐI] Bãi xe đã đầy chỗ!`);
          } else {
            hudAction.textContent = 'Cổng đóng: Biển số chưa đăng ký!';
            hudAction.className = 'font-semibold text-rose-400';
            playTone(400, 'sawtooth', 0.4);
            showToast(`[CẢNH BÁO] Biển số [${msg.plate}] không hợp lệ!`);
          }
        }

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
let currentCameraId = null;
let tesseractWorker = null;
let isWorkerReady = false;
let isWorkerLoading = false;
let currentVehicleAtEntry = 0;
let isProcessingRecognition = false;
let lastRecognizedPlate = '';
let lastRecognizedTime = 0;

// Khởi tạo Tesseract OCR Worker chạy ngầm siêu tốc ngay từ khi mở trang (Preload into RAM)
async function initTesseractWorker() {
  if (tesseractWorker || isWorkerLoading) return;
  isWorkerLoading = true;
  try {
    if (window.Tesseract) {
      tesseractWorker = await Tesseract.createWorker('eng', 1, {
        logger: () => {} // Tắt log ngầm để tối ưu hiệu năng
      });
      await tesseractWorker.setParameters({
        tessedit_char_whitelist: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ.-',
        tessedit_pageseg_mode: '7' // PSM 7: SINGLE_LINE (Cực kỳ nhanh và chuẩn cho biển số 1 dòng)
      });
      isWorkerReady = true;
      console.log('⚡ [AI ALPR] Tesseract OCR Worker đã nạp sẵn vào RAM, sẵn sàng nhận diện tức thì!');
    }
  } catch (err) {
    console.warn('⚠️ Chưa nạp được Tesseract Worker:', err);
  } finally {
    isWorkerLoading = false;
  }
}

async function populateCameraList() {
  const select = document.getElementById('camera-select');
  if (!select) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoDevices = devices.filter(d => d.kind === 'videoinput');
    select.innerHTML = '';
    
    if (videoDevices.length === 0) {
      select.innerHTML = '<option value="">Không thấy camera</option>';
      return;
    }

    let defaultIndex = 0;
    videoDevices.forEach((device, idx) => {
      const opt = document.createElement('option');
      opt.value = device.deviceId;
      opt.text = device.label || `Camera ${idx + 1}`;
      if (opt.text.toLowerCase().includes('ivcam') || opt.text.toLowerCase().includes('e2esoft')) {
        defaultIndex = idx;
      }
      select.appendChild(opt);
    });

    select.selectedIndex = defaultIndex;
    currentCameraId = select.value;
  } catch (err) {
    console.error('Lỗi lấy danh sách camera:', err);
  }
}

async function changeCameraSource() {
  const select = document.getElementById('camera-select');
  currentCameraId = select.value;
  if (webcamStream) {
    webcamStream.getTracks().forEach(track => track.stop());
    webcamStream = null;
    startCameraStream();
  }
}

async function startCameraStream() {
  const video = document.getElementById('webcam-video');
  const placeholder = document.getElementById('cam-placeholder');
  const btnText = document.getElementById('text-btn-cam');
  try {
    const constraints = {
      video: currentCameraId ? { deviceId: { exact: currentCameraId }, width: { ideal: 1280 } } : { width: { ideal: 1280 } }
    };
    webcamStream = await navigator.mediaDevices.getUserMedia(constraints);
    video.srcObject = webcamStream;
    video.classList.remove('hidden');
    placeholder.classList.add('hidden');
    btnText.textContent = 'Tắt Camera';
    populateCameraList();
    initTesseractWorker(); // Đảm bảo worker sẵn sàng
  } catch (err) {
    alert('Không thể mở camera: ' + err.message);
  }
}

async function toggleWebcamPreview() {
  const video = document.getElementById('webcam-video');
  const placeholder = document.getElementById('cam-placeholder');
  const btnText = document.getElementById('text-btn-cam');

  if (webcamStream) {
    webcamStream.getTracks().forEach(track => track.stop());
    webcamStream = null;
    video.classList.add('hidden');
    placeholder.classList.remove('hidden');
    btnText.textContent = 'Bật Camera';
  } else {
    await startCameraStream();
  }
}

// ================= THUẬT TOÁN ĐÁNH GIÁ ĐỘ NÉT & TIỀN XỬ LÝ ẢNH (BURST CAPTURE) =================

// Hàm đo độ sắc nét của ảnh (Laplacian / Edge gradient contrast)
function evaluateSharpness(imageData) {
  const data = imageData.data;
  const w = imageData.width;
  const h = imageData.height;
  let totalDiff = 0;
  let count = 0;

  for (let y = 1; y < h - 1; y += 2) {
    for (let x = 1; x < w - 1; x += 2) {
      const idx = (y * w + x) * 4;
      const g = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
      const gR = 0.299 * data[idx + 4] + 0.587 * data[idx + 5] + 0.114 * data[idx + 6];
      const gD = 0.299 * data[idx + w * 4] + 0.587 * data[idx + w * 4 + 1] + 0.114 * data[idx + w * 4 + 2];
      totalDiff += Math.abs(g - gR) + Math.abs(g - gD);
      count++;
    }
  }
  return count > 0 ? (totalDiff / count) : 0;
}

// Cắt đúng vùng khung ngắm trung tâm (bỏ chữ rác xung quanh), tiền xử lý nhị phân hóa siêu nét
function prepareOptimizedCrop(video, targetCanvas) {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return null;

  // Khung ngắm trung tâm tương ứng với HUD: sx 15%, sy 20%, sw 70%, sh 60%
  const sx = Math.floor(vw * 0.15);
  const sy = Math.floor(vh * 0.20);
  const sw = Math.floor(vw * 0.70);
  const sh = Math.floor(vh * 0.60);

  // Resize về kích thước chuẩn tối ưu cho OCR (chiều cao 110px -> OCR chạy trong 100ms)
  const targetH = 110;
  const targetW = Math.round((sw / sh) * targetH);

  targetCanvas.width = targetW;
  targetCanvas.height = targetH;
  const ctx = targetCanvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, targetW, targetH);

  const imgData = ctx.getImageData(0, 0, targetW, targetH);
  const d = imgData.data;

  // Tự động phân tích độ tương phản (Auto-Contrast Stretching)
  let minLum = 255, maxLum = 0;
  for (let i = 0; i < d.length; i += 4) {
    const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    if (lum < minLum) minLum = lum;
    if (lum > maxLum) maxLum = lum;
  }
  const range = Math.max(maxLum - minLum, 1);
  const threshold = minLum + range * 0.50; // Ngưỡng tách ký tự đen và nền trắng

  // Nhị phân hóa đen - trắng (Binarization)
  for (let i = 0; i < d.length; i += 4) {
    const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    const val = (lum < threshold) ? 0 : 255;
    d[i] = val;
    d[i + 1] = val;
    d[i + 2] = val;
  }

  ctx.putImageData(imgData, 0, 0);
  return { canvas: targetCanvas, imgData };
}

// Chuẩn hóa và làm sạch chuỗi biển số nhận diện
function cleanAndFormatPlate(rawText) {
  if (!rawText) return null;
  // Bỏ khoảng trắng và ký tự đặc biệt
  let s = rawText.toUpperCase().replace(/[^A-Z0-9]/g, '');
  
  // Tự động sửa các lỗi OCR thường gặp
  // 1. Chữ O ở 2 ký tự đầu (mã tỉnh) thành số 0 (hoặc nếu là 36C thì giữ nguyên)
  // 2. Tìm mẫu biển số Việt Nam: 2 số đầu + 1 hoặc 2 chữ series + 4 đến 5 số đuôi
  const match = s.match(/([0-9]{2}[A-Z]{1,2}[0-9]{4,5})/);
  if (match) {
    const p = match[0];
    const prov = p.slice(0, 2);
    let series = '';
    let numPart = '';
    if (isNaN(p[2]) && isNaN(p[3])) {
      series = p.slice(2, 4);
      numPart = p.slice(4);
    } else {
      series = p.slice(2, 3);
      numPart = p.slice(3);
    }
    if (numPart.length === 5) {
      return `${prov}${series}-${numPart.slice(0, 3)}.${numPart.slice(3)}`;
    } else {
      return `${prov}${series}-${numPart}`;
    }
  }
  
  // Trường hợp có dấu gạch ngang sẵn
  const altMatch = rawText.match(/([0-9]{2}[A-Z]{1,2}[-.\s]?[0-9]{3,5}[.]?[0-9]{0,2})/i);
  if (altMatch && altMatch[0].length >= 6) {
    return altMatch[0].toUpperCase().replace(/\s+/g, '');
  }
  return null;
}

// ================= HÀM KÍCH HOẠT NHẬN DIỆN BIỂN SỐ SIÊU TỐC (BURST MODE 2-3 FRAME) =================
async function triggerBurstRecognition(isManual = false) {
  const video = document.getElementById('webcam-video');
  const canvas = document.getElementById('webcam-canvas');
  const hudPlate = document.getElementById('hud-plate-display');
  const hudConf = document.getElementById('hud-confidence');
  const hudTime = document.getElementById('hud-timestamp');
  const hudAction = document.getElementById('hud-gate-action');
  const btnScan = document.getElementById('text-btn-scan');
  const laser = document.getElementById('hud-laser-line');

  if (!video || !webcamStream || video.videoWidth === 0) {
    if (isManual) alert('Vui lòng bấm "Bật Camera" trước khi quét!');
    return;
  }

  if (isProcessingRecognition) return;
  isProcessingRecognition = true;

  if (laser) laser.classList.remove('opacity-0');
  if (btnScan) btnScan.textContent = '⚡ Đang quét...';
  if (hudPlate) {
    hudPlate.textContent = 'ĐANG QUÉT BIỂN SỐ...';
    hudPlate.className = 'bg-cyan-500 text-slate-950 px-4 py-2.5 rounded-xl font-mono text-center font-black text-2xl tracking-widest shadow-lg shadow-cyan-500/30 border-2 border-cyan-300 animate-pulse';
  }
  if (hudAction) {
    hudAction.textContent = 'Đang nhận diện AI siêu tốc...';
    hudAction.className = 'font-semibold text-cyan-400';
  }

  const startTime = performance.now();

  try {
    if (!tesseractWorker) {
      await initTesseractWorker();
    }

    // Chụp liên tiếp 3 ảnh (cách nhau 40ms) và chọn ảnh có độ sắc nét tốt nhất
    const burstCandidates = [];
    for (let i = 0; i < 3; i++) {
      const tempCanv = document.createElement('canvas');
      const crop = prepareOptimizedCrop(video, tempCanv);
      if (crop) {
        const sharpness = evaluateSharpness(crop.imgData);
        burstCandidates.push({ canvas: tempCanv, sharpness });
      }
      if (i < 2) await new Promise(r => setTimeout(r, 40));
    }

    if (burstCandidates.length === 0) {
      throw new Error('Không chụp được khung hình từ camera');
    }

    // Chọn ảnh nét nhất
    burstCandidates.sort((a, b) => b.sharpness - a.sharpness);
    const bestFrame = burstCandidates[0];

    // Vẽ lên canvas chính để hiển thị kiểm tra
    canvas.width = bestFrame.canvas.width;
    canvas.height = bestFrame.canvas.height;
    canvas.getContext('2d').drawImage(bestFrame.canvas, 0, 0);

    // Chạy OCR trực tiếp trên ảnh nét nhất đã nhị phân hóa
    let detectedPlate = null;
    if (tesseractWorker) {
      const res = await tesseractWorker.recognize(bestFrame.canvas);
      detectedPlate = cleanAndFormatPlate(res.data.text);
      console.log('⚡ [OCR Raw]:', res.data.text, '-> [Plate]:', detectedPlate, 'Nét:', bestFrame.sharpness.toFixed(1));
    }

    const elapsed = Math.round(performance.now() - startTime);

    if (detectedPlate) {
      lastRecognizedPlate = detectedPlate;
      lastRecognizedTime = Date.now();
      showToast(`⚡ Đã nhận diện [${detectedPlate}] trong ${elapsed}ms (Độ nét: ${bestFrame.sharpness.toFixed(0)})`);

      // Gửi ngay lên Cloud Server để đối chiếu Whitelist CSDL và ra quyết định
      const resp = await fetch('/api/parking/alpr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          plate: detectedPlate,
          gate: 'entry',
          confidence: 0.98
        })
      });
      const data = await resp.json();
      console.log('Kết quả từ Cloud Server:', data);
    } else {
      // Nếu chưa nhận diện được
      if (hudPlate && !hudPlate.classList.contains('bg-emerald-400')) {
        hudPlate.textContent = 'CHƯA RÕ BIỂN SỐ';
        hudPlate.className = 'bg-slate-700 text-slate-300 px-4 py-2.5 rounded-xl font-mono text-center font-bold text-xl tracking-wider';
        setTimeout(() => {
          if (currentVehicleAtEntry === 0 && hudPlate.textContent === 'CHƯA RÕ BIỂN SỐ') {
            hudPlate.textContent = 'CHỜ XE ĐẾN...';
            hudPlate.className = 'bg-amber-400 text-slate-950 px-4 py-2.5 rounded-xl font-mono text-center font-black text-2xl tracking-widest shadow-lg shadow-amber-400/20 border-2 border-amber-300';
          }
        }, 1800);
      }
      if (isManual) {
        showToast('⚠️ Chưa nhận diện rõ biển số! Hãy căn biển số vào đúng khung ngắm.');
      }
    }
  } catch (err) {
    console.error('Lỗi nhận diện:', err);
    if (isManual) showToast('Lỗi: ' + err.message);
  } finally {
    isProcessingRecognition = false;
    if (laser) laser.classList.add('opacity-0');
    if (btnScan) btnScan.textContent = '⚡ Quét Thử Ngay';
  }
}

// Nút bấm kích hoạt thủ công trên giao diện
function manualTriggerScan() {
  if (!webcamStream) {
    toggleWebcamPreview().then(() => {
      setTimeout(() => triggerBurstRecognition(true), 800);
    });
    return;
  }
  triggerBurstRecognition(true);
}

// Xử lý sự kiện cảm biến xe đến cổng vào (từ ESP32 hoặc bộ giả lập)
function handleVehicleArrivalSensor(isArrived) {
  const hudPlate = document.getElementById('hud-plate-display');
  const hudConf = document.getElementById('hud-confidence');
  const hudAction = document.getElementById('hud-gate-action');
  const targetBox = document.getElementById('hud-target-box');
  const simLabel = document.getElementById('sim-label-vehicle');

  if (simLabel) {
    simLabel.textContent = isArrived ? 'CÓ XE' : 'CHỜ XE';
    simLabel.className = isArrived ? 'text-amber-400 font-bold animate-pulse' : 'text-slate-400';
  }

  if (isArrived) {
    if (currentVehicleAtEntry === 0) {
      currentVehicleAtEntry = 1;
      playTone(880, 'sine', 0.15);
      showToast('🚗 [CẢM BIẾN] Xe đã đến cổng vào! Kích hoạt nhận diện biển số...');
      
      // Tự động bật camera nếu đang tắt
      if (!webcamStream) {
        startCameraStream().then(() => {
          setTimeout(() => triggerBurstRecognition(false), 600);
        });
      } else {
        triggerBurstRecognition(false);
      }
    }
  } else {
    currentVehicleAtEntry = 0;
    // Khi xe đi qua, sau 3.5s nếu không có xe mới thì đưa giao diện về trạng thái CHỜ XE ĐẾN
    setTimeout(() => {
      if (currentVehicleAtEntry === 0) {
        if (hudPlate && !isProcessingRecognition) {
          hudPlate.textContent = 'CHỜ XE ĐẾN...';
          hudPlate.className = 'bg-amber-400 text-slate-950 px-4 py-2.5 rounded-xl font-mono text-center font-black text-2xl tracking-widest shadow-lg shadow-amber-400/20 border-2 border-amber-300';
        }
        if (hudConf) {
          hudConf.textContent = '-- %';
          hudConf.className = 'font-mono text-cyan-400 font-bold';
        }
        if (hudAction) {
          hudAction.textContent = 'Tự động nâng barie';
          hudAction.className = 'font-semibold text-emerald-400';
        }
      }
    }, 4000);
  }
}

// Bật/tắt giả lập cảm biến xe vào cổng
function toggleSimVehicleEntry() {
  const nextVal = currentVehicleAtEntry === 1 ? 0 : 1;
  handleVehicleArrivalSensor(nextVal === 1);
  if (simMode) {
    fetch('/api/parking/data', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': 'IOT_SECURE_TOKEN_2026'
      },
      body: JSON.stringify({
        p1: simState.p1,
        p2: simState.p2,
        p3: simState.p3,
        entryGate: simState.entryGate,
        exitGate: simState.exitGate,
        vehicleAtEntry: nextVal
      })
    }).catch(e => console.error('Sim error:', e));
  }
}

// Render System State
let previousFreeSlots = 3;
function renderState(state) {
  if (!state) return;

  updateDeviceStatus(state.deviceOnline);

  // Nhận diện tín hiệu cảm biến xe đến cổng vào (PIN 35 từ ESP32)
  if (state.vehicleAtEntry !== undefined) {
    handleVehicleArrivalSensor(state.vehicleAtEntry === 1 || state.vehicleAtEntry === true);
  }

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
  populateCameraList();
  initTesseractWorker(); // Nạp sẵn Tesseract Worker vào RAM
});
