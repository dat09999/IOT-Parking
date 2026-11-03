const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function flushMicrotasks() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

class FakeClock {
  now = 0;
  nextId = 1;
  jobs = new Map();

  schedule = (callback, delay = 0, repeat = false) => {
    const id = this.nextId++;
    this.jobs.set(id, { callback, at: this.now + delay, delay, repeat });
    return id;
  };

  clear = id => { this.jobs.delete(id); };

  async advance(milliseconds) {
    const target = this.now + milliseconds;
    await flushMicrotasks();
    for (let iterations = 0; iterations < 1000; iterations++) {
      const next = [...this.jobs.entries()]
        .filter(([, job]) => job.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) {
        this.now = target;
        await flushMicrotasks();
        return;
      }
      const [id, job] = next;
      this.now = job.at;
      if (job.repeat) job.at += job.delay;
      else this.jobs.delete(id);
      job.callback();
      await flushMicrotasks();
    }
    throw new Error('Fake timer loop did not settle');
  }
}

class FakeElement {
  constructor() {
    this.listeners = new Map();
    this.children = [];
    this.style = {};
    this.className = '';
    this.textContent = '';
    this.value = '';
    this.videoWidth = 640;
    this.videoHeight = 480;
    this.readyState = 4;
    this.width = 640;
    this.height = 480;
    this.classList = {
      contains: name => this.className.split(/\s+/).includes(name),
      add: (...names) => { this.className += ` ${names.join(' ')}`; },
      remove: (...names) => {
        this.className = this.className.split(/\s+/).filter(name => !names.includes(name)).join(' ');
      }
    };
  }

  addEventListener(name, listener) {
    const listeners = this.listeners.get(name) || new Set();
    listeners.add(listener);
    this.listeners.set(name, listeners);
  }

  removeEventListener(name, listener) { this.listeners.get(name)?.delete(listener); }
  appendChild(child) { this.children.push(child); return child; }
  remove() {}
  async play() {}
  pause() {}

  getContext() {
    return {
      drawImage() {}, putImageData() {},
      getImageData() { return { data: new Uint8ClampedArray(16), width: 2, height: 2 }; }
    };
  }
}

function createHarness({ createWorker, recognize, fetchResponse } = {}) {
  const clock = new FakeClock();
  const elements = new Map();
  const calls = { createWorker: 0, recognize: 0, terminate: 0, fetch: [] };
  let track;
  function makeStream() {
    const nextTrack = {
      readyState: 'live',
      stop() { this.readyState = 'ended'; },
      getSettings() { return { deviceId: 'ivcam-device' }; },
      addEventListener() {}, removeEventListener() {}
    };
    track = nextTrack;
    return { getTracks: () => [nextTrack], getVideoTracks: () => [nextTrack] };
  }
  const worker = {
    async setParameters() {},
    async recognize(image) {
      calls.recognize++;
      return recognize ? recognize(image) : { data: { text: '', confidence: 0 } };
    },
    async terminate() { calls.terminate++; }
  };
  const tesseract = {
    createWorker(...args) {
      calls.createWorker++;
      return createWorker ? createWorker(...args) : Promise.resolve(worker);
    }
  };
  function getElement(id) {
    if (!elements.has(id)) elements.set(id, new FakeElement());
    return elements.get(id);
  }
  const document = {
    getElementById: getElement,
    createElement: () => new FakeElement(),
    addEventListener() {},
    querySelectorAll: () => []
  };
  const fetch = async (url, options) => {
    calls.fetch.push({ url, options });
    if (fetchResponse) return fetchResponse(url, options);
    return {
      ok: true, status: 200,
      async json() { return { status: 'success', plate: '36C-925.64', decision: 'VALID' }; }
    };
  };
  const context = vm.createContext({
    document,
    window: { Tesseract: tesseract, location: { protocol: 'http:', host: 'example.test' } },
    Tesseract: tesseract,
    navigator: {
      mediaDevices: {
        async getUserMedia() { return makeStream(); },
        async enumerateDevices() {
          return [{ kind: 'videoinput', label: 'e2eSoft iVCam', deviceId: 'ivcam-device' }];
        }
      }
    },
    console: { log() {}, warn() {}, error() {} },
    setTimeout: (callback, delay) => clock.schedule(callback, delay),
    clearTimeout: clock.clear,
    setInterval: (callback, delay) => clock.schedule(callback, delay, true),
    clearInterval: clock.clear,
    performance: { now: () => clock.now },
    Date: class extends Date { static now() { return 10000 + clock.now; } },
    AbortController,
    DOMException,
    fetch,
    alert(message) { throw new Error(`Unexpected browser alert: ${message}`); }
  });
  const helpers = fs.readFileSync(path.join(__dirname, '..', 'public', 'alpr-utils.js'), 'utf8');
  vm.runInContext(helpers, context, { filename: 'public/alpr-utils.js' });
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'public/app.js' });
  vm.runInContext('showToast = () => {}; playTone = () => {};', context);
  return { context, clock, calls, get track() { return track; }, worker, getElement };
}

