#include <Arduino.h>

// Diagnostic sketch for checking the five LM393 IR sensor outputs.
// Upload this sketch, open Serial Monitor at 115200 baud, and test one sensor
// at a time by moving a model car/object in front of it.

constexpr uint8_t PIN_P1_SENSOR = 32;
constexpr uint8_t PIN_P2_SENSOR = 33;
constexpr uint8_t PIN_P3_SENSOR = 34;
constexpr uint8_t PIN_ENTRY_SENSOR = 35;
constexpr uint8_t PIN_EXIT_SENSOR = 36;
constexpr bool IR_ACTIVE_LOW = true; // Change after observing your modules.
constexpr uint32_t REPORT_INTERVAL_MS = 250;

const uint8_t SENSOR_PINS[] = {
  PIN_P1_SENSOR, PIN_P2_SENSOR, PIN_P3_SENSOR,
  PIN_ENTRY_SENSOR, PIN_EXIT_SENSOR
};
const char *SENSOR_NAMES[] = {"P1", "P2", "P3", "ENTRY", "EXIT"};
constexpr uint8_t SENSOR_COUNT = sizeof(SENSOR_PINS) / sizeof(SENSOR_PINS[0]);

uint32_t lastReportAt = 0;

void setup() {
  Serial.begin(115200);
  for (uint8_t i = 0; i < SENSOR_COUNT; ++i) {
    // GPIO34/35/36 are input-only and do not have internal pull resistors.
    pinMode(SENSOR_PINS[i], INPUT);
  }
  Serial.println(F("IR sensor check: raw level and detected state (1=detected)"));
  Serial.println(F("Test each sensor and note whether its raw output is LOW or HIGH."));
}

void loop() {
  const uint32_t now = millis();
  if (now - lastReportAt < REPORT_INTERVAL_MS) return;
  lastReportAt = now;

  for (uint8_t i = 0; i < SENSOR_COUNT; ++i) {
    const int raw = digitalRead(SENSOR_PINS[i]);
    const bool detected = IR_ACTIVE_LOW ? (raw == LOW) : (raw == HIGH);
    Serial.print(SENSOR_NAMES[i]);
    Serial.print(F(" GPIO"));
    Serial.print(SENSOR_PINS[i]);
    Serial.print(F(" raw="));
    Serial.print(raw == LOW ? F("LOW") : F("HIGH"));
    Serial.print(F(" detected="));
    Serial.print(detected ? F("YES") : F("no"));
    if (i + 1 < SENSOR_COUNT) Serial.print(F(" | "));
  }
  Serial.println();
}
