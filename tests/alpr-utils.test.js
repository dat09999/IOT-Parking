const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const {
  cleanAndFormatPlate,
  extractPlateCandidates,
  selectStableReading
} = require('../public/alpr-utils.js');

test('formats car plates without losing digits or changing letters', () => {
  for (const [input, expected] of [
    ['36C-925.64', '36C-925.64'],
    ['30a12345', '30A-123.45'],
    ['30AB\n12345', '30AB-123.45'],
    ['36C-9256', '36C-9256'],
    ['30A-001.02', '30A-001.02']
  ]) {
    assert.equal(cleanAndFormatPlate(input), expected, input);
  }
});

test('preserves motorcycle series digits in single-line, two-line and compact OCR', () => {
  for (const [input, expected] of [
    ['59F1-123.45', '59F1-123.45'],
    ['59F1\n123.45', '59F1-123.45'],
    ['59-F1\r\n12345', '59F1-123.45'],
    ['59F112345', '59F1-123.45'],
    ['43E1-012.34', '43E1-012.34'],
    ['59F1-1234', '59F1-1234']
  ]) {
    assert.equal(cleanAndFormatPlate(input), expected, input);
  }
});

test('extracts distinct complete plates from prose in their original order', () => {
  assert.deepEqual(
    extractPlateCandidates('Plate: 36C-925.64; bike: 59F1\n123.45; repeat 36C92564'),
    ['36C-925.64', '59F1-123.45']
  );
});

test('does not salvage a truncated plate from longer numbers or adjacent letters', () => {
  for (const input of [
    '136C92564', '36C-925.641', '59F1-123.456', '59F1123456',
    '30AB123456', '30A-123456', 'noise36C92564tail', '59F1-123.45Z'
  ]) {
    assert.deepEqual(extractPlateCandidates(input), [], input);
  }
});

test('rejects empty and unrecognized text without inventing O/0 substitutions', () => {
  for (const input of [null, undefined, '', '   ', 'Waiting for iVCam', '3OC-925.64']) {
    assert.equal(cleanAndFormatPlate(input), null);
  }
});

test('requires agreement on the same plate from distinct frames despite OCR jitter', () => {
  const readings = [
    { plate: '36C-925.64', confidence: 70, frameId: 1 },
    { plate: '36C-925.84', confidence: 95, frameId: 2 },
    { plate: '36C92564', confidence: 90, frameId: 3 }
  ];
  assert.deepEqual(selectStableReading(readings), {
    plate: '36C-925.64', confidence: 80, frameCount: 2
  });
  assert.equal(selectStableReading(readings.slice(0, 2)), null);
});

test('multiple preprocessing variants from one frame are only one vote', () => {
  const readings = [
    { plate: '59F1-123.45', confidence: 50, frameId: 1 },
    { plate: '59F112345', confidence: 95, frameId: '1' }
  ];
  assert.equal(selectStableReading(readings), null);
  readings.push({ plate: '59F1\n123.45', confidence: 75, frameId: 2 });
  assert.deepEqual(selectStableReading(readings), {
    plate: '59F1-123.45', confidence: 85, frameCount: 2
  });
});

test('different plates cannot combine their frame counts', () => {
  assert.equal(selectStableReading([
    { plate: '36C-925.64', confidence: 90, frameId: 1 },
    { plate: '59F1-123.45', confidence: 90, frameId: 2 }
  ]), null);
});

test('low or nonfinite confidence and missing frame IDs do not support confirmation', () => {
  const invalid = [44, NaN, Infinity, -Infinity, 101, '95'].map((confidence, index) => ({
    plate: '36C-925.64', confidence, frameId: index
  }));
  assert.equal(selectStableReading([
    ...invalid,
    { plate: '36C-925.64', confidence: 99 },
    { plate: '36C-925.64', confidence: 99, frameId: '' },
    { plate: '36C-925.64', confidence: 60, frameId: 20 }
  ]), null);
});

test('ranks stable plates by frame agreement then supporting confidence deterministically', () => {
  const readings = [
    { plate: '36C-925.64', confidence: 70, frameId: 1 },
    { plate: '36C-925.64', confidence: 70, frameId: 2 },
    { plate: '36C-925.64', confidence: 70, frameId: 3 },
    { plate: '59F1-123.45', confidence: 99, frameId: 1 },
    { plate: '59F1-123.45', confidence: 99, frameId: 2 }
  ];
  assert.equal(selectStableReading(readings).plate, '36C-925.64');
  assert.equal(selectStableReading(readings.slice(1)).plate, '59F1-123.45');
});

test('supports explicit confirmation thresholds and rejects invalid settings', () => {
  const readings = [
    { plate: '36C-925.64', confidence: 55, frameId: 1 },
    { plate: '36C-925.64', confidence: 65, frameId: 2 }
  ];
  assert.equal(selectStableReading(readings, { minFrames: 3 }), null);
  assert.equal(selectStableReading(readings, { minConfidence: 60 }), null);
  assert.deepEqual(selectStableReading(readings, { minFrames: 1, minConfidence: 60 }), {
    plate: '36C-925.64', confidence: 65, frameCount: 1
  });
  assert.throws(() => selectStableReading([], { minFrames: 0 }), RangeError);
  assert.throws(() => selectStableReading([], { minConfidence: NaN }), RangeError);
});

test('browser global and both served helper copies expose identical behavior', () => {
  const publicPath = path.join(__dirname, '..', 'public', 'alpr-utils.js');
  const mirroredPath = path.join(__dirname, '..', 'web_server', 'public', 'alpr-utils.js');
  const source = fs.readFileSync(publicPath, 'utf8');
  assert.equal(fs.readFileSync(mirroredPath, 'utf8'), source);
  const context = vm.createContext({});
  vm.runInContext(source, context);
  assert.equal(context.ParkingAlpr.cleanAndFormatPlate('59F1\n123.45'), '59F1-123.45');
});
