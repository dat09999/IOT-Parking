(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.ParkingAlpr = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Match complete plate tokens. In particular, do not turn a longer serial
  // into a shorter valid plate by discarding its final digit.
  const boundaryBefore = '(^|[^A-Z0-9])';
  const boundaryAfter = '(?![A-Z0-9]|\\.[0-9])';
  const provinceGap = '[ \\t.-]*';
  const serial = '([0-9]{3}[ \\t.]?[0-9]{2}|[0-9]{4})';
  const patterns = [
    // Motorcycle series include a digit, e.g. 59F1 / 123.45. A separator
    // distinguishes a four-digit motorcycle serial from a five-digit car one.
    new RegExp(boundaryBefore + '([0-9]{2})' + provinceGap +
      '([A-Z][0-9])[ \\t.\\-\\r\\n]+' + serial + boundaryAfter, 'g'),
    new RegExp(boundaryBefore + '([0-9]{2})' + provinceGap +
      '([A-Z]{1,2})[ \\t.\\-\\r\\n]*' + serial + boundaryAfter, 'g'),
    // A compact single-letter token with six following digits has one series
    // digit plus a complete five-digit serial, e.g. 59F112345.
    new RegExp(boundaryBefore + '([0-9]{2})' + provinceGap +
      '([A-Z][0-9])([0-9]{5})' + boundaryAfter, 'g')
  ];

  function formatPlate(province, series, serialText) {
    const number = serialText.replace(/[^0-9]/g, '');
    const formatted = number.length === 5
      ? number.slice(0, 3) + '.' + number.slice(3)
      : number;
    return province + series + '-' + formatted;
  }

  function extractPlateCandidates(rawText) {
    if (typeof rawText !== 'string' || !rawText.trim()) return [];
    const text = rawText.toUpperCase()
      .replace(/[\u2010-\u2015\u2212]/g, '-')
      .replace(/\u00a0/g, ' ');
    const matches = [];
    patterns.forEach(function (pattern, priority) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(text)) !== null) {
        matches.push({
          plate: formatPlate(match[2], match[3], match[4]),
          index: match.index + match[1].length,
          priority: priority
        });
      }
    });
    matches.sort(function (a, b) {
      return a.index - b.index || a.priority - b.priority;
    });
    return Array.from(new Set(matches.map(function (match) { return match.plate; })));
  }

  function cleanAndFormatPlate(rawText) {
    return extractPlateCandidates(rawText)[0] || null;
  }

  function selectStableReading(readings, options) {
    const settings = options || {};
    const minFrames = settings.minFrames === undefined ? 2 : settings.minFrames;
    const minConfidence = settings.minConfidence === undefined ? 45 : settings.minConfidence;
    if (!Number.isInteger(minFrames) || minFrames < 1) {
      throw new RangeError('minFrames must be a positive integer');
    }
    if (!Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 100) {
      throw new RangeError('minConfidence must be between 0 and 100');
    }
    if (!Array.isArray(readings)) return null;

    const groups = new Map();
    readings.forEach(function (reading) {
      if (!reading || typeof reading.confidence !== 'number' ||
          !Number.isFinite(reading.confidence) || reading.confidence < minConfidence ||
          reading.confidence > 100) return;
      const frameId = reading.frameId;
      if ((typeof frameId !== 'number' && typeof frameId !== 'string') ||
          (typeof frameId === 'number' && !Number.isFinite(frameId)) ||
          String(frameId).trim() === '') return;
      const plate = cleanAndFormatPlate(reading.plate);
      if (!plate) return;
      if (!groups.has(plate)) groups.set(plate, new Map());
      const frames = groups.get(plate);
      const key = String(frameId);
      const previous = frames.get(key);
      if (previous === undefined || reading.confidence > previous) {
        frames.set(key, reading.confidence);
      }
    });

    const stable = [];
    groups.forEach(function (frames, plate) {
      if (frames.size < minFrames) return;
      const confidence = Array.from(frames.values()).reduce(function (sum, value) {
        return sum + value;
      }, 0) / frames.size;
      stable.push({ plate: plate, confidence: confidence, frameCount: frames.size });
    });
    stable.sort(function (a, b) {
      return b.frameCount - a.frameCount || b.confidence - a.confidence ||
        (a.plate < b.plate ? -1 : a.plate > b.plate ? 1 : 0);
    });
    return stable[0] || null;
  }

  return Object.freeze({
    cleanAndFormatPlate: cleanAndFormatPlate,
    extractPlateCandidates: extractPlateCandidates,
    selectStableReading: selectStableReading
  });
});