test('concurrent OCR initialization callers all wait for one configured worker', { timeout: 2000 }, async () => {
  const creation = deferred();
  const configuration = deferred();
  const worker = { setParameters: () => configuration.promise, async terminate() {} };
  const harness = createHarness({ createWorker: () => creation.promise });
  let firstReady = false;
  let secondReady = false;
  const first = harness.context.initTesseractWorker().then(result => { firstReady = true; return result; });
  const second = harness.context.initTesseractWorker().then(result => { secondReady = true; return result; });
  await flushMicrotasks();
  assert.equal(harness.calls.createWorker, 1);
  assert.equal(firstReady, false);
  assert.equal(secondReady, false, 'the second caller must wait for creation');
  creation.resolve(worker);
  await flushMicrotasks();
  assert.equal(firstReady, false);
  assert.equal(secondReady, false, 'the second caller must also wait for parameters');
  configuration.resolve();
  const results = await Promise.all([first, second]);
  assert.equal(results[0], worker);
  assert.equal(results[1], worker);
});

test('failed OCR configuration releases the failed worker and allows a fresh initialization', { timeout: 2000 }, async () => {
  let creations = 0;
  let terminated = 0;
  const failedWorker = {
    async setParameters() { throw new Error('settings failed'); },
    async terminate() { terminated++; }
  };
  const readyWorker = { async setParameters() {}, async terminate() {} };
  const harness = createHarness({ createWorker: async () => ++creations === 1 ? failedWorker : readyWorker });
  await assert.rejects(harness.context.initTesseractWorker());
  assert.equal(terminated, 1, 'failed initialization must release its worker');
  const recovered = await harness.context.initTesseractWorker();
  assert.equal(creations, 2);
  assert.equal(recovered, readyWorker);
});

test('OCR initialization can recover after its browser library becomes available', { timeout: 2000 }, async () => {
  const harness = createHarness();
  harness.context.window.Tesseract = undefined;
  await assert.rejects(harness.context.initTesseractWorker(), /OCR/);
  assert.equal(harness.calls.createWorker, 0);
  harness.context.window.Tesseract = harness.context.Tesseract;
  const worker = await harness.context.initTesseractWorker();
  assert.equal(worker, harness.worker);
  assert.equal(harness.calls.createWorker, 1);
});

test('a worker that finishes initialization after reset cannot replace the newer ready worker', { timeout: 2000 }, async () => {
  const oldCreation = deferred();
  let creations = 0;
  let oldTerminations = 0;
  const oldWorker = { async setParameters() {}, async terminate() { oldTerminations++; } };
  const newWorker = { async setParameters() {}, async terminate() {} };
  const harness = createHarness({ createWorker: () => ++creations === 1 ? oldCreation.promise : Promise.resolve(newWorker) });
  const oldInit = harness.context.initTesseractWorker();
  const oldRejected = assert.rejects(oldInit, /OCR/);
  await flushMicrotasks();
  await harness.context.resetTesseractWorker();
  assert.equal(await harness.context.initTesseractWorker(), newWorker);
  oldCreation.resolve(oldWorker);
  await oldRejected;
  assert.equal(oldTerminations, 1);
  assert.equal(await harness.context.initTesseractWorker(), newWorker);
  assert.equal(creations, 2, 'late completion must not invalidate the new cached worker');
});

test('manual OCR retry survives repeated sensor telemetry reporting no vehicle', { timeout: 2000 }, async () => {
  const harness = createHarness();
  await harness.context.startCameraStream();
  const scan = harness.context.run20FramesCaptureCycle(true);
  await harness.clock.advance(2500);
  await scan;
  const firstAttempts = harness.calls.recognize;
  assert.ok(firstAttempts > 0, 'the initial burst must attempt OCR');
  harness.context.handleVehicleArrivalSensor(false);
  harness.context.handleVehicleArrivalSensor(false);
  await harness.clock.advance(8000);
  assert.ok(harness.calls.recognize > firstAttempts, 'the scheduled manual retry must still perform OCR');
  assert.equal(harness.calls.fetch.length, 0, 'unreadable frames must not reach the server');
});

test('sensor-origin retry stops when the vehicle leaves and rearms for the next arrival', { timeout: 2000 }, async () => {
  const harness = createHarness();
  await harness.context.startCameraStream();
  harness.context.handleVehicleArrivalSensor(true);
  await harness.clock.advance(2500);
  const firstAttempts = harness.calls.recognize;
  assert.ok(firstAttempts > 0);
  harness.context.handleVehicleArrivalSensor(false);
  await harness.clock.advance(8000);
  assert.equal(harness.calls.recognize, firstAttempts, 'a departed vehicle must not trigger another OCR burst');
  assert.equal(harness.clock.jobs.size, 0);
  harness.context.handleVehicleArrivalSensor(true);
  await harness.clock.advance(2500);
  assert.ok(harness.calls.recognize > firstAttempts, 'a new vehicle arrival must start a new burst');
  assert.equal(harness.calls.fetch.length, 0);
});

test('stopping the camera while OCR is in flight prevents posting the stale plate', { timeout: 2000 }, async () => {
  const recognition = deferred();
  const harness = createHarness({ recognize: () => recognition.promise });
  await harness.context.startCameraStream();
  const scan = harness.context.run20FramesCaptureCycle(true);
  await harness.clock.advance(2500);
  assert.ok(harness.calls.recognize > 0, 'OCR must be in flight before stopping');
  await harness.context.toggleWebcamPreview();
  assert.equal(harness.track.readyState, 'ended');
  recognition.resolve({ data: { text: '36C-925.64', confidence: 95 } });
  await flushMicrotasks();
  await scan;
  assert.equal(harness.calls.fetch.length, 0, 'a stopped capture session must never post its old OCR result');
});

test('a reopened camera can scan while OCR from its canceled session is still pending', { timeout: 2000 }, async () => {
  const oldRecognition = deferred();
  let requests = 0;
  const harness = createHarness({
    recognize: async () => ++requests === 1
      ? oldRecognition.promise
      : { data: { text: '', confidence: 0, lines: [] } }
  });
  await harness.context.startCameraStream();
  const oldScan = harness.context.run20FramesCaptureCycle(true);
  await harness.clock.advance(2500);
  assert.equal(requests, 1);
  await harness.context.toggleWebcamPreview();
  await harness.context.startCameraStream();
  const newScan = harness.context.run20FramesCaptureCycle(true);
  let requestsBeforeOldCompletion;
  try {
    await harness.clock.advance(2500);
    requestsBeforeOldCompletion = requests;
  } finally {
    oldRecognition.resolve({ data: { text: '', confidence: 0, lines: [] } });
    await flushMicrotasks();
    await Promise.all([oldScan, newScan]);
  }
  assert.ok(requestsBeforeOldCompletion > 1, 'canceling an old session must release the scan lock immediately');
  assert.equal(harness.calls.fetch.length, 0);
});

test('a stalled OCR mode change eventually resets the worker and retries the scan', { timeout: 2000 }, async () => {
  const stalledModeChange = deferred();
  let creations = 0;
  const harness = createHarness({
    createWorker: async () => {
      const shouldStall = ++creations === 1;
      let modeChanges = 0;
      return {
        async setParameters() {
          if (shouldStall && ++modeChanges === 2) return stalledModeChange.promise;
        },
        async recognize() { return { data: { text: '', confidence: 0, lines: [] } }; },
        async terminate() {}
      };
    }
  });
  await harness.context.startCameraStream();
  const scan = harness.context.run20FramesCaptureCycle(true);
  let creationsBeforeRecovery;
  try {
    await harness.clock.advance(50000);
    creationsBeforeRecovery = creations;
  } finally {
    stalledModeChange.resolve();
    await flushMicrotasks();
    await scan;
  }
  assert.ok(creationsBeforeRecovery > 1, 'mode-change timeouts must recover just like recognition timeouts');
  assert.equal(harness.calls.fetch.length, 0);
});

test('stopping the camera clears the pending retry and countdown', { timeout: 2000 }, async () => {
  const harness = createHarness();
  await harness.context.startCameraStream();
  const scan = harness.context.run20FramesCaptureCycle(true);
  await harness.clock.advance(2500);
  await scan;
  const attempts = harness.calls.recognize;
  assert.ok(attempts > 0);
  await harness.context.toggleWebcamPreview();
  assert.equal(harness.clock.jobs.size, 0, 'camera stop must dispose of pending recognition timers');
  await harness.clock.advance(20000);
  assert.equal(harness.calls.recognize, attempts);
  assert.equal(harness.calls.fetch.length, 0);
});

test('a successful POST renders the recognized plate and server decision without WebSocket events', { timeout: 2000 }, async () => {
  const harness = createHarness({
    recognize: async () => ({ data: { text: '36C-925.64', confidence: 95, lines: [] } }),
    fetchResponse: async () => ({
      ok: true, status: 200,
      async json() {
        return { status: 'success', plate: '36C-925.64', decision: 'VALID', action: 'Server confirmed entry' };
      }
    })
  });
  await harness.context.startCameraStream();
  const scan = harness.context.run20FramesCaptureCycle(true);
  await harness.clock.advance(2500);
  await scan;
  assert.equal(harness.calls.fetch.length, 1);
  const payload = JSON.parse(harness.calls.fetch[0].options.body);
  assert.equal(payload.plate, '36C-925.64');
  assert.equal(payload.confidence, 0.95);
  assert.equal(harness.getElement('hud-plate-display').textContent, '36C-925.64');
  assert.equal(harness.getElement('stat-plate-text').textContent, '36C-925.64');
  assert.equal(harness.getElement('hud-gate-action').textContent, 'Server confirmed entry');
  assert.ok(harness.getElement('hud-plate-display').classList.contains('bg-emerald-400'));
});

test('an HTTP failure preserves the recognized plate and reports a server failure instead of unreadable OCR', { timeout: 2000 }, async () => {
  const harness = createHarness({
    recognize: async () => ({ data: { text: '36C-925.64', confidence: 95, lines: [] } }),
    fetchResponse: async () => ({
      ok: false, status: 429,
      async json() { return { status: 'error', message: 'Rate limited' }; }
    })
  });
  await harness.context.startCameraStream();
  const scan = harness.context.run20FramesCaptureCycle(true);
  await harness.clock.advance(2500);
  await scan;
  assert.equal(harness.calls.fetch.length, 1);
  assert.equal(harness.getElement('hud-plate-display').textContent, '36C-925.64');
  assert.match(harness.getElement('hud-gate-action').textContent, /chưa gửi|máy chủ/i);
  assert.equal(harness.getElement('hud-plate-display').classList.contains('bg-emerald-400'), false);
  assert.equal(harness.clock.jobs.size, 0, 'a server error must not masquerade as an OCR retry');
});

test('an invalid plate decision keeps the plate text and schedules an auto retry after 5 seconds', { timeout: 3000 }, async () => {
  let fetchCount = 0;
  const harness = createHarness({
    recognize: async () => ({ data: { text: '36C-925.60', confidence: 95, lines: [] } }),
    fetchResponse: async () => {
      fetchCount++;
      return {
        ok: true, status: 200,
        async json() {
          return { status: 'success', plate: '36C-925.60', decision: 'INVALID', action: 'Biển số chưa được phép vào bãi' };
        }
      };
    }
  });
  await harness.context.startCameraStream();
  const scan = harness.context.run20FramesCaptureCycle(true);
  await harness.clock.advance(2500);
  await scan;

  assert.equal(fetchCount, 1);
  assert.equal(harness.getElement('hud-plate-display').textContent, '36C-925.60');
  assert.ok(harness.getElement('hud-plate-display').classList.contains('bg-amber-400'));
  assert.match(harness.getElement('hud-gate-action').textContent, /5s/);

  // Sau 5s đếm ngược, chu kỳ quét tiếp theo sẽ tự động được gọi
  await harness.clock.advance(7500);
  assert.ok(fetchCount >= 2, 'phải tự động quét lại sau 5s khi biển số không hợp lệ');
});

function pixelFixture({ rectangle, plateColor = [245, 245, 245], holes = true, background = [20, 20, 20] } = {}) {
  const image = { width: 1280, height: 720, pixels: new Uint8ClampedArray(1280 * 720 * 4) };
  function fillRect(x, y, width, height, color) {
    for (let row = y; row < y + height; row++) {
      for (let column = x; column < x + width; column++) {
        const index = (row * image.width + column) * 4;
        image.pixels[index] = color[0];
        image.pixels[index + 1] = color[1];
        image.pixels[index + 2] = color[2];
        image.pixels[index + 3] = 255;
      }
    }
  }
  fillRect(0, 0, image.width, image.height, background);
  if (rectangle) {
    const { x, y, width, height } = rectangle;
    fillRect(x, y, width, height, plateColor);
    if (holes) {
      for (let character = 0; character < 8; character++) {
        fillRect(x + 20 + character * 36, y + 14, 14, height - 28, [15, 15, 15]);
      }
    }
  }
  return image;
}

function pixelRegions(image) {
  const harness = createHarness();
  harness.context.document.createElement = () => {
    const canvas = { width: 0, height: 0, pixels: null };
    canvas.getContext = () => ({
      drawImage(source) {
        canvas.pixels = new Uint8ClampedArray(canvas.width * canvas.height * 4);
        for (let y = 0; y < canvas.height; y++) {
          for (let x = 0; x < canvas.width; x++) {
            const sourceIndex = (Math.floor(y * source.height / canvas.height) * source.width +
              Math.floor(x * source.width / canvas.width)) * 4;
            const targetIndex = (y * canvas.width + x) * 4;
            canvas.pixels.set(source.pixels.subarray(sourceIndex, sourceIndex + 4), targetIndex);
          }
        }
      },
      getImageData() { return { data: canvas.pixels, width: canvas.width, height: canvas.height }; }
    });
    return canvas;
  };
  return harness.context.plateImageRegions(image);
}

test('white and yellow plate regions with character holes retain native-image coordinates', () => {
  const rectangle = { x: 200, y: 260, width: 400, height: 100 };
  for (const plateColor of [[245, 245, 245], [245, 220, 35]]) {
    const regions = pixelRegions(pixelFixture({ rectangle, plateColor }));
    assert.equal(regions.length, 1, `expected one region for color ${plateColor}`);
    const region = regions[0];
    assert.ok(region.x <= rectangle.x && region.x >= rectangle.x - 12);
    assert.ok(region.y <= rectangle.y && region.y >= rectangle.y - 12);
    assert.ok(region.width >= rectangle.width && region.width <= rectangle.width + 24);
    assert.ok(region.height >= rectangle.height && region.height <= rectangle.height + 24);
    assert.ok(region.x + region.width >= rectangle.x + rectangle.width);
    assert.ok(region.y + region.height >= rectangle.y + rectangle.height);
  }
});

test('blank scenes and solid bright rectangles are not treated as text-bearing plates', () => {
  const fixtures = [
    pixelFixture(),
    pixelFixture({ background: [245, 245, 245] }),
    pixelFixture({ rectangle: { x: 200, y: 260, width: 400, height: 100 }, holes: false })
  ];
  for (const image of fixtures) assert.equal(pixelRegions(image).length, 0);
});

test('plate crops touching image edges stay within the native image bounds', () => {
  const rectangles = [
    { x: 0, y: 0, width: 360, height: 100 },
    { x: 920, y: 620, width: 360, height: 100 }
  ];
  for (const rectangle of rectangles) {
    const image = pixelFixture({ rectangle });
    const regions = pixelRegions(image);
    assert.equal(regions.length, 1);
    const region = regions[0];
    assert.ok(region.x >= 0 && region.y >= 0);
    assert.ok(region.x + region.width <= image.width);
    assert.ok(region.y + region.height <= image.height);
    assert.ok(region.x <= rectangle.x && region.y <= rectangle.y);
    assert.ok(region.x + region.width >= rectangle.x + rectangle.width);
    assert.ok(region.y + region.height >= rectangle.y + rectangle.height);
  }
});
